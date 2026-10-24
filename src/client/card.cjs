/**
 * Pure state and actions behind the Team model policy card.
 *
 * The card stages two preferences over the Host's `team-model-policy` settings
 * namespace and writes them with one revision-fenced mutation:
 * - `mode`: `follow-subagent` (default) or `fixed`;
 * - `provider`/`model`/`reasoningEffort`: the fixed route, each cleared when empty
 *   so the field inherits its composition layer.
 *
 * Nothing here is read from a running Host: every input is the ConfigForm scope,
 * the adapter catalog, and the locale dictionary, which keeps the module usable
 * from a browser bundle (through the module table) and from Node (tests).
 *
 * Module format: the browser loads `lib/client.js` as a CommonJS factory, so this
 * file exports through `module.exports` and carries no ESM syntax.
 */

'use strict'

/** Settings namespace owned by the Host half of this package. */
const NAMESPACE = 'team-model-policy'

/** The two route preferences the card offers. */
const MODE_FOLLOW = 'follow-subagent'
const MODE_FIXED = 'fixed'

/** Fields this card writes. */
const FIELDS = ['mode', 'provider', 'model', 'reasoningEffort', 'defaultReasoningEffort']

/** Follow-mode effort applied when the Host stores none; the deployment default forbids off. */
const DEFAULT_FOLLOW_EFFORT = 'max'

/**
 * Read the stored mode, treating anything but `fixed` as the follow default so a
 * missing or hand-edited value never hides the route fields behind a mode nobody chose.
 */
function readMode(value) {
  return value === MODE_FIXED ? MODE_FIXED : MODE_FOLLOW
}

/**
 * Read the follow-mode default reasoning effort. Anything but a non-empty string
 * falls back to `max`, the one value this deployment guarantees and never `off`.
 */
function readDefaultEffort(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_FOLLOW_EFFORT
}

/** Render a stored string as draft text; anything else is empty. */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** One provider entry from the adapter catalog joined with this card's stored route. */
function providerChoices(groups, storedProvider) {
  const choices = groups.map(group => ({ id: group.id, name: group.name }))
  if (storedProvider !== '' && !choices.some(choice => choice.id === storedProvider)) {
    choices.push({ id: storedProvider, name: storedProvider })
  }
  return choices
}

/** One model entry from a provider group, keeping a stored route that the adapter no longer lists. */
function modelChoices(group, storedModel) {
  const models = group === undefined ? [] : group.models.map(model => ({
    id: model.id,
    name: model.name,
    efforts: model.reasoning === undefined ? [] : model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
    defaultEffort: model.reasoning === undefined ? undefined : model.reasoning.defaultEffort,
  }))
  if (storedModel !== '' && !models.some(model => model.id === storedModel)) {
    models.push({ id: storedModel, name: storedModel, efforts: [], defaultEffort: undefined })
  }
  return models
}

/** The selected model entry, when the catalog carries it. */
function findModel(groups, provider, model) {
  if (provider === '') return undefined
  const group = groups.find(candidate => candidate.id === provider)
  if (group === undefined) return undefined
  return group.models.find(candidate => candidate.id === model)
}

/**
 * Build the card.
 *
 * @param {object} options
 * @param {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void, mutate: (ops: object[], revision?: number) => Promise<boolean> }} options.scope
 *   The shared `configForms` form for {@link NAMESPACE}.
 * @param {(namespace: string) => ({ groups: object[] } | undefined) | Promise<({ groups: object[] } | undefined)>} options.readCatalog
 *   Reads the adapter model catalog; throws or resolves `undefined` when unavailable.
 * @param {{ subscribe?: (listener: () => void) => () => void }} [options.catalogEvents]
 *   Optional source of catalog-invalidation notifications (adapter or settings-list changes).
 * @param {(key: string) => string} options.t
 *   Translator for locale keys (see `locale.js`).
 * @param {number} [options.tick]
 *   Flush interval in milliseconds for coalescing renders (default 0 = microtask).
 * @returns The card: `{ getState, subscribe, edit, setMode, resetField, save, discard, dispose }`.
 */
function createTeamModelPolicyCard(options) {
  const { scope, readCatalog, t } = options
  const catalogEvents = options.catalogEvents
  const flushInterval = options.tick === undefined ? 0 : options.tick

  /** @type {Record<string, { text: string, clear: boolean }>} */
  let staged = {}
  /** @type {{ provider: string, model: string } | undefined} */
  let catalog = undefined
  let catalogStatus = 'idle'
  let catalogError = ''
  let saving = false
  let failed = false
  let disposed = false
  let baselineRevision = undefined
  /** Staged text that is not a value its field accepts, keyed by field. */
  let invalidFields = {}

  const listeners = new Set()
  let pending = null
  let timer = null

  const value = () => {
    const snapshot = scope.getSnapshot()
    return snapshot.value === undefined || snapshot.value === null ? {} : snapshot.value
  }

  const stored = field => {
    const snapshot = scope.getSnapshot()
    return snapshot.user !== undefined && snapshot.user !== null && Object.prototype.hasOwnProperty.call(snapshot.user, field)
  }

  const currentText = field => textOf(value()[field])

  const mode = () => readMode(value().mode)

  const draftText = field => (staged[field] === undefined ? currentText(field) : staged[field].text)

  const draftMode = () => readMode(staged.mode === undefined ? currentText('mode') : staged.mode.text)

  const clean = text => text.trim()

  /**
   * The write one field's draft stages, or `undefined` when the draft is not a
   * value the field accepts.
   */
  const writeOf = (field, entry) => {
    if (entry === undefined) return { kind: 'none' }
    if (field === 'mode') {
      const next = clean(entry.text)
      if (next !== MODE_FOLLOW && next !== MODE_FIXED) return undefined
      return { kind: 'set', value: next }
    }
    const next = clean(entry.text)
    return next === '' ? { kind: 'clear' } : { kind: 'set', value: next }
  }

  const plan = () => {
    const writes = []
    for (const field of FIELDS) {
      const entry = staged[field]
      if (entry === undefined) continue
      if (entry.clear) {
        if (stored(field)) writes.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (entry.text === currentText(field)) continue
      const write = writeOf(field, entry)
      if (write === undefined) {
        writes.push({ field, invalid: true })
      } else if (write.kind === 'clear') {
        writes.push({ field, op: { op: 'unset', path: [field] } })
      } else {
        writes.push({ field, op: { op: 'set', path: [field], value: write.value } })
      }
    }
    return writes
  }

  const missingFixedRoute = () => {
    if (draftMode() !== MODE_FIXED) return undefined
    if (clean(draftText('provider')) === '') return 'requiredProvider'
    if (clean(draftText('model')) === '') return 'requiredModel'
    return undefined
  }

  const fieldState = field => {
    const entry = staged[field]
    if (entry === undefined) {
      return { text: currentText(field), overridden: stored(field), invalid: false }
    }
    const draft = clean(entry.text)
    const write = entry.clear ? { kind: 'clear' } : writeOf(field, entry)
    return {
      text: entry.text,
      overridden: write !== undefined && write.kind === 'set',
      invalid: write === undefined || (field === 'mode' && draft === ''),
    }
  }

  /**
   * The published state. It keeps one identity until something it is derived
   * from changes: React's external-store contract compares snapshots with
   * Object.is and re-renders forever when every read builds a new object.
   */
  let published = undefined
  let publishedKey = undefined

  const state = () => {
    const scopeSnapshot = scope.getSnapshot()
    const rawGroups = catalog === undefined ? [] : catalog
    const key = [
      scopeSnapshot.status,
      scopeSnapshot.revision,
      scopeSnapshot.writable,
      scopeSnapshot.value === undefined ? '' : JSON.stringify(scopeSnapshot.value),
      scopeSnapshot.user === undefined ? '' : JSON.stringify(scopeSnapshot.user),
      JSON.stringify(staged),
      JSON.stringify(rawGroups),
      catalogStatus,
      catalogError,
      saving,
      failed,
    ].join('\u0000')
    if (published !== undefined && key === publishedKey) return published
    publishedKey = key
    published = project()
    return published
  }

  const project = () => {
    const snapshot = scope.getSnapshot()
    const writes = plan()
    const required = missingFixedRoute()
    const groups = catalog === undefined ? [] : catalog
    const provider = draftText('provider')
    const model = draftText('model')
    const group = groups.find(candidate => candidate.id === provider)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable === true,
      dirty: writes.length > 0,
      invalid: writes.some(write => write.invalid) || required !== undefined,
      saving,
      failed,
      mode: draftMode(),
      defaultEffort: readDefaultEffort(draftText('defaultReasoningEffort')),
      provider: {
        text: provider,
        overridden: (staged.provider === undefined ? stored('provider') : provider !== ''),
        choices: providerChoices(groups, provider),
      },
      model: {
        text: model,
        overridden: (staged.model === undefined ? stored('model') : model !== ''),
        choices: modelChoices(group, model),
      },
      effort: {
        text: draftText('reasoningEffort'),
        overridden: (staged.reasoningEffort === undefined ? stored('reasoningEffort') : clean(draftText('reasoningEffort')) !== ''),
        // Empty effort means "the model's own default"; the adapter's ids name the rest.
        choices: (() => {
          const selected = findModel(groups, provider, model)
          if (selected === undefined || selected.reasoning === undefined) return []
          return selected.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name }))
        })(),
      },
      catalogStatus,
      catalogError,
      required: required === undefined ? undefined : t(required),
      fields: Object.fromEntries(FIELDS.map(field => [field, fieldState(field)])),
    }
  }

  const notify = () => {
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        // One failing render must not strand the others.
        console.error('team-model-policy: subscriber failed', error)
      }
    }
  }

  const publish = () => {
    if (disposed) return
    if (pending !== null) return
    pending = flushInterval > 0
      ? setTimeout(() => { pending = null; timer = null; notify() }, flushInterval)
      : queueMicrotask(() => { pending = null; notify() })
    if (flushInterval > 0) timer = pending
  }

  const clearInvalid = () => {
    invalidFields = {}
  }

  const stage = (field, entry) => {
    if (disposed) return
    if (baselineRevision === undefined) baselineRevision = scope.getSnapshot().revision
    staged = { ...staged, [field]: entry }
    failed = false
    delete invalidFields[field]
    publish()
  }

  const edit = (field, text) => {
    if (!FIELDS.includes(field)) throw new Error('team-model-policy: unknown field ' + field)
    stage(field, { text, clear: false })
  }

  const setMode = next => {
    if (next !== MODE_FOLLOW && next !== MODE_FIXED) return
    stage('mode', { text: next, clear: false })
  }

  const resetField = field => {
    if (!FIELDS.includes(field)) throw new Error('team-model-policy: unknown field ' + field)
    stage(field, { text: currentText(field), clear: true })
  }

  const discard = () => {
    if (saving) return
    if (Object.keys(staged).length === 0 && !failed) return
    staged = {}
    baselineRevision = undefined
    failed = false
    clearInvalid()
    publish()
  }

  const runSave = async () => {
    const writes = plan()
    const required = missingFixedRoute()
    const snapshot = scope.getSnapshot()
    if (writes.length === 0 || saving || snapshot.writable !== true || required !== undefined
      || writes.some(write => write.invalid)) return false
    saving = true
    failed = false
    publish()
    let landed = false
    try {
      const ops = writes.filter(write => write.op !== undefined).map(write => write.op)
      landed = ops.length === 0 ? true : await scope.mutate(ops, baselineRevision)
      if (landed) {
        staged = {}
        baselineRevision = undefined
      }
    } catch (error) {
      // A rejected transport write is a visible failure, not a silent revert.
      landed = false
      catalogError = error instanceof Error ? error.message : String(error)
    } finally {
      saving = false
      failed = !landed
      publish()
    }
    return landed
  }

  let inFlight = null
  const save = () => {
    if (inFlight !== null) return inFlight
    inFlight = runSave().finally(() => { inFlight = null })
    return inFlight
  }

  const loadCatalog = async () => {
    if (disposed || catalogStatus === 'loading') return
    catalogStatus = 'loading'
    publish()
    try {
      const response = await readCatalog(NAMESPACE)
      if (disposed) return
      if (response !== undefined && Array.isArray(response.groups)) {
        catalog = response.groups
        catalogStatus = 'ready'
        catalogError = ''
      } else {
        catalogStatus = 'error'
        catalogError = 'catalogRejected'
      }
    } catch (error) {
      if (disposed) return
      catalogStatus = 'error'
      catalogError = error instanceof Error ? error.message : String(error)
    }
    publish()
  }

  const unsubscribeScope = scope.subscribe(() => {
    if (disposed) return
    // A newer Host revision may carry values this draft no longer edits; a
    // landed save already cleared the drafts, so anything left is a real conflict.
    if (!saving && baselineRevision !== undefined && scope.getSnapshot().revision !== baselineRevision) {
      // Keep the original revision so a concurrent change is refused on save.
    }
    publish()
  })
  const unsubscribeEvents = catalogEvents !== undefined && typeof catalogEvents.subscribe === 'function'
    ? catalogEvents.subscribe(() => {
      if (disposed) return
      catalogStatus = 'idle'
      publish()
      void loadCatalog()
    })
    : undefined

  void loadCatalog()

  return {
    namespace: NAMESPACE,
    getState: state,
    getSnapshot: state,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    edit,
    setMode,
    resetField,
    save,
    discard,
    refreshCatalog: loadCatalog,
    dispose: () => {
      disposed = true
      listeners.clear()
      unsubscribeScope()
      if (unsubscribeEvents !== undefined) unsubscribeEvents()
      if (timer !== null) clearTimeout(timer)
      pending = null
      timer = null
    },
  }
}

module.exports = {
  NAMESPACE,
  MODE_FOLLOW,
  MODE_FIXED,
  DEFAULT_FOLLOW_EFFORT,
  FIELDS,
  readMode,
  readDefaultEffort,
  createTeamModelPolicyCard,
}
