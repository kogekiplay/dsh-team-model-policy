/**
 * Executable checks for the Team model policy card.
 *
 * The suite loads the shipped `lib/client.js` exactly as the Desktop client
 * does — through `window.__ModuleLoader__.load` with a `require` limited to the
 * client baseline — mounts the registered component with real `react-dom` into
 * a fake DOM, and drives it through a fake host: a settings form with
 * revisions, a model catalog, and the renderer's inject-hooks binding.
 *
 * Run: `node --test src/client/test/ui.test.cjs`. react and react-dom are read
 * from `DSH_UI_TEST_MODULES` (default: a sibling development checkout) because
 * this package ships no runtime dependencies.
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

/** Directory holding react and react-dom for this run. */
const MODULES = process.env.DSH_UI_TEST_MODULES === undefined
  ? '/Users/kogeki/dev/tv-display-manager/node_modules'
  : process.env.DSH_UI_TEST_MODULES

const { mount, fire, React } = require('./renderer.cjs')
const { loadBundle, bindFace, slotService } = require('./runtime.cjs')
const { en, zh } = require('../locale.cjs')

/** Host-side applications a successful write queues, applied by the test. */
const whenWrites = []

/** Wait for queued microtasks and React's async commit to settle. */
async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Run a synchronous React update with act semantics and let effects settle.
 * @param {() => unknown} body - the update to perform.
 */
async function act(body) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    return body()
  } finally {
    await flush()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
}

/**
 * A settings form scope with revisions and fenced mutations, recording every write.
 * @param {object} [initial] - first snapshot fields.
 * @returns The scope plus its write log and Host-side helpers.
 */
function settingsScope(initial) {
  const start = initial === undefined ? {} : initial
  const state = {
    status: start.status === undefined ? 'ready' : start.status,
    value: start.value,
    base: start.base,
    user: start.user,
    revision: start.revision === undefined ? 7 : start.revision,
    writable: start.writable === undefined ? true : start.writable,
  }
  const writes = []
  let rejectNext = false
  let snapshot = { ...state }
  const listeners = new Set()
  const publish = () => {
    snapshot = { ...state }
    for (const listener of [...listeners]) listener()
  }
  return {
    writes,
    state,
    rejectNextWrite: () => { rejectNext = true },
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops, revision) => {
      writes.push({ ops, revision })
      if (rejectNext) {
        rejectNext = false
        throw new Error('transport down')
      }
      whenWrites.push(() => {
        const next = { ...(state.value === undefined ? {} : state.value) }
        const user = { ...(state.user === undefined ? {} : state.user) }
        for (const op of ops) {
          const field = op.path[0]
          if (op.op === 'set') {
            next[field] = op.value
            user[field] = op.value
          } else {
            delete next[field]
            delete user[field]
          }
        }
        state.value = next
        state.user = user
        state.revision += 1
        publish()
      })
      return true
    },
  }
}

/** A two-provider catalog with reasoning metadata on one route. */
function catalog() {
  return {
    groups: [
      {
        id: 'kurumiai',
        name: 'kurumiai',
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'deepseek-v4.1-flash',
            reasoning: {
              efforts: [
                { id: 'off', name: 'off' },
                { id: 'low', name: 'low' },
                { id: 'medium', name: 'medium' },
                { id: 'high', name: 'high' },
                { id: 'max', name: 'max' },
              ],
              defaultEffort: 'off',
            },
          },
          { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
        ],
      },
      { id: 'kennedy', name: 'kennedy', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] },
    ],
    failures: [],
  }
}

/**
 * Boot the bundle against fake services and mount the registered card.
 * @param {object} [options] - `settings` snapshot fields and `catalogFails`.
 * @returns Handles for the mounted card, its host, and its registration.
 */
async function mountCard(options) {
  const settings = settingsScope(options === undefined ? undefined : options.settings)
  const locals = { active: 'en', revision: 1 }
  const localeListeners = new Set()
  const locale = {
    register: () => () => {},
    getSnapshot: () => ({ active: locals.active, revision: locals.revision }),
    subscribe: listener => {
      localeListeners.add(listener)
      return () => { localeListeners.delete(listener) }
    },
    switchTo: next => {
      locals.active = next
      locals.revision += 1
      for (const listener of [...localeListeners]) listener()
    },
  }
  let catalogFails = options !== undefined && options.catalogFails === true
  const catalogCalls = []
  const remote = {
    session: {
      modelCatalog: async () => {
        catalogCalls.push(Date.now())
        if (catalogFails) return { ok: false, error: { message: 'nope' } }
        return { ok: true, value: catalog() }
      },
    },
    $on: () => () => {},
  }
  const ctx = {
    slots: undefined,
    locale,
    remote,
    configForms: {
      get: namespace => {
        assert.equal(namespace, 'team-model-policy')
        return settings
      },
      whileServed: (namespaces, register) => {
        assert.deepEqual(namespaces, ['team-model-policy'])
        return register(new Set(namespaces))
      },
    },
    effect: body => body(),
    on: () => () => {},
  }
  const slots = slotService()
  ctx.slots = slots.service

  const plugin = loadBundle({
    modules: {
      react: require(path.join(MODULES, 'react')),
      'react-dom': require(path.join(MODULES, 'react-dom')),
      '@deepseek-ai/cordis': {},
      '@deepseek-ai/dsh-client-store': {},
      '@deepseek-ai/dsh-client-ui-slots': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    },
  })()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  plugin.apply(ctx)
  assert.equal(slots.registrations.length, 1)
  const registration = slots.registrations[0]
  assert.equal(registration.options.name, 'plugins.item')
  assert.equal(registration.options.id, 'team-model-policy')
  assert.equal(registration.options.order, 40)
  assert.equal(registration.options.locale, 'settings.teamModelPolicy')
  assert.equal(registration.options.label(), 'Team model')

  /** Latest inject face, rebuilt the way the renderer does on every render. */
  let face = registration.options.inject()
  let dom
  let first = true
  const render = async nextView => {
    face = registration.options.inject()
    const element = React.createElement(registration.component, { ...bindFace(face), ...nextView })
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    if (first) {
      dom = mount(element)
      first = false
    } else {
      dom.rerender(element)
    }
    await flush()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    return dom
  }
  const page = await render({ view: 'page' })
  return {
    settings,
    locale,
    catalogCalls,
    registration,
    state: () => face.hooks.teamModelPolicyCard.getState(),
    dom: page,
    render,
    setCatalogFails: next => { catalogFails = next },
    unmount: async () => {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
      page.unmount()
      await flush()
      globalThis.IS_REACT_ACT_ENVIRONMENT = false
    },
  }
}

/** Apply host-side writes queued by successful saves, then settle renders. */
async function settleSave() {
  await flush()
  while (whenWrites.length > 0) whenWrites.shift()()
  await flush()
}

/** The save control. */
function saveButton(dom) {
  return dom.all(node => node.nodeName === 'BUTTON' && node.attributes.get('data-save') === 'team-model-policy')[0]
}

/**
 * The radio input for one mode. React writes `value` as a DOM property, so the
 * control is found by its position: follow first, fixed second.
 */
function radio(dom, mode) {
  const inputs = dom.all(node => node.nodeName === 'INPUT')
  return mode === 'fixed' ? inputs[1] : inputs[0]
}

/** The select control carrying `id`; React writes `id` as a DOM property. */
function select(dom, id) {
  return dom.all(node => node.nodeName === 'SELECT' && (node.id === id || node.attributes.get('id') === id))[0]
}

/** The option values a select offers. */
function optionValues(dom, id) {
  const control = select(dom, id)
  assert.notEqual(control, undefined, 'select ' + id + ' renders')
  return control.childNodes.filter(node => node.nodeName === 'OPTION').map(node => node.value)
}

test('registers one plugins.item card with a localized title and summary', async () => {
  const card = await mountCard()
  await card.render({ view: 'summary' })
  await flush()
  assert.equal(card.dom.text(), en.summary)
  await card.render({ view: 'page' })
  await flush()
  assert.ok(card.dom.text().includes(en.modeFollow))
  card.locale.switchTo('zh')
  assert.equal(card.registration.options.label(), zh.navTitle)
  await card.unmount()
})

test('defaults to follow mode and shows max as the default reasoning effort', async () => {
  const card = await mountCard({ settings: { value: {}, user: {} } })
  const state = card.state()
  assert.equal(state.mode, 'follow-subagent')
  assert.equal(state.defaultEffort, 'max')
  const body = card.dom.text()
  assert.ok(body.includes(en.modeFollowHint))
  assert.ok(body.includes(en.defaultEffortHint.replace('{effort}', 'max')))
  assert.ok(!body.includes(en.modeFixedHint))
  assert.equal(radio(card.dom, 'follow-subagent').checked, true)
  assert.equal(radio(card.dom, 'fixed').checked, false)
  assert.equal(saveButton(card.dom).disabled, true)
  await card.unmount()
})

test('a configured default reasoning effort changes the follow-mode text', async () => {
  const card = await mountCard({ settings: { value: { defaultReasoningEffort: 'high' }, user: {} } })
  assert.equal(card.state().defaultEffort, 'high')
  assert.ok(card.dom.text().includes(en.defaultEffortHint.replace('{effort}', 'high')))
  await card.unmount()
})

test('fixed mode requires a provider and model, then saves one fenced mutation', async () => {
  const card = await mountCard({ settings: { value: {}, user: {} } })
  fire(radio(card.dom, 'fixed'), 'click')
  await act(() => { fire(radio(card.dom, 'fixed'), 'click') })
  await flush()
  let state = card.state()
  assert.equal(state.mode, 'fixed')
  assert.equal(state.required, en.requiredProvider)
  assert.equal(saveButton(card.dom).disabled, true)
  assert.ok(card.dom.text().includes(en.modeFixedHint))

  await act(() => { fire(select(card.dom, 'team-model-policy-provider'), 'change', { target: { value: 'kurumiai' } }) })
  await flush()
  state = card.state()
  assert.equal(state.provider.text, 'kurumiai')
  assert.equal(state.required, en.requiredModel)
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-model').slice(1), ['deepseek-v4.1-flash', 'gpt-6.1-sol'])
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-effort'), [''])

  await act(() => { fire(select(card.dom, 'team-model-policy-model'), 'change', { target: { value: 'deepseek-v4.1-flash' } }) })
  await flush()
  state = card.state()
  assert.equal(state.required, undefined)
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-effort'), ['', 'off', 'low', 'medium', 'high', 'max'])

  await act(() => { fire(select(card.dom, 'team-model-policy-effort'), 'change', { target: { value: 'high' } }) })
  await flush()
  await act(() => { fire(saveButton(card.dom), 'click') })
  await settleSave()
  assert.equal(card.settings.writes.length, 1)
  assert.equal(card.settings.writes[0].revision, 7)
  assert.deepEqual(card.settings.writes[0].ops, [
    { op: 'set', path: ['mode'], value: 'fixed' },
    { op: 'set', path: ['provider'], value: 'kurumiai' },
    { op: 'set', path: ['model'], value: 'deepseek-v4.1-flash' },
    { op: 'set', path: ['reasoningEffort'], value: 'high' },
  ])
  state = card.state()
  assert.equal(state.dirty, false)
  assert.equal(state.saving, false)
  assert.equal(state.failed, false)
  await card.unmount()
})

test('a model without reasoning metadata offers only the model default', async () => {
  const card = await mountCard({ settings: { value: { mode: 'fixed', provider: 'kennedy', model: 'glm-5.3' }, user: {} } })
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-effort'), [''])
  assert.equal(card.state().effort.choices.length, 0)
  await card.unmount()
})

test('clearing the reasoning effort writes an unset so the model default applies', async () => {
  const card = await mountCard({
    settings: { value: { mode: 'fixed', provider: 'kurumiai', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, user: {} },
  })
  assert.equal(card.state().effort.text, 'high')
  await act(() => { fire(select(card.dom, 'team-model-policy-effort'), 'change', { target: { value: '' } }) })
  await flush()
  await act(() => { fire(saveButton(card.dom), 'click') })
  await settleSave()
  assert.deepEqual(card.settings.writes[0].ops, [{ op: 'unset', path: ['reasoningEffort'] }])
  await card.unmount()
})

test('a stored route the catalog no longer lists stays visible and removable', async () => {
  const card = await mountCard({
    settings: { value: { mode: 'fixed', provider: 'retired', model: 'old-model' }, user: { provider: 'retired', model: 'old-model' } },
  })
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-provider').slice(1), ['kurumiai', 'kennedy', 'retired'])
  assert.deepEqual(optionValues(card.dom, 'team-model-policy-model').slice(1), ['old-model'])
  await act(() => { fire(card.dom.all(node => node.nodeName === 'BUTTON' && node.attributes.get('data-reset') === 'provider')[0], 'click') })
  await flush()
  await act(() => { fire(saveButton(card.dom), 'click') })
  await settleSave()
  assert.deepEqual(card.settings.writes[0].ops, [{ op: 'unset', path: ['provider'] }])
  await card.unmount()
})

test('a rejected transport write keeps the drafts and shows the failure', async () => {
  const card = await mountCard({ settings: { value: { mode: 'follow-subagent' }, user: {} } })
  card.settings.rejectNextWrite()
  await act(() => { fire(radio(card.dom, 'fixed'), 'click') })
  await flush()
  await act(() => { fire(select(card.dom, 'team-model-policy-provider'), 'change', { target: { value: 'kurumiai' } }) })
  await act(() => { fire(select(card.dom, 'team-model-policy-model'), 'change', { target: { value: 'gpt-6.1-sol' } }) })
  await flush()
  await act(() => { fire(saveButton(card.dom), 'click') })
  await settleSave()
  const state = card.state()
  assert.equal(state.failed, true)
  assert.equal(state.dirty, true)
  assert.equal(state.mode, 'fixed')
  assert.equal(state.provider.text, 'kurumiai')
  assert.ok(card.dom.text().includes(en.saveFailed))
  await card.unmount()
})

test('a missing namespace renders the unavailable notice and no controls', async () => {
  const card = await mountCard({ settings: { status: 'unavailable' } })
  assert.equal(card.state().available, false)
  assert.equal(card.dom.text(), en.unavailable)
  assert.equal(saveButton(card.dom), undefined)
  await card.unmount()
})

test('a read-only document disables every control', async () => {
  const card = await mountCard({ settings: { value: {}, user: {}, writable: false } })
  assert.ok(card.dom.text().includes(en.readOnly))
  assert.equal(saveButton(card.dom).disabled, true)
  assert.equal(radio(card.dom, 'follow-subagent').disabled, true)
  assert.equal(radio(card.dom, 'fixed').disabled, true)
  await card.unmount()
})

test('a failed catalog load shows the error with a retry that asks again', async () => {
  const card = await mountCard({
    settings: { value: { mode: 'fixed', provider: 'kurumiai', model: 'gpt-6.1-sol' }, user: {} },
    catalogFails: true,
  })
  assert.equal(card.state().catalogStatus, 'error')
  assert.ok(card.dom.text().includes(en.loadFailed))
  const retry = card.dom.all(node => node.nodeName === 'BUTTON' && node.textContent === en.retry)[0]
  const before = card.catalogCalls.length
  card.setCatalogFails(false)
  await act(() => { fire(retry, 'click') })
  await flush()
  assert.ok(card.catalogCalls.length > before)
  assert.equal(card.state().catalogStatus, 'ready')
  await card.unmount()
})

test('discarding drops staged edits without writing', async () => {
  const card = await mountCard({ settings: { value: { mode: 'follow-subagent' }, user: {} } })
  await act(() => { fire(radio(card.dom, 'fixed'), 'click') })
  await flush()
  assert.equal(card.state().dirty, true)
  const discard = card.dom.all(node => node.nodeName === 'BUTTON' && node.textContent === en.discard)[0]
  await act(() => { fire(discard, 'click') })
  await flush()
  const state = card.state()
  assert.equal(state.dirty, false)
  assert.equal(state.mode, 'follow-subagent')
  assert.equal(card.settings.writes.length, 0)
  await card.unmount()
})
