import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTeammateAccess, LEAD_ONLY_TOOLS, TEAM_ACCESS_CONTEXT } from '../teammate-access.mjs';

function fixture() {
  const changes = [];
  const root = { id: 'root', session: { id: 'root', mode: 'workspace-write', approval: 'ask', workspace: '/team' } };
  const child = { id: 'child', session: { id: 'child', mode: 'workspace-write', approval: 'never', workspace: '/team' } };
  const registry = new Map([[root.id, root], [child.id, child]]);
  const sandbox = { resolve: ({ session, mode }) => ({ mode: mode ?? session.mode, workspaceRoot: session.workspace }) };
  const approval = { overrideOf: session => session.approval };
  const services = { sandboxPolicy: sandbox, approval };
  root.ctx = { get: name => services[name] };
  const ctx = { agents: { get: id => registry.get(id) }, get: () => undefined,
    agentTeams: { tryMembership: agent => agent === child ? { root, role: 'teammate', name: 'worker' } : agent === root ? { root, role: 'lead', name: 'lead' } : undefined } };
  const setters = { setSandboxMode: (session, mode) => { changes.push(['sandbox', session.id, mode]); session.mode = mode; },
    setApprovalPolicy: (session, policy) => { changes.push(['approval', session.id, policy]); session.approval = policy; } };
  return { root, child, registry, services, ctx, setters, changes };
}

test('Team members follow both tightening and loosening of the exact Lead policy', () => {
  const f = fixture(); syncTeammateAccess(f.ctx, f.child, f.setters);
  assert.equal(f.child.session.approval, 'ask');
  f.root.session.mode = 'danger-full-access'; f.root.session.approval = 'never';
  syncTeammateAccess(f.ctx, f.child, f.setters);
  assert.equal(f.child.session.mode, 'danger-full-access'); assert.equal(f.child.session.approval, 'never');
  f.root.session.mode = 'read-only'; f.root.session.approval = 'ask';
  syncTeammateAccess(f.ctx, f.child, f.setters);
  assert.equal(f.child.session.mode, 'read-only'); assert.equal(f.child.session.approval, 'ask');
  assert.equal(f.root.session.mode, 'read-only', 'the Lead is never modified');
});

test('unchanged policy performs no additional event writes', () => {
  const f = fixture(); syncTeammateAccess(f.ctx, f.child, f.setters); f.changes.length = 0;
  syncTeammateAccess(f.ctx, f.child, f.setters); assert.deepEqual(f.changes, []);
});

test('ordinary subagents and the Lead retain their own policy', () => {
  const f = fixture(), ordinary = { id: 'ordinary', session: { mode: 'read-only', approval: 'never' } };
  assert.equal(syncTeammateAccess(f.ctx, ordinary, f.setters), undefined);
  assert.equal(syncTeammateAccess(f.ctx, f.root, f.setters), undefined);
  assert.deepEqual(f.changes, []); assert.equal(ordinary.session.mode, 'read-only');
});

test('stale Lead identities, retired members and changed workspace boundaries fail closed', () => {
  for (const failure of ['stale', 'retired', 'workspace']) {
    const f = fixture(); f.root.session.mode = 'danger-full-access';
    if (failure === 'stale') f.registry.set('root', { ...f.root });
    if (failure === 'retired') f.ctx.get = () => ({ assertActive() { throw new Error('retired member'); } });
    if (failure === 'workspace') f.child.session.workspace = '/other';
    assert.throws(() => syncTeammateAccess(f.ctx, f.child, f.setters)); assert.deepEqual(f.changes, []);
  }
});

test('an unknown Lead approval default never broadens delegated never', () => {
  const f = fixture(); f.root.session.approval = undefined;
  syncTeammateAccess(f.ctx, f.child, f.setters); assert.equal(f.child.session.approval, 'never');
});

test('configured permission identities use their canonical setter and ordinary tools remain allowed', () => {
  const f = fixture(); f.root.session.mode = 'danger-full-access'; f.root.session.approval = 'ask';
  let selected;
  f.services.permissionPresets = { current: () => 'auto', resolve: () => ({ sandbox: 'danger-full-access', approval: 'ask' }),
    set(session, name) { selected = name; session.mode = 'danger-full-access'; session.approval = 'ask'; } };
  syncTeammateAccess(f.ctx, f.child, f.setters); assert.equal(selected, 'auto');
  for (const tool of ['read', 'write', 'edit', 'bash', 'terminal_send', 'glob', 'grep', 'skill']) assert.equal(LEAD_ONLY_TOOLS.includes(tool), false);
  assert.match(TEAM_ACCESS_CONTEXT, /One-shot grants are not standing access/);
});
