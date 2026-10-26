import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCurrent, currentAuthorization, listCurrentModels } from '../authorization.mjs';
const signal = new AbortController().signal;
function fixture() {
  let preference = { enabled: true, allowedModels: [{ provider: 'a', model: 'flash' }] };
  const ctx = { get: name => name === 'subagentModelSelection' ? { current: () => preference } : undefined,
    llm: { listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      listModels: async () => [{ id: 'flash', name: 'Flash' }, { id: 'glm-5.3', name: 'GLM' }],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model,
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'off', name: 'Off' }], defaultEffort: 'max' } }) } };
  return { ctx, set: value => { preference = value; } };
}
test('new provider becomes discoverable and selectable without changing a Session', async () => {
  const f = fixture();
  assert.deepEqual((await listCurrentModels(f.ctx, {}, signal)).providers.map(p => p.id), ['a']);
  assert.throws(() => authorizeCurrent(f.ctx, { provider: 'b', model: 'glm-5.3' }), { code: 'TEAM_MODEL_ROUTE_NOT_ALLOWED' });
  f.set({ enabled: true, allowedModels: [{ provider: 'a', model: 'flash' }, { provider: 'b', model: 'glm-5.3' }] });
  assert.deepEqual((await listCurrentModels(f.ctx, {}, signal)).providers.map(p => p.id), ['a', 'b']);
  assert.equal(authorizeCurrent(f.ctx, { provider: 'b', model: 'glm-5.3', reasoningEffort: 'max' }).model, 'glm-5.3');
  assert.deepEqual((await listCurrentModels(f.ctx, { provider: 'b' }, signal)).models.map(m => m.id), ['glm-5.3']);
  assert.equal((await listCurrentModels(f.ctx, { provider: 'b', model: 'glm-5.3' }, signal)).reasoningEfforts[1].id, 'off');
});
test('removal and disabling immediately refuse future route choices', async () => {
  const f = fixture();
  const choice = { provider: 'a', model: 'flash' }; authorizeCurrent(f.ctx, choice);
  f.set({ enabled: true, allowedModels: [{ provider: 'b', model: 'glm-5.3' }] });
  assert.throws(() => authorizeCurrent(f.ctx, choice), { code: 'TEAM_MODEL_ROUTE_NOT_ALLOWED' });
  f.set({ enabled: false, allowedModels: [{ provider: 'a', model: 'flash' }] });
  assert.throws(() => authorizeCurrent(f.ctx, choice), { code: 'TEAM_MODEL_SELECTION_DISABLED' });
  assert.deepEqual((await listCurrentModels(f.ctx, {}, signal)).providers, []);
});
test('provider and model are checked as an exact pair', () => {
  const f = fixture(); f.set({ enabled: true, allowedModels: [{ provider: 'b', model: 'flash' }] });
  assert.throws(() => authorizeCurrent(f.ctx, { provider: 'a', model: 'flash' }), { code: 'TEAM_MODEL_ROUTE_NOT_ALLOWED' });
  assert.throws(() => authorizeCurrent(f.ctx, { provider: 'b' }), { code: 'CHOICES_INVALID_ROUTE' });
});
test('revocation during discovery is observed before returning exact model capabilities', async () => {
  const f = fixture();
  f.ctx.llm.resolveModelInfo = async () => { f.set({ enabled: false, allowedModels: [] }); return { id: 'flash', name: 'Flash' }; };
  await assert.rejects(listCurrentModels(f.ctx, { provider: 'a', model: 'flash' }, signal), { code: 'TEAM_MODEL_SELECTION_DISABLED' });
});
test('missing settings owner reports disabled and discovery requires provider with a model', async () => {
  const f = fixture(); f.ctx.get = () => undefined;
  assert.deepEqual(currentAuthorization(f.ctx), { enabled: false, routes: [] });
  await assert.rejects(listCurrentModels(f.ctx, { model: 'flash' }, signal), /model requires provider/);
});
