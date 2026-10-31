import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { filterCatalog, retirementFor } from '../src/client/subagent-filter.cjs'
import locale from '../src/client/subagent-locale.cjs'

const require = createRequire(import.meta.url)
process.env.DSH_UI_TEST_MODULES = new URL('../node_modules', import.meta.url).pathname
const { React, ReactDOM, mount, fire } = require('../src/client/test/renderer.cjs')
const bundled = buildSync({ entryPoints: [new URL('../src/client/subagent-view.tsx', import.meta.url).pathname], bundle: true, write: false, outfile: 'subagent-component-test.cjs', format: 'cjs', platform: 'node', loader: { '.css': 'local-css' }, external: ['react', 'react-dom'], jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).outputFiles.find(file => file.path.endsWith('.cjs')).text
const exports = { exports: {} }
new Function('module', 'exports', 'require', bundled)(exports, exports.exports, id => {
  assert.ok(['react', 'react-dom'].includes(id), 'runtime Harness imports must not enter the component')
  return require(id)
})
const { SubagentCatalogAction, SubagentHeaderLineage } = exports.exports
const t = (key, values = {}) => (locale.en[key] ?? key).replace(/\{(\w+)\}/g, (full, name) => String(values[name] ?? full))
const entry = (id, mode = 'continuable') => ({ id, label: id.toUpperCase(), mode })
const projection = (entries = [], ordinary = [], teams = []) => ({ state: 'ready', values: { subagentCatalog: entries, subagentRetirements: { members: ordinary }, teamRetirements: { members: teams } } })

function fixture() {
  return {
    byId: { root: {}, a: { origin: 'subagent', parentId: 'root' }, sibling: { origin: 'subagent', parentId: 'root' }, grand: { origin: 'subagent', parentId: 'a' } },
    projectionsBySession: {
      root: projection([entry('a'), entry('sibling')]),
      a: projection([entry('grand'), entry('gone')], [{ id: 'gone', phase: 'removed' }]),
      sibling: projection(), grand: projection(), gone: projection(),
      unrelated: { state: 'ready', values: { subagentRetirements: { failure: 'unrelated bad record' }, teamRetirements: { failure: 'unrelated bad record' } } },
    },
  }
}

async function harness(state = fixture(), overrides = {}, Component = SubagentCatalogAction) {
  const probe = mount(null)
  const doc = probe.document
  const listeners = new Map()
  const windowListeners = new Map()
  const timers = new Map()
  let timerId = 0
  const add = map => (type, fn) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn) }
  const remove = map => (type, fn) => map.get(type)?.delete(fn)
  doc.body = doc.createElement('body')
  doc.addEventListener = add(listeners)
  doc.removeEventListener = remove(listeners)
  doc.activeElement = null
  const proto = Object.getPrototypeOf(doc.body)
  proto.getBoundingClientRect = function () { return this.nodeName === 'BUTTON' ? { left: 980, top: 730, right: 1010, bottom: 758, width: 30, height: 28 } : { left: 0, top: 0, right: 390, bottom: 300, width: 390, height: 300 } }
  proto.focus = function () { doc.activeElement = this }
  proto.querySelectorAll = function () {
    const result = []
    const visit = node => { if (node.getAttribute?.('role') === 'treeitem' && node.getAttribute('aria-disabled') !== 'true') result.push(node); for (const child of node.childNodes) visit(child) }
    visit(this); return result
  }
  globalThis.document = doc
  Object.assign(globalThis.window, { innerWidth: 1024, innerHeight: 768, addEventListener: add(windowListeners), removeEventListener: remove(windowListeners), setInterval: fn => { timers.set(++timerId, fn); return timerId }, clearInterval: id => timers.delete(id) })
  const calls = { open: [], aside: [], remove: [], refresh: [], titles: 0 }
  let snapshot = { subagent: null }
  const options = {
    sessionId: 'root', useSession: selector => selector(snapshot),
    useSessions: selector => selector(state), useSessionStatus: selector => selector(new Map()), t,
    openChild: address => calls.open.push(address), openChildAside: address => calls.aside.push(address),
    removeSubagent: async (...args) => { calls.remove.push(args) }, refreshProjection: id => calls.refresh.push(id),
    ...overrides,
  }
  const element = () => React.createElement(Component, options)
  const view = mount(element())
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); ReactDOM.flushSync(() => {}); await new Promise(resolve => setTimeout(resolve, 0)) }
  const all = predicate => {
    const result = []
    const visit = node => { if (predicate(node)) result.push(node); for (const child of node.childNodes) visit(child) }
    visit(view.container); visit(doc.body); return result
  }
  const button = label => all(node => node.nodeName === 'BUTTON' && (node.getAttribute('aria-label') === label || node.textContent === label))[0]
  const row = label => all(node => node.getAttribute?.('role') === 'treeitem' && node.getAttribute('aria-label')?.startsWith(label + ' '))[0]
  const click = async node => { assert.ok(node, 'target exists'); ReactDOM.flushSync(() => fire(node, 'click')); await settle() }
  const key = async (name, target = doc.activeElement) => { ReactDOM.flushSync(() => { for (const fn of listeners.get('keydown') ?? []) fn({ key: name, target, preventDefault() {} }) }); await settle() }
  await settle()
  return {
    calls, options, all, button, row, click, key, text: () => view.container.textContent + doc.body.textContent,
    async open(index = 0) { await click(all(node => node.nodeName === 'BUTTON' && node.getAttribute('aria-haspopup') === 'tree')[index]) },
    async rerender() { ReactDOM.flushSync(() => view.rerender(element())); await settle() },
    async tick() { for (const fn of timers.values()) ReactDOM.flushSync(fn); await settle() },
    async outside() { for (const fn of listeners.get('pointerdown') ?? []) fn({ target: doc.createElement('div') }); await settle() },
    async resize() { for (const fn of windowListeners.get('resize') ?? []) fn(); for (const fn of listeners.get('scroll') ?? []) fn(); await settle() },
    doc, setSnapshot: value => { snapshot = value },
    close() { view.unmount(); probe.unmount(); assert.equal(timers.size, 0, 'timer disposed'); delete globalThis.document },
  }
}

test('ordinary subagent filter hides only durably removed rows and keeps retryable rows', () => {
  const entries = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
  const ordinary = [{ members: [{ id: 'two', phase: 'removed' }, { id: 'three', phase: 'removing', error: 'timed out' }] }]
  assert.deepEqual(filterCatalog(entries, ordinary, []).entries.map(row => row.id), ['one', 'three'])
  assert.equal(retirementFor('three', ordinary, []).row.error, 'timed out')
})

test('Team and ancestor retirements merge without conflating ordinary and Team records', () => {
  const ordinary = [{ members: [{ id: 'nested', phase: 'removed' }] }, { members: [{ id: 'ancestor-child', phase: 'removed' }] }]
  const teams = [{ members: [{ id: 'team-child', phase: 'removed' }] }]
  assert.deepEqual(filterCatalog([{ id: 'nested' }, { id: 'ancestor-child' }, { id: 'team-child' }, { id: 'keep' }], ordinary, teams).entries, [{ id: 'keep' }])
  assert.equal(retirementFor('team-child', ordinary, teams).kind, 'team')
})

test('missing root state and corrupt states preserve navigation rows and disable removal', () => {
  const entries = [{ id: 'child' }]
  for (const states of [undefined, []]) {
    const result = filterCatalog(entries, states, [])
    assert.equal(result.state, 'unavailable'); assert.deepEqual(result.entries, entries)
  }
  for (const states of [[{ failure: 'bad record' }], [null], [{ members: null }]]) {
    const result = filterCatalog(entries, states, [])
    assert.equal(result.state, 'error'); assert.deepEqual(result.entries, entries)
  }
  assert.equal(retirementFor('child', [{ failure: 'bad record' }], []).error, 'bad record')
})

test('real component displays total count, filters nested retirements, and keeps unrelated corruption isolated', async () => {
  const h = await harness()
  try {
    assert.match(h.text(), /2 subagents/); assert.doesNotMatch(h.text(), /2 running/)
    await h.open()
    assert.ok(h.button('Remove A')); assert.equal(h.button('Remove A').disabled, false)
    await h.click(h.button('Expand A'))
    assert.ok(h.row('GRAND')); assert.equal(h.row('GONE'), undefined)
    assert.equal(h.button('Expand GRAND'), undefined, 'filtered empty catalog is a leaf')
    await h.click(h.row('GRAND'))
    assert.deepEqual(h.calls.open.at(-1), { parentSessionId: 'a', childSessionId: 'grand', mode: 'continuable' })
  } finally { h.close() }
})

test('real nested sidebar and remove callbacks retain true parent and root authority', async () => {
  const h = await harness()
  try {
    await h.open(); await h.click(h.button('Expand A'))
    const sidebar = h.row('GRAND').childNodes.find(node => node.nodeName === 'BUTTON' && node.getAttribute('aria-label') === 'Open in sidebar')
    await h.click(sidebar)
    assert.deepEqual(h.calls.aside.at(-1), { parentSessionId: 'a', childSessionId: 'grand', mode: 'continuable' })
    await h.open(); await h.click(h.button('Expand A')); await h.click(h.button('Remove GRAND'))
    assert.match(h.text(), /descendants/); assert.match(h.text(), /conversation history/)
    await h.click(h.button('Remove subagent'))
    assert.deepEqual(h.calls.remove, [['root', 'grand']])
  } finally { h.close() }
})

test('sibling removal uses native parent dropdown root while own-child removal uses child root', async () => {
  const h = await harness(fixture(), { sessionId: 'a', lineageSessionId: 'a' }, SubagentHeaderLineage)
  try {
    h.setSnapshot({ subagent: { address: { parentSessionId: 'root', childSessionId: 'a', mode: 'continuable' } } }); await h.rerender()
    await h.open(0); await h.click(h.button('Remove SIBLING')); await h.click(h.button('Remove subagent'))
    assert.deepEqual(h.calls.remove.at(-1), ['root', 'sibling'])
    await h.outside(); await h.open(1); await h.click(h.button('Remove GRAND')); await h.click(h.button('Remove subagent'))
    assert.deepEqual(h.calls.remove.at(-1), ['a', 'grand'])
  } finally { h.close() }
})

test('lineage ancestor title and chevron remain separate, and parent resolves from lineage id', async () => {
  const state = fixture(); state.byId.root = { origin: 'subagent', parentId: 'ancestor' }; state.projectionsBySession.ancestor = projection([entry('root')])
  const h = await harness(state, { sessionId: 'a', lineageSessionId: 'root', displayTitle: 'ROOT', openTitle: () => {} }, SubagentHeaderLineage)
  try {
    h.setSnapshot({ subagent: { address: { parentSessionId: 'root', childSessionId: 'a', mode: 'continuable' } } }); await h.rerender()
    await h.open(); assert.ok(h.row('ROOT')); assert.equal(h.row('SIBLING'), undefined)
    h.setSnapshot({ subagent: null }); await h.rerender()
    assert.ok(h.button('ROOT'), 'conditional address update preserves hook order')
  } finally { h.close() }
})

test('missing or corrupt retirement data keeps rows and retry usable while removal is disabled', async () => {
  for (const bad of [undefined, { failure: 'broken root' }]) {
    const state = fixture(); state.projectionsBySession.root.values.subagentRetirements = bad
    const h = await harness(state)
    try { await h.open(); assert.ok(h.row('A')); assert.equal(h.button('Remove A').disabled, true); assert.ok(h.button('Retry')); await h.click(h.button('Retry')); assert.ok(h.calls.refresh.includes('root')); await h.click(h.row('A')); assert.equal(h.calls.open.at(-1).childSessionId, 'a') }
    finally { h.close() }
  }
})

test('external entries cannot open/remove and unknown entries require opening first', async () => {
  const state = fixture(); state.projectionsBySession.root = projection([entry('ext', 'external'), entry('unknown', 'unknown')])
  const h = await harness(state)
  try { await h.open(); assert.equal(h.row('EXT').getAttribute('aria-disabled'), 'true'); assert.equal(h.button('Remove EXT'), undefined); assert.equal(h.button('Remove UNKNOWN'), undefined); assert.match(h.text(), /no local Session/); assert.match(h.text(), /verify its local Session/); await h.click(h.row('UNKNOWN')); assert.equal(h.calls.open.at(-1).mode, 'unknown') }
  finally { h.close() }
})

test('native token and timing shapes render; running durations update, keyboard and clamping work', async () => {
  const state = fixture(); state.byId.a = { origin: 'subagent', parentId: 'root', running: true, projectionValues: { tokenUsage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 }, subagentTiming: { settledMs: 1000, active: { since: Date.now() - 2000, through: Date.now() - 1000 } } } }
  const h = await harness(state)
  try {
    await h.open(); assert.match(h.text(), /Tokens: 1.6K/); assert.match(h.text(), /Duration:/)
    const trigger = h.all(node => node.getAttribute?.('aria-haspopup') === 'tree')[0]; trigger.focus(); await h.key('ArrowDown'); assert.equal(h.doc.activeElement, h.row('A'))
    await h.key('End'); assert.equal(h.doc.activeElement, h.row('SIBLING'))
    await h.resize(); const menu = h.all(node => node.getAttribute?.('role') === 'tree')[0]; assert.ok(Number.parseFloat(menu.style.left) <= 622); assert.ok(Number.parseFloat(menu.style.top) <= 456)
    await h.key('Escape'); assert.equal(h.doc.activeElement, trigger); assert.equal(h.row('A'), undefined)
  } finally { h.close() }
})
