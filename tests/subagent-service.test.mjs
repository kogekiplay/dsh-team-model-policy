import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Provider from '../retirements.mjs';
const anchor = process.env.DSH_TEST_INSTALL_ANCHOR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json';
const require = createRequire(anchor);
const { Context } = require('@deepseek-ai/cordis');
const { Session } = require('@deepseek-ai/dsh-session');

async function harness(t) {
  const ctx = new Context(), definitions = new Map(), agents = new Map(), sessions = new Map(), commands = new Map(), tools = new Map();
  const archive = [], stops = [], drains = [], teamRows = new Map();
  function agent(id, parent) {
    const session = Session.create(id, [], { version: 4, id, createdAt: Date.now(), isSeeded: false, ...(parent ? { parentSession: parent, origin: 'subagent' } : {}) });
    const value = { id, session, status: 'inactive' }; sessions.set(id, session); agents.set(id, value); return value;
  }
  const root = agent('root'), target = agent('target', 'root'), grand = agent('grand', 'target'), sibling = agent('sibling', 'root');
  let entries = [
    { kind: 'child', id: 'target', parentId: 'root', depth: 1, mode: 'continuable', activity: 'inactive', hasChildren: true },
    { kind: 'child', id: 'grand', parentId: 'target', depth: 2, mode: 'continuable', activity: 'inactive', hasChildren: false },
    { kind: 'child', id: 'sibling', parentId: 'root', depth: 1, mode: 'continuable', activity: 'inactive', hasChildren: false },
  ];
  const projection = { register(d) { definitions.set(d.key, d); return () => definitions.delete(d.key); }, snapshot(s) {
    const values = { agentTeam: { members: teamRows.get(s.id) ?? [], tasks: [] } };
    for (const d of definitions.values()) { let state = d.init(s.header, s.inheritedEventCount); for (const e of s.snapshotEvents()) state = d.apply(state, e); values[d.key] = d.wire.view(state); }
    return { values };
  } };
  ctx.provide('profileContext', { installAnchor: anchor });
  ctx.provide('agents', { get: id => agents.get(id) });
  ctx.provide('sessions', { get: id => sessions.get(id), flush: async () => true });
  ctx.provide('sessionProjections', projection);
  ctx.provide('agentTeams', { tryMembership: a => agents.get(a.id) === a && a.id === 'root' ? { role: 'lead', root } : undefined });
  ctx.provide('subagents', {
    listDescendants: async id => id === 'root' ? entries : [],
    interrupt(id, authority) { stops.push({ id, authority }); },
    drainDescendants: async parents => { drains.push({ descendants: parents.map(a => a.id) }); },
    drainChildren: async (parent, ids) => { drains.push({ parent: parent.id, ids }); for (const id of ids) agents.delete(id); },
  });
  let archiveError;
  ctx.provide('workspaceRegistry', { archivedSessionIds: archive, archiveSession: async id => { if (archiveError) throw archiveError; if (!archive.includes(id)) archive.push(id); } });
  ctx.provide('tools', { guard: () => () => {}, register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } });
  ctx.provide('commands', { register: d => { commands.set(d.name, d); return () => commands.delete(d.name); } });
  let released = 0;
  ctx.provide('sessionQuery', { observeSession: async id => { const s = sessions.get(id); if (!s) throw new Error('unknown Session'); return { header: s.header, projections: projection.snapshot(s), [Symbol.dispose]() { released++; } }; } });
  await ctx.plugin(Provider, { jobStopTimeoutMs: 10 });
  t.after(() => ctx.fiber.dispose());
  return { ctx, root, target, grand, sibling, archive, stops, drains, agents, sessions, commands, tools, teamRows,
    service: ctx.get('teamRetirements'), signal: new AbortController().signal,
    setEntries: value => { entries = value; }, setArchiveError: value => { archiveError = value; }, released: () => released };
}

test('ordinary subtree is durably removed while sibling and history remain', async t => {
  const h = await harness(t), result = await h.service.removeSubagent(h.root, 'target', h.signal);
  assert.deepEqual(result.removedSessionIds, ['target', 'grand']);
  assert.deepEqual(h.archive, ['target', 'grand']);
  assert.equal(h.agents.has('sibling'), true); assert.equal(h.sessions.has('target'), true);
  assert.equal(h.agents.has('target'), false); assert.equal(h.stops[0].authority.parentSessionId, 'root');
  assert.equal(h.stops[1].authority.parentSessionId, 'target');
  assert.equal(h.service.subagentState(h.root.session).members.every(row => row.phase === 'removed'), true);
  assert.deepEqual((await h.service.listManageableSubagents(h.root, h.signal)).children.map(row => row.id), ['sibling']);
  assert.equal((await h.service.removeSubagent(h.root, 'target', h.signal)).alreadyRemoved, true);
  assert.ok(h.released() > 0);
});

test('self, unrelated, and external targets fail before archival or retirement writes', async t => {
  const h = await harness(t);
  await assert.rejects(h.service.removeSubagent(h.root, 'root', h.signal), { code: 'SUBAGENT_INVALID_TARGET' });
  await assert.rejects(h.service.removeSubagent(h.root, 'unrelated', h.signal), { code: 'SUBAGENT_NOT_CHILD' });
  h.setEntries([{ kind: 'child', id: 'external', parentId: 'root', depth: 1, mode: 'external', activity: 'inactive' }]);
  assert.equal((await h.service.listManageableSubagents(h.root, h.signal)).children[0].removable, false);
  await assert.rejects(h.service.removeSubagent(h.root, 'external', h.signal), { code: 'SUBAGENT_UNSUPPORTED_MODE' });
  assert.deepEqual(h.archive, []); assert.deepEqual(h.service.subagentState(h.root.session).members, []);
});

test('failed cleanup preserves removing/error, blocks nested live and cold work, then retries', async t => {
  const h = await harness(t); h.setArchiveError(new Error('archive transport down'));
  await assert.rejects(h.service.removeSubagent(h.root, 'target', h.signal), { code: 'SUBAGENT_RETIREMENT_INCOMPLETE' });
  assert.match(h.service.subagentState(h.root.session).members[0].error, /transport down/);
  assert.match(h.service.blockedReason(h.grand), /removed/);
  h.sessions.delete('target');
  // Cold-parent observation remains available from this test query when restored below.
  h.sessions.set('target', h.target.session); h.agents.delete('target');
  assert.match(await h.service.storedBlockedReason(h.grand, h.signal), /removed/);
  h.setArchiveError(undefined);
  const result = await h.service.removeSubagent(h.root, 'target', h.signal);
  assert.equal(result.removed, true); assert.equal(h.service.subagentState(h.root.session).members[0].phase, 'removed');
});

test('Team IDs route to existing task-reclaiming removal without ordinary records', async t => {
  const h = await harness(t); h.teamRows.set('root', [{ id: 'target', role: 'teammate', name: 'worker' }]);
  let called;
  h.service.remove = async (owner, target) => { called = { owner: owner.id, target }; return { removed: true }; };
  const result = await h.service.removeSubagent(h.root, 'target', h.signal);
  assert.deepEqual(called, { owner: 'root', target: 'worker' }); assert.equal(result.kind, 'teammate');
  assert.deepEqual(h.service.subagentState(h.root.session).members, []); assert.deepEqual(h.archive, []);
});

test('slash command and tool share the Host operation and reject stale parent identities', async t => {
  const h = await harness(t);
  const result = await h.commands.get('subagent-remove').handler({ agent: h.root, rawInput: ' sibling', signal: h.signal });
  assert.equal(result.kind, 'success'); assert.ok(h.archive.includes('sibling'));
  assert.ok(h.tools.has('list_manageable_subagents')); assert.ok(h.tools.has('remove_subagent'));
  await assert.rejects(h.service.removeSubagent({ ...h.root }, 'target', h.signal), { code: 'SUBAGENT_PARENT_REQUIRED' });
});
