/**
 * Per-teammate LLM route choices for the public dsh-team-model-policy plugin.
 *
 * Choices are plugin-owned host state, never Session history: they live in the
 * public `ctx.storageDomain` KV form under one domain, keyed by the exact Team
 * root id and model-facing teammate name. Nothing here writes `model/selection`,
 * `request/header`, `team/member`, or any native Session file.
 *
 * DSH packages are resolved through the installation manifest the host exposes
 * as `ctx.profileContext.installAnchor`, so a profile-local plugin reuses the
 * runtime's own copies instead of adding duplicate core peers.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Stable failure codes; callers branch on `error.code`. */
export const ChoicesErrorCode = Object.freeze({
  INVALID_ROUTE: 'CHOICES_INVALID_ROUTE',
  NO_POLICY: 'CHOICES_NO_POLICY',
  ROUTE_NOT_ALLOWED: 'CHOICES_ROUTE_NOT_ALLOWED',
  CLOSED: 'CHOICES_CLOSED',
  UNSUPPORTED_HOST: 'CHOICES_UNSUPPORTED_HOST',
})

/** Typed refusal of a choice read, write, or authorization attempt. */
export class ChoicesError extends Error {
  /**
   * @param message - actionable detail.
   * @param code - one of {@link ChoicesErrorCode}.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ChoicesError'
    this.code = code
  }
}

/** Domain name owned by this plugin; also the storage medium's unit name. */
export const CHOICES_DOMAIN = 'team_model_choices'

/**
 * Load the host's own storage-domain and zod packages.
 *
 * Resolution starts at the installation manifest because a profile-installed
 * plugin has no direct dependency on the harness core, while the running host
 * has already installed exactly one compatible copy of each package.
 * @param anchor - absolute installation `package.json` path from `ctx.profileContext`.
 * @returns the public domain vocabulary and record schema builder.
 */
export async function loadHostSchema(anchor) {
  if (typeof anchor !== 'string' || anchor.length === 0) {
    throw new ChoicesError('The host exposed no installation anchor for teammate choices.', ChoicesErrorCode.UNSUPPORTED_HOST)
  }
  const require = createRequire(anchor)
  const { defineDomain, domainTable } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const { z } = await import(pathToFileURL(require.resolve('zod')).href)
  const record = z.object({
    teamId: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }).strict()
  return { defineDomain, domainTable, record }
}

/**
 * Build this plugin's storage domain from the host's schema builder.
 * @param schema - result of {@link loadHostSchema}.
 * @returns the declared domain spec.
 */
export function choicesDomainOf(schema) {
  return schema.defineDomain({
    name: CHOICES_DOMAIN,
    version: 1,
    tables: { choices: schema.domainTable(schema.record) },
  })
}

/** Composite durable key; the separator cannot occur in a Session id or teammate name. */
function choiceKey(teamId, name) {
  return teamId + '\u0000' + name
}

/** Snapshot one record as detached data, preserving an absent effort as absent. */
function detach(record) {
  if (record === undefined) return undefined
  return {
    provider: record.provider,
    model: record.model,
    ...record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort },
  }
}

/** Reject a malformed route at its JSON boundary before any state changes. */
export function normalizedRoute(route) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    throw new ChoicesError('A teammate route must be an object with provider and model.', ChoicesErrorCode.INVALID_ROUTE)
  }
  for (const key of Object.keys(route)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new ChoicesError('A teammate route accepts only provider, model, and reasoningEffort.', ChoicesErrorCode.INVALID_ROUTE)
    }
  }
  const { provider, model, reasoningEffort } = route
  if (typeof provider !== 'string' || provider.length === 0 || provider.trim() !== provider) {
    throw new ChoicesError('provider must be a non-empty id without surrounding whitespace.', ChoicesErrorCode.INVALID_ROUTE)
  }
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model) {
    throw new ChoicesError('model must be a non-empty id without surrounding whitespace.', ChoicesErrorCode.INVALID_ROUTE)
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
    throw new ChoicesError('reasoningEffort must be a non-empty id when supplied.', ChoicesErrorCode.INVALID_ROUTE)
  }
  return Object.freeze({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  })
}

/** Assert one non-empty identity part (Team root id or teammate name). */
function identity(teamId, name) {
  if (typeof teamId !== 'string' || teamId.length === 0 || typeof name !== 'string' || name.length === 0) {
    throw new ChoicesError('A teammate choice requires a Team root id and teammate name.', ChoicesErrorCode.INVALID_ROUTE)
  }
}

/** Read this Session's own events, excluding inherited parent history. */
function ownEvents(session) {
  if (session === null || typeof session !== 'object' || typeof session.snapshotEvents !== 'function') {
    throw new ChoicesError('Authorizing a teammate route requires the Session that will send the request.', ChoicesErrorCode.NO_POLICY)
  }
  const from = session.inheritedEventCount ?? 0
  return [...session.snapshotEvents(from)]
}

/**
 * Read the exact routes the Session's user authorized for explicit child selection.
 * @param session - the Session whose durable decision applies.
 * @returns detached routes, or undefined when no policy was recorded.
 */
export function allowedRoutes(session) {
  let latest
  for (const event of ownEvents(session)) {
    if (event.type === 'subagent/model-selection-policy') latest = event
  }
  if (latest === undefined) return undefined
  const routes = latest.data === null ? undefined : latest.data.allowedModels
  if (!Array.isArray(routes)) {
    throw new ChoicesError('The recorded model-selection policy has no route list.', ChoicesErrorCode.NO_POLICY)
  }
  return routes.map(route => ({ provider: route.provider, model: route.model }))
}

/**
 * Enforce the Session's allowlist before a choice may be recorded or used.
 *
 * Provider and model are one route and must arrive together; reasoning effort
 * is not part of the allowlist because the LLM adapter owns effort resolution
 * and the caller preflights it with `llm.resolveCallConfig`.
 * @param session - the Session whose durable decision applies.
 * @param route - candidate provider, model, and optional reasoningEffort.
 * @returns the frozen normalized route.
 */
export function authorize(session, route) {
  const choice = normalizedRoute(route)
  const routes = allowedRoutes(session)
  if (routes === undefined) {
    throw new ChoicesError(
      'This Session recorded no model-selection policy; explicit teammate model choices require the subagent model-selection setting.',
      ChoicesErrorCode.NO_POLICY,
    )
  }
  if (!routes.some(candidate => candidate.provider === choice.provider && candidate.model === choice.model)) {
    throw new ChoicesError(
      `Route "${choice.provider}/${choice.model}" is not allowed for this Session.`,
      ChoicesErrorCode.ROUTE_NOT_ALLOWED,
    )
  }
  return choice
}

/**
 * Load the host's domain vocabulary plus its record schema builder for tests and
 * callers that inject nothing.
 * @param schema - host-supplied `{ defineDomain, domainTable, z }`.
 * @returns the injected schema.
 */
function injectedSchema(schema) {
  if (schema === null || typeof schema !== 'object'
    || typeof schema.defineDomain !== 'function' || typeof schema.domainTable !== 'function'
    || schema.z === undefined || typeof schema.z.object !== 'function') {
    throw new ChoicesError('An injected host schema needs defineDomain, domainTable, and z.', ChoicesErrorCode.UNSUPPORTED_HOST)
  }
  return schema
}

/**
 * Open the choice store over the host's domain KV.
 *
 * Saves are serialized on one chain so concurrent writes never reorder or lose
 * an update, `save` resolves only after durability, and `close` rejects later
 * writes while draining everything already queued. A failed write rejects and
 * leaves the previous record in place.
 * The host may inject its own domain vocabulary (`options.schema`, or a
 * prebuilt `options.domainSpec`); without it the plugin loads the same public
 * packages from `ctx.profileContext.installAnchor`. Neither path adds a new
 * installation, and a host offering neither fails loud.
 * @param ctx - host Context carrying `storageDomain` and `profileContext`.
 * @param options - optional injected `schema` or `domainSpec` from the host.
 * @returns the store handles.
 */
export async function createChoices(ctx, options) {
  const schema = options?.schema === undefined ? undefined : injectedSchema(options.schema)
  const domainSpec = options?.domainSpec ?? choicesDomainOf(schema ?? await loadHostSchema(ctx.profileContext?.installAnchor))
  const facility = ctx.storageDomain ?? ctx.storage?.domain
  if (facility === undefined || typeof facility.open !== 'function') {
    throw new ChoicesError('The host exposed no storage domain for teammate choices.', ChoicesErrorCode.UNSUPPORTED_HOST)
  }
  const domain = await facility.open(domainSpec)
  const table = domain.table('choices')
  /** Refuses new loads and saves once close begins. */
  let closing = false
  /** Set when close begins, so jobs already queued fail before touching the medium. */
  let closingDomain
  let chain = Promise.resolve()
  let closingStore

  /** Queue one job behind every earlier job on this store's write chain. */
  const enqueue = (job) => {
    const next = chain.then(job)
    // Chain links settle either way so one rejected save never blocks later ones.
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    /**
     * Read one teammate's recorded choice.
     * @param teamId - exact Team root Session id.
     * @param name - model-facing teammate name.
     * @returns detached route, or undefined when this teammate has no choice.
     */
    load(teamId, name) {
      if (closing) throw new ChoicesError('The teammate choice store is closing.', ChoicesErrorCode.CLOSED)
      identity(teamId, name)
      return detach(table.get(choiceKey(teamId, name)))
    },

    /**
     * Record one teammate's authorized choice durably.
     * @param teamId - exact Team root Session id.
     * @param name - model-facing teammate name.
     * @param route - candidate route; the caller authorizes it first.
     * @returns the frozen stored route after durability.
     */
    save(teamId, name, route) {
      if (closing) {
        return Promise.reject(new ChoicesError('The teammate choice store is closing.', ChoicesErrorCode.CLOSED))
      }
      let record
      try {
        identity(teamId, name)
        // Validate before queueing: an invalid route never reaches the chain or the medium.
        record = Object.freeze({ teamId, name, ...normalizedRoute(route) })
      } catch (error) {
        return Promise.reject(error)
      }
      // Job admission already happened at call time: every save accepted here
      // lands before close's drain, and only calls made after close began refuse.
      return enqueue(async () => {
        await table.put(choiceKey(teamId, name), record)
        return detach(record)
      })
    },

    /**
     * Drain queued writes and release the domain. Idempotent; later writes reject.
     * @returns after the domain is closed.
     */
    close() {
      if (closingStore !== undefined) return closingStore
      closing = true
      closingDomain = domain
      closingStore = chain.then(() => domain.close())
      return closingStore
    },
  }
}
