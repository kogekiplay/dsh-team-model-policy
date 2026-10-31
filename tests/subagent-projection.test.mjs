import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { subagentRetirementDefinition, SUBAGENT_RETIREMENT_RECORD } from '../retirements.mjs';
const require = createRequire(process.env.DSH_TEST_INSTALL_ANCHOR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json');
const { z } = require('zod');
const row = { id: 'child', parentId: 'parent', mode: 'continuable', category: 'ordinary', phase: 'removing' };
const event = (members, rootId = 'parent', seq = 3) => ({ type: SUBAGENT_RETIREMENT_RECORD, seq, data: { version: 1, rootId, members } });

test('ordinary removal state persists distinct from Team state and skips inherited records', () => {
  const d = subagentRetirementDefinition(z);
  const initial = d.init({ id: 'parent' }, 3);
  assert.equal(d.apply(initial, event([row], 'parent', 2)), initial);
  assert.equal(d.apply(initial, event([row], 'another-root')), initial);
  const removing = d.apply(initial, event([row]));
  assert.equal(removing.members[0].phase, 'removing');
  const removed = d.apply(removing, event([{ ...row, phase: 'removed' }]));
  assert.equal(removed.members[0].phase, 'removed');
  assert.equal(removed.members[0].category, 'ordinary');
  assert.equal(d.wire.view(removed), removed);
});

test('duplicate or root target records fail closed and preserve valid state', () => {
  const d = subagentRetirementDefinition(z), initial = d.init({ id: 'parent' }, 0);
  for (const members of [[row, row], [{ ...row, id: 'parent' }], [{ id: 'child', phase: 'removed' }]]) {
    const bad = d.apply(initial, event(members));
    assert.equal(typeof bad.failure, 'string');
    assert.deepEqual(bad.members, []);
    assert.equal(d.apply(bad, event([row])), bad);
  }
});

test('ordinary retirement retains retry diagnostics and parent/mode identity', () => {
  const d = subagentRetirementDefinition(z), initial = d.init({ id: 'parent' }, 0);
  const state = d.apply(initial, event([{ ...row, error: 'stop wait timed out' }]));
  assert.equal(state.members[0].error, 'stop wait timed out');
  assert.equal(state.members[0].parentId, 'parent');
  assert.equal(state.members[0].mode, 'continuable');
});
