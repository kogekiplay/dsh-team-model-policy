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
function harness(resolveCallConfig = async choice => choice) {
  const ctx = new Context();
  const agents = new Map();
  const members = [];
  const sections = new Map();
  const root = { id: 'lead', options: { provider: 'audit', model: 'stale' }, session: { inheritedEventCount: 0, snapshotEvents: () => [header('audit', 'gpt')] } };
  const child = { id: 'child', options: { provider: 'audit', model: 'gpt' }, session: { inheritedEventCount: 1,
    snapshotEvents: offset => [header('audit', 'gpt'), header('audit', 'flash')].slice(offset) } };
  agents.set(root.id, root); agents.set(child.id, child);
  members.push({ id: root.id, name: 'lead', role: 'lead', status: 'running' }, { id: child.id, name: 'worker', role: 'teammate', status: 'inactive' });
  ctx.provide('agents', { get: id => agents.get(id) });
  ctx.provide('agentTeams', { tryMembership: a => a === child ? { role: 'teammate' } : a === root ? { role: 'lead' } : undefined,
    membership: a => ({ root, name: a === child ? 'worker' : 'lead', role: a === child ? 'teammate' : 'lead' }),
    listMembers: () => members });
  ctx.provide('llm', { resolveCallConfig });
  ctx.provide('tools', {});
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

test('request policy replaces teammate route and clears inherited effort; other agents retain next()', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose());
  await h.ctx.plugin(policy, route);
  assert.deepEqual(await invokeRequest(h.ctx, h.child), { ...route, maxTokens: 17 });
  assert.equal((await invokeRequest(h.ctx, h.root)).model, 'gpt');
  assert.equal((await invokeRequest(h.ctx, { id: 'ordinary' })).model, 'gpt');
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
  assert.equal((await invokeRequest(h.ctx, h.child)).model, 'flash');
  await again.dispose();
});

test('cold member model comes from its own durable header and the read handle closes', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id); let closed = false;
  h.persistence.open = async () => ({ read: async () => ({ inheritedEventCount: 1,
    events: [header('audit', 'parent-only'), header('audit', 'flash')] }), close: async () => { closed = true; } });
  const exec = { name: 'list_agents', agent: h.root, signal: new AbortController().signal };
  const decision = await h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  assert.equal(decision.value[0].model, 'flash'); assert.equal(closed, true);
});

test('cancelled persisted reads close before the result is rejected', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id); let closed = false;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const controller = new AbortController();
  h.persistence.open = async () => ({ read: async () => { entered.resolve(); return release.promise; }, close: async () => { closed = true; } });
  const exec = { name: 'list_agents', agent: h.root, signal: controller.signal };
  const operation = h.ctx.waterfall('tools/post-execute', exec,
    { isError: false, value: [memberRow('worker')] }, async () => ({ kind: 'accept' }));
  const rejection = assert.rejects(operation, /cancelled read/);
  await entered.promise; controller.abort(new Error('cancelled read'));
  release.resolve({ events: [header('audit', 'flash')], inheritedEventCount: 0 });
  await rejection; assert.equal(closed, true);
});

test('one roster read failure waits for the other owned read to close', async t => {
  const h = harness(); t.after(() => h.ctx.fiber.dispose()); await h.ctx.plugin(policy, route);
  h.agents.delete(h.child.id);
  h.members.push({ id: 'other', name: 'other', role: 'teammate', status: 'inactive' });
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const closed = [];
  h.persistence.open = async id => ({ read: async () => {
    if (id === 'child') throw new Error('read failed');
    entered.resolve(); await release.promise; return { events: [header('audit', 'flash')], inheritedEventCount: 0 };
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
