import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const { createTeamModelPolicyCard } = require('../src/client/card.cjs');
const { createTranslator } = require('../src/client/locale.cjs');
const { createTeamModelPolicyView } = require('../src/client/view.cjs');
const { visibleTeam } = require('../src/client/retirement-view.cjs');
// The shared form is exercised in the real GUI; this suite renders the plugin-owned controls.
const TeamModelPolicyCard = createTeamModelPolicyView(props => React.createElement('div', null, props.children));
function fixture() {
  let snapshot = { status: 'ready', writable: true, revision: 5, value: { mode: 'follow-subagent', provider: '', model: '', reasoningEffort: '', defaultReasoningEffort: 'max' }, user: {} };
  const listeners = new Set(); const writes = [];
  const scope = { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate: async (ops, revision) => { writes.push({ ops, revision }); if (revision !== snapshot.revision) return false;
      const value = { ...snapshot.value }; for (const op of ops) { if (op.op === 'set') value[op.path[0]] = op.value; else delete value[op.path[0]]; }
      snapshot = { ...snapshot, value, user: value, revision: snapshot.revision + 1 }; for (const listener of listeners) listener(); return true; } };
  const card = createTeamModelPolicyCard({ scope, t: createTranslator('zh'), readCatalog: async () => ({ groups: [{ id: 'p', name: 'Provider', models: [{ id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }] }] }) });
  return { card, writes, update: () => { snapshot = { ...snapshot, revision: 6 }; for (const listener of listeners) listener(); } };
}
test('follow card renders the selectable policy and default max', t => {
  const f = fixture(); t.after(() => f.card.dispose());
  const markup = renderToStaticMarkup(React.createElement(TeamModelPolicyCard, { view: 'page', t: createTranslator('zh'), useTeamModelPolicyCard: selector => selector(f.card.getSnapshot()) }));
  assert.match(markup, /跟随子智能体模型设置/); assert.match(markup, /固定模型/); assert.match(markup, /data-default-effort="max"/);
});
test('fixed route edits persist atomically under the original revision', async t => {
  const f = fixture(); t.after(() => f.card.dispose()); f.card.setMode('fixed');
  assert.equal(f.card.getSnapshot().invalid, true);
  f.card.edit('provider', 'p'); f.card.edit('model', 'flash'); f.card.edit('reasoningEffort', 'max');
  assert.equal(await f.card.save(), true); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].revision, 5);
  assert(f.writes[0].ops.some(op => op.path[0] === 'reasoningEffort' && op.value === 'max'));
});
test('a concurrent Host edit refuses a stale draft and preserves it for correction', async t => {
  const f = fixture(); t.after(() => f.card.dispose()); f.card.setMode('fixed'); f.card.edit('provider', 'p'); f.card.edit('model', 'flash');
  f.update(); assert.equal(await f.card.save(), false); assert.equal(f.card.getSnapshot().failed, true); assert.equal(f.card.getSnapshot().provider.text, 'p');
});
test('distributed client factory loads using only shared platform modules', () => {
  let registration; const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value; } } } });
  assert.equal(registration.id, 'dsh-team-model-policy');
  const plugin = registration.factory(name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return require('react-dom');
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives');
    return { SettingsForm: () => null };
  });
  assert.equal(typeof plugin.apply, 'function'); assert.equal(plugin.inject.includes('configForms'), true);
});

test('follow default effort is an editable five-level choice and persists independently', async t => {
  const f = fixture(); t.after(() => f.card.dispose());
  const markup = renderToStaticMarkup(React.createElement(TeamModelPolicyCard, {
    view: 'page', t: createTranslator('zh'), useTeamModelPolicyCard: selector => selector(f.card.getSnapshot()),
  }));
  assert.match(markup, /<select[^>]+id="team-model-policy-default-effort"/);
  for (const value of ['max', 'high', 'medium', 'low', 'off']) assert(markup.includes('value="' + value + '"'));
  f.card.edit('defaultReasoningEffort', 'high');
  assert.equal(f.card.getSnapshot().defaultEffort, 'high');
  assert.equal(await f.card.save(), true);
  assert.deepEqual(f.writes[0].ops, [{ op: 'set', path: ['defaultReasoningEffort'], value: 'high' }]);
  assert.equal(f.card.getSnapshot().mode, 'follow-subagent');
  f.card.edit('defaultReasoningEffort', 'max');
  assert.equal(await f.card.save(), true);
  assert.equal(f.card.getSnapshot().defaultEffort, 'max');
});
test('retired members disappear while tasks and failure evidence remain visible', () => {
  const team = { members: [{ id: 'lead-id', name: 'lead', role: 'lead' }, { id: 'child-id', name: 'worker', role: 'teammate' }], tasks: [{ id: 'task-1' }] };
  const filtered = visibleTeam(team, { members: [{ id: 'child-id', name: 'worker', phase: 'removed', releasedTasks: ['task-1'] }] });
  assert.deepEqual(filtered.members.map(member => member.name), ['lead']);
  assert.deepEqual(filtered.tasks, team.tasks);
  const failed = visibleTeam(team, { members: [{ id: 'child-id', name: 'worker', phase: 'removed', releasedTasks: [], error: 'cleanup incomplete' }], failure: 'projection failure' });
  assert.deepEqual(failed.members.map(member => member.name), ['lead']);
  assert.equal(failed.failure, 'projection failure');
});
