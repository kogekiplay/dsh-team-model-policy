import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { apply, inject, name, parseRoute } from '../index.mjs';
const packaged = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json';
const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? (existsSync(packaged) ? packaged : new URL('../package.json', import.meta.url));
const { Context } = createRequire(anchor)('@deepseek-ai/cordis');
const route = { provider: 'audit', model: 'flash' };
const policy = { apply, inject, name };
const model = initial => { let value = initial; return { current: () => value === undefined ? undefined : { ...value }, select: next => { value = { ...next }; } }; };
function harness(resolveCallConfig = async choice => choice) {
  const ctx = new Context();
  const agents = new Map();
  const members = [];
  const sections = new Map();
  const root = { id: 'lead', options: { provider: 'audit', model: 'stale' }, session: { inheritedEventCount: 0, snapshotEvents: () => [header('audit', 'gpt')] } };
  const child = { id: 'child', options: { provider: 'audit', model: 'gpt' }, session: { inheritedEventCount: 1,
    snapshotEvents: offset => [header('audit', 'gpt'), header('audit', 'flash')].slice(offset) } };
  root.model = model({ provider: 'audit', model: 'gpt', reasoningEffort: 'max' });
  child.model = model({ provider: 'audit', model: 'gpt', reasoningEffort: 'max' });
  agents.set(root.id, root); agents.set(child.id, child);
  members.push({ id: root.id, name: 'lead', role: 'lead', status: 'running' }, { id: child.id, name: 'worker', role: 'teammate', status: 'inactive' });
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
  ctx.provide('agentTeams', { tryMembership: a => a === child ? { role: 'teammate', root, name: 'worker' } : a === root ? { role: 'lead', root, name: 'lead' } : undefined,
    membership: a => ({ root, name: a === child ? 'worker' : 'lead', role: a === child ? 'teammate' : 'lead' }),
    listMembers: () => members });
  ctx.provide('llm', { resolveCallConfig });
  ctx.provide('tools', {});
  ctx.provide('teamRetirements', { visibleRows: (_caller, rows) => rows });
  const persistence = { open: async () => { throw new Error('Unexpected persisted read'); } };
  ctx.provide('sessionPersistence', persistence);
  ctx.provide('systemPrompt', { getSectionOrder: () => 1, section(section) {
    return ctx.effect(() => { sections.set(section.name, section.text); return () => sections.delete(section.name); });
  } });
  return { ctx, root, child, agents, members, sections, persistence };
}
const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } } } });
const invokeRequest = (ctx, agent, signal = new AbortController().signal) => ctx.waterfall('agent/request', { agent, signal },
  async () => ({ provider: 'audit', model: 'gpt', reasoningEffort: 'max', maxTokens: 17 }));
const memberRow = target => ({ target, role: target === 'lead' ? 'lead' : 'teammate', status: 'inactive', model: 'stale', diagnostics: [] });

test('invalid configuration is refused before effects are registered', () => {
  for (const config of [undefined, null, {}, { provider: 'audit' }, { provider: ' audit', model: 'x' }, { ...route, unknown: true }]) {
    assert.throws(() => parseRoute(config), { code: 'INVALID_CONFIG' });
  }
});

test('creation records the teammate choice before preparation without changing request controls or the Lead', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose());
  await h.ctx.plugin(policy, route);
  await h.ctx.serial('agent/created', { agent: h.child });
  assert.deepEqual(h.child.model.current(), route);
  assert.deepEqual(await invokeRequest(h.ctx, h.child), { provider: 'audit', model: 'gpt', reasoningEffort: 'max', maxTokens: 17 });
  assert.equal(h.root.model.current().model, 'gpt');
  assert.equal((await invokeRequest(h.ctx, { id: 'ordinary' })).model, 'gpt');
});

test('settings select the next model without altering the selection already captured for a step', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose());
  const config = { mode: 'fixed', ...route };
  await h.ctx.plugin(policy, config);
  await h.ctx.serial('agent/created', { agent: h.child });
  const captured = Object.freeze(h.child.model.current());
  config.model = 'next'; config.reasoningEffort = 'off';
  h.ctx.emit('settings/document-updated', 'team-model-policy', 2);
  assert.deepEqual(h.child.model.current(), { provider: 'audit', model: 'next', reasoningEffort: 'off' });
  const decision = { kind: 'enter', messages: [], startsRequestSeries: true };
  const result = await h.ctx.waterfall('agent/pre-step', { agent: h.child, signal: new AbortController().signal, modelSelection: captured }, async () => decision);
  assert.equal(result, decision); assert.deepEqual(captured, route);
  assert.equal(h.child.model.current().model, 'next'); assert.equal(h.root.model.current().model, 'gpt');
});

test('direct model overrides cannot bypass the fixed Team policy', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  await h.ctx.serial('agent/created', { agent: h.child });
  h.child.model.select({ provider: 'audit', model: 'unexpected' });
  const captured = Object.freeze(h.child.model.current());
  await assert.rejects(h.ctx.waterfall('agent/pre-step', { agent: h.child, signal: new AbortController().signal, modelSelection: captured }, async () => ({ kind: 'enter', messages: [] })), { code: 'TEAM_MODEL_POLICY_MISMATCH' });
  assert.deepEqual(h.child.model.current(), route); assert.equal(captured.model, 'unexpected');
});

test('model preflight never materializes adapter-default effort into the explicit selection', async t => {
  const h = harness(async choice => ({ ...choice, reasoningEffort: choice.reasoningEffort ?? 'high' }));
  t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  await h.ctx.serial('agent/created', { agent: h.child });
  assert.deepEqual(h.child.model.current(), route); assert.equal('reasoningEffort' in h.child.model.current(), false);
});

test('invalid adapter routes and unsupported model APIs fail creation', async t => {
  const h = harness(async () => { throw new Error('route unavailable'); }); t.after(() => h.ctx.fiber.dispose());
  await h.ctx.plugin(policy, route);
  await assert.rejects(h.ctx.serial('agent/created', { agent: h.child }), /route unavailable/);
  h.child.model = {};
  await assert.rejects(h.ctx.serial('agent/created', { agent: h.child }), { code: 'UNSUPPORTED_RUNTIME' });
});

test('roster reports own request headers and preserves downstream blocks and failures', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  const result = { isError: false, value: [memberRow('lead'), memberRow('worker')] };
  const decision = await h.ctx.waterfall('tools/post-execute', exec, result, async () => ({ kind: 'accept' }));
  assert.deepEqual(decision.value.map(r => r.model), ['gpt', 'flash']);
  const block = { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] };
  assert.equal(await h.ctx.waterfall('tools/post-execute', exec, result, async () => block), block);
  const pass = { kind: 'accept' };
  assert.equal(await h.ctx.waterfall('tools/post-execute', exec, { isError: true }, async () => pass), pass);
});

test('fork seed headers are excluded before a child has made a request', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.child.session.snapshotEvents = offset => [header('audit', 'parent-only')].slice(offset);
  const exec = { name: 'spawn_teammate', agent: h.root, signal: new AbortController().signal };
  const decision = await h.ctx.waterfall('tools/post-execute', exec, { isError: false, value: { member: memberRow('worker') } }, async () => ({ kind: 'accept' }));
  assert.equal(decision.value.member.model, 'flash');
  assert.match(decision.value.member.diagnostics[0], /No member request/);
});

test('unload waits for in-flight preflight to settle and removes effects', async t => {
  const entered = Promise.withResolvers(); const aborted = Promise.withResolvers(); const release = Promise.withResolvers();
  const h = harness(async (selection, signal) => {
    entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise; return selection;
  });
  t.after(() => h.ctx.fiber.dispose());
  const fiber = await h.ctx.plugin(policy, route);
  const operation = h.ctx.serial('agent/created', { agent: h.child });
  const rejection = assert.rejects(operation, { code: 'POLICY_UNLOADING' });
  await entered.promise;
  let disposed = false; const disposal = fiber.dispose().then(() => { disposed = true; });
  await aborted.promise;
  assert.equal(disposed, false);
  release.resolve(); await rejection; await disposal;
  assert.equal(h.sections.size, 0);
  assert.equal((await invokeRequest(h.ctx, h.child)).model, 'gpt');
  const again = await h.ctx.plugin(policy, route);
  await h.ctx.serial('agent/created', { agent: h.child });
  assert.equal(h.child.model.current().model, 'flash');
  await again.dispose();
});

test('cold member model comes from its own durable header and the read handle closes', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id); let closed = false;
  h.persistence.open = async () => ({ inheritedEventCount: 1, read: async (offset, length, options) => {
    assert.equal(offset, 1); assert.equal(length, undefined); assert.ok(options.signal instanceof AbortSignal);
    return { eventState: 'detached', events: [header('audit', 'parent-only'), header('audit', 'flash')].slice(offset) };
  }, close: async () => { closed = true; } });
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  const decision = await h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  assert.equal(decision.value[0].model, 'flash'); assert.equal(closed, true);
});

test('cold fork with no own request never reports the inherited parent model', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id);
  h.persistence.open = async () => ({ inheritedEventCount: 1,
    read: async offset => ({ eventState: 'detached', events: [header('audit', 'parent-only')].slice(offset) }), close: async () => {} });
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  const decision = await h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  assert.equal(decision.value[0].model, 'flash'); assert.match(decision.value[0].diagnostics.join(' '), /No member request/);
});

test('concurrent rosters never open a second cold history before the first handle closes', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), closing = Promise.withResolvers(), finishClose = Promise.withResolvers();
  let opened = 0, active = 0, peak = 0;
  h.persistence.open = async () => { const sequence = ++opened; peak = Math.max(peak, ++active);
    return { inheritedEventCount: 0, read: async () => { if (sequence === 1) { entered.resolve(); await release.promise; } return { eventState: 'detached', events: [header('audit', 'flash')] }; }, close: async () => { if (sequence === 1) { closing.resolve(); await finishClose.promise; } active--; } }; };
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  const run = () => h.ctx.waterfall('tools/post-execute', exec, { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  const first = run(); await entered.promise; const second = run();
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1); assert.equal(active, 1);
    release.resolve(); await closing.promise;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1, 'the next read must wait for close, not just read completion');
  } finally { release.resolve(); finishClose.resolve(); }
  const results = await Promise.all([first, second]);
  assert.equal(opened, 2); assert.equal(peak, 1); assert.equal(active, 0); assert.ok(results.every(r => r.value[0].model === 'flash'));
});

test('a queued cancelled roster never opens its cold history', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route); h.agents.delete(h.child.id);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController(); let opened = 0;
  h.persistence.open = async () => { opened++; return { inheritedEventCount: 0, read: async () => { entered.resolve(); await release.promise; return { eventState: 'detached', events: [header('audit', 'flash')] }; }, close: async () => {} }; };
  const run = signal => h.ctx.waterfall('tools/post-execute', { name: 'list_agents', agent: h.root, signal }, { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  const first = run(new AbortController().signal); await entered.promise;
  const rejection = assert.rejects(run(controller.signal), /queued read cancelled/);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('queued read cancelled')); release.resolve();
  await Promise.all([first, rejection]); assert.equal(opened, 1);
});

test('cancelled persisted reads close before the result is rejected', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id); let closed = false;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const controller = new AbortController();
  h.persistence.open = async () => ({ inheritedEventCount: 0, read: async () => { entered.resolve(); return release.promise; }, close: async () => { closed = true; } });
  const exec = { name: 'list_agents', agent: h.root, signal: controller.signal };
  const operation = h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  const rejection = assert.rejects(operation, /cancelled read/);
  await entered.promise; controller.abort(new Error('cancelled read'));
  release.resolve({ eventState: 'detached', events: [header('audit', 'flash')] });
  await rejection; assert.equal(closed, true);
});

test('one roster read failure waits for the other owned read to close', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id);
  h.members.push({ id: 'other', name: 'other', role: 'teammate', status: 'inactive' });
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const closed = [];
  h.persistence.open = async id => ({ inheritedEventCount: 0, read: async () => {
    if (id === 'child') throw new Error('read failed');
    entered.resolve(); await release.promise; return { eventState: 'detached', events: [header('audit', 'flash')] };
  }, close: async () => { closed.push(id); } });
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  let settled = false;
  const operation = h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker'), memberRow('other')] }, async () => ({ kind: 'accept' }));
  const rejection = assert.rejects(operation, /read failed/).then(() => { settled = true; });
  await entered.promise;
  try { assert.equal(settled, false); } finally { release.resolve(); }
  await rejection; assert.deepEqual(closed.sort(), ['child', 'other']);
});
