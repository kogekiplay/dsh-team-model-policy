/**
 * Tests for choices.mjs.
 *
 * The suite runs on the installed desktop runtime
 * (`ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeek Harness" --test …`)
 * so the async-import hook can load the host's own packages from the app.asar
 * archive exactly as the running host does:
 *
 * - the real storage hub, JSON backend, and storage-domain facility serve the
 *   production `ctx.storageDomain` handle;
 * - `createChoices` loads `@deepseek-ai/dsh-storage-domain` and `zod` through
 *   `createRequire(ctx.profileContext.installAnchor)`, the same anchor the host
 *   publishes, so persistence and schema validation are the real medium path.
 *
 * `node --test` without that runtime cannot read app.asar and is not supported.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createChoices, authorize, allowedRoutes, ChoicesError, ChoicesErrorCode, CHOICES_DOMAIN } from '../choices.mjs'

const DEFAULT_ANCHOR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json'
const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? DEFAULT_ANCHOR
const require = createRequire(anchor)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href)
const { DomainFacility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-domain')).href)
const { JsonStorageBackend } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)

const TEAM_A = 'e1b1f0f4-0000-4000-8000-00000000aaaa'
const TEAM_B = 'e1b1f0f4-0000-4000-8000-00000000bbbb'
const FLASH = Object.freeze({ provider: 'kurumiai', model: 'deepseek-v4.1-flash' })
const OTHER = Object.freeze({ provider: 'kennedy', model: 'deepseek-v4.1-flash' })

/**
 * Honor the desktop runtime requirement instead of passing on a weaker path.
 * @returns the runtime identifier of the executing binary.
 */
function requireAsarRuntime() {
  if (typeof process.versions.electron !== 'string') {
    throw new Error('run this suite as ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeek Harness" --test tests/choices.test.mjs')
  }
}

/**
 * Boot one host generation: storage hub, JSON backend rooted at `root`, and the
 * storage-domain facility that serves `ctx.storageDomain`, plus the anchors the
 * plugin resolves its SDK from.
 * @param root - private directory for this generation's durable medium.
 * @returns the host context and its teardown.
 */
async function host(root) {
  requireAsarRuntime()
  const ctx = new Context()
  await ctx.plugin(Storage)
  const unregister = ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const unmount = ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { installAnchor: anchor })
  return {
    ctx,
    async dispose() {
      await facility.closeAll()
      unmount()
      unregister()
      await ctx.fiber.dispose()
    },
  }
}

/** Create one private medium root per test and remove it afterwards. */
async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'team-model-choices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const INHERITED = { type: 'request/header', data: { header: { config: { provider: 'audit', model: 'lead' } } } }
const policyEvent = routes => ({ type: 'subagent/model-selection-policy', data: { allowedModels: routes } })
const sessionWith = (events, own = 1) => ({ inheritedEventCount: own, snapshotEvents: from => [INHERITED, ...events].slice(from) })

test('a recorded choice survives close, restart of the host, and reopen from disk', async t => {
  const root = await tempRoot(t)
  const first = await host(root)
  const store = await createChoices(first.ctx)
  assert.equal(store.load(TEAM_A, 'worker'), undefined)
  assert.deepEqual(await store.save(TEAM_A, 'worker', { ...FLASH, reasoningEffort: 'high' }), { ...FLASH, reasoningEffort: 'high' })
  await store.close()
  await first.dispose()

  const second = await host(root)
  const reopened = await createChoices(second.ctx)
  assert.deepEqual(reopened.load(TEAM_A, 'worker'), { ...FLASH, reasoningEffort: 'high' })
  await reopened.close()
  await second.dispose()

  // The durable unit is the declared domain, not a Session artifact.
  const entries = await readdir(root)
  const unit = entries.find(entry => entry.startsWith(CHOICES_DOMAIN))
  assert.ok(unit, 'expected a durable ' + CHOICES_DOMAIN + ' unit, saw: ' + entries.join(','))
  assert.match(await readFile(join(root, unit), 'utf8'), /deepseek-v4\.1-flash/)
})

test('different Teams and different teammate names never share a record', async t => {
  const root = await tempRoot(t)
  const h = await host(root)
  const store = await createChoices(h.ctx)
  await store.save(TEAM_A, 'worker', FLASH)
  await store.save(TEAM_A, 'auditor', OTHER)
  await store.save(TEAM_B, 'worker', { provider: 'inception', model: 'mercury-3' })
  assert.deepEqual(store.load(TEAM_A, 'worker'), { ...FLASH })
  assert.deepEqual(store.load(TEAM_A, 'auditor'), { ...OTHER })
  assert.deepEqual(store.load(TEAM_B, 'worker'), { provider: 'inception', model: 'mercury-3' })
  assert.equal(store.load(TEAM_B, 'auditor'), undefined)
  await store.save(TEAM_B, 'worker', FLASH)
  assert.deepEqual(store.load(TEAM_A, 'auditor'), { ...OTHER })
  assert.deepEqual(store.load(TEAM_B, 'worker'), { ...FLASH })
  await store.close()
  await h.dispose()
})

test('malformed routes and identities are refused before the medium is touched', async t => {
  const root = await tempRoot(t)
  const h = await host(root)
  const store = await createChoices(h.ctx)
  await store.save(TEAM_A, 'worker', FLASH)
  const before = await readdir(root)
  const invalidRoutes = [
    undefined, null, 'kurumiai/deepseek-v4.1-flash', [], {},
    { provider: 'kurumiai' }, { model: 'deepseek-v4.1-flash' }, { provider: undefined, model: 'x' },
    { provider: '', model: 'x' }, { provider: 'x', model: '' },
    { provider: ' x', model: 'y' }, { provider: 'x', model: 'y ' },
    { provider: 'x', model: 'y', reasoningEffort: '' }, { provider: 'x', model: 'y', reasoningEffort: 3 },
    { provider: 'x', model: 'y', extra: true },
  ]
  for (const route of invalidRoutes) {
    await assert.rejects(store.save(TEAM_A, 'worker', route), { code: ChoicesErrorCode.INVALID_ROUTE })
    await assert.rejects(store.save(TEAM_A, 'fresh', route), { code: ChoicesErrorCode.INVALID_ROUTE })
  }
  for (const [team, name] of [['', 'worker'], [TEAM_A, ''], [undefined, 'worker'], [TEAM_A, undefined]]) {
    await assert.rejects(store.save(team, name, FLASH), { code: ChoicesErrorCode.INVALID_ROUTE })
  }
  assert.deepEqual(store.load(TEAM_A, 'worker'), { ...FLASH })
  assert.equal(store.load(TEAM_A, 'fresh'), undefined)
  assert.deepEqual(await readdir(root), before)
  await store.close()
  await h.dispose()
})

test('a refused authorizer route never reaches save', async t => {
  const root = await tempRoot(t)
  const h = await host(root)
  const store = await createChoices(h.ctx)
  const session = sessionWith([policyEvent([FLASH])])
  await store.save(TEAM_A, 'worker', authorize(session, FLASH))
  assert.throws(() => authorize(session, OTHER), { code: ChoicesErrorCode.ROUTE_NOT_ALLOWED })
  assert.deepEqual(store.load(TEAM_A, 'worker'), { ...FLASH })
  await store.close()
  await h.dispose()
})

test('concurrent saves all persist and one key keeps its last write', async t => {
  const root = await tempRoot(t)
  const h = await host(root)
  const store = await createChoices(h.ctx)
  const names = Array.from({ length: 64 }, (_, index) => 'member-' + index)
  await Promise.all(names.map((name, index) => store.save(TEAM_A, name, index % 2 === 0 ? FLASH : OTHER)))
  for (const [index, name] of names.entries()) {
    assert.deepEqual(store.load(TEAM_A, name), index % 2 === 0 ? { ...FLASH } : { ...OTHER })
  }
  await Promise.all(Array.from({ length: 32 }, (_, index) => store.save(TEAM_A, 'shared', { provider: 'audit', model: 'model-' + index })))
  assert.deepEqual(store.load(TEAM_A, 'shared'), { provider: 'audit', model: 'model-31' })
  await store.close()
  await h.dispose()

  const reopened = await host(root)
  const again = await createChoices(reopened.ctx)
  assert.equal(again.load(TEAM_A, 'shared').model, 'model-31')
  await again.close()
  await reopened.dispose()
})

test('close drains queued writes ahead of the domain, is idempotent, and rejects later saves', async t => {
  const root = await tempRoot(t)
  const h = await host(root)
  const store = await createChoices(h.ctx)
  const pending = Array.from({ length: 16 }, (_, index) => store.save(TEAM_A, 'member-' + index, FLASH))
  const closing = store.close()
  assert.equal(store.close(), closing)
  await closing
  await Promise.all(pending)
  await assert.rejects(store.save(TEAM_A, 'late', FLASH), { code: ChoicesErrorCode.CLOSED })
  assert.throws(() => store.load(TEAM_A, 'member-0'), { code: ChoicesErrorCode.CLOSED })
  await h.dispose()

  const reopened = await host(root)
  const again = await createChoices(reopened.ctx)
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(again.load(TEAM_A, 'member-' + index), { ...FLASH })
  }
  assert.equal(again.load(TEAM_A, 'late'), undefined)
  await again.close()
  await reopened.dispose()
})

test('a host without the installation anchor or storage domain fails loud', async () => {
  const bare = new Context()
  await bare.plugin(Storage)
  const unregister = bare.storage.backend.register('json', new JsonStorageBackend(await mkdtemp(join(tmpdir(), 'team-model-bare-'))))
  const facility = new DomainFacility(bare, { backend: 'json', routes: {} })
  bare.storage.mount('domain', facility)
  bare.provide('storageDomain', facility)
  try {
    await assert.rejects(createChoices(bare), { code: ChoicesErrorCode.UNSUPPORTED_HOST })
  } finally {
    await facility.closeAll()
    unregister()
    await bare.fiber.dispose()
  }
  const anchored = new Context()
  anchored.provide('profileContext', { installAnchor: anchor })
  await assert.rejects(createChoices(anchored), { code: ChoicesErrorCode.UNSUPPORTED_HOST })
  await anchored.fiber.dispose()
})

test('authorize requires the Session policy and an exact allowlisted route', () => {
  const none = sessionWith([])
  assert.throws(() => authorize(none, FLASH), { code: ChoicesErrorCode.NO_POLICY })
  assert.equal(allowedRoutes(none), undefined)
  assert.throws(() => authorize(none, { provider: 'kurumiai' }), { code: ChoicesErrorCode.INVALID_ROUTE })

  const allowed = sessionWith([policyEvent([FLASH])])
  assert.deepEqual(authorize(allowed, FLASH), { ...FLASH })
  assert.deepEqual(authorize(allowed, { ...FLASH, reasoningEffort: 'max' }), { ...FLASH, reasoningEffort: 'max' })
  assert.throws(() => authorize(allowed, { provider: 'kurumiai', model: 'glm-5.3' }), { code: ChoicesErrorCode.ROUTE_NOT_ALLOWED })
  assert.throws(() => authorize(allowed, { provider: 'kennedy', model: FLASH.model }), { code: ChoicesErrorCode.ROUTE_NOT_ALLOWED })

  const repinned = sessionWith([policyEvent([FLASH]), policyEvent([OTHER])])
  assert.deepEqual(authorize(repinned, OTHER), { ...OTHER })
  assert.throws(() => authorize(repinned, FLASH), { code: ChoicesErrorCode.ROUTE_NOT_ALLOWED })
  assert.deepEqual(allowedRoutes(repinned), [{ ...OTHER }])

  assert.throws(() => authorize(sessionWith([policyEvent([FLASH])], 2), FLASH), { code: ChoicesErrorCode.NO_POLICY })
  assert.throws(() => authorize(undefined, FLASH), { code: ChoicesErrorCode.NO_POLICY })
  assert.ok(new ChoicesError('x', 'Y') instanceof Error)
})
