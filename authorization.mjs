import { normalizedRoute } from './choices.mjs';

/** Current, saved Subagent settings. Session snapshots remain historical data. */
export function currentAuthorization(ctx) {
  const owner = ctx.get('subagentModelSelection');
  if (typeof owner?.current !== 'function') return { enabled: false, routes: [] };
  const preference = owner.current();
  if (!preference.enabled) return { enabled: false, routes: [] };
  return { enabled: true, routes: preference.allowedModels.map(route => ({ provider: route.provider, model: route.model })) };
}

/** Validate an explicit or inherited teammate route against the latest user selection. */
export function authorizeCurrent(ctx, route) {
  const choice = normalizedRoute(route);
  const policy = currentAuthorization(ctx);
  if (!policy.enabled) throw Object.assign(new Error('Enable model selection in Subagent settings before choosing teammate models.'), { code: 'TEAM_MODEL_SELECTION_DISABLED' });
  if (!policy.routes.some(candidate => candidate.provider === choice.provider && candidate.model === choice.model)) {
    throw Object.assign(new Error('Route "' + choice.provider + '/' + choice.model + '" is not currently authorized. Refresh list_teammate_models after saving Subagent settings.'), { code: 'TEAM_MODEL_ROUTE_NOT_ALLOWED' });
  }
  return choice;
}

/** Discover currently registered, allowed teammate models and their reasoning efforts. */
export async function listCurrentModels(ctx, request, signal) {
  if (request.model !== undefined && request.provider === undefined) throw new Error('model requires provider');
  const policy = currentAuthorization(ctx);
  const providers = ctx.llm.listProviders().filter(provider => policy.routes.some(route => route.provider === provider.id));
  if (request.provider === undefined) return { source: 'live-subagent-settings', enabled: policy.enabled,
    providers: providers.map(provider => ({ id: provider.id, name: provider.name })), routes: policy.routes };
  const routes = policy.routes.filter(route => route.provider === request.provider);
  if (!policy.enabled || routes.length === 0) throw Object.assign(new Error('This provider is not currently authorized in Subagent settings.'), { code: 'TEAM_MODEL_ROUTE_NOT_ALLOWED' });
  const provider = providers.find(candidate => candidate.id === request.provider);
  if (provider === undefined) throw new Error('The selected provider is not registered: ' + request.provider);
  if (request.model === undefined) {
    const models = await ctx.llm.listModels(provider.id);
    signal.throwIfAborted();
    const allowed = currentAuthorization(ctx);
    return { source: 'live-subagent-settings', provider: provider.id,
      models: models.filter(model => allowed.enabled && allowed.routes.some(route => route.provider === provider.id && route.model === model.id))
        .map(model => ({ id: model.id, name: model.name, ...(model.description === undefined ? {} : { description: model.description }) })) };
  }
  authorizeCurrent(ctx, { provider: provider.id, model: request.model });
  const model = await ctx.llm.resolveModelInfo(provider.id, request.model, signal);
  signal.throwIfAborted();
  authorizeCurrent(ctx, { provider: provider.id, model: request.model });
  return { source: 'live-subagent-settings', provider: provider.id, model: model.id, name: model.name,
    reasoningEfforts: model.reasoning?.efforts?.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
    ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort }) };
}
