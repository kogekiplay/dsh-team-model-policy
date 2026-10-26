/** Team-specific model policy and effective-model reporting. */
import { readSettings } from './settings.mjs';
import { authorizeCurrent, currentAuthorization } from './authorization.mjs';
export { Config } from './settings.mjs';
export const name = 'team-model-policy';
export const inject = ['agents', 'agentTeams', 'llm', 'tools', 'systemPrompt', 'sessionPersistence'];

/** A configuration, runtime-compatibility, or policy-lifecycle refusal. */
export class TeamModelPolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TeamModelPolicyError';
    this.code = code;
  }
}

/** Validate the complete host-owned route; omitted effort uses adapter defaults. */
export function parseRoute(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TeamModelPolicyError('Configure provider and model before enabling team-model-policy.', 'INVALID_CONFIG');
  }
  for (const key of Object.keys(config)) {
    if (!['provider', 'model', 'reasoningEffort'].includes(key)) {
      throw new TeamModelPolicyError('Only provider, model and reasoningEffort are accepted.', 'INVALID_CONFIG');
    }
  }
  for (const key of ['provider', 'model']) {
    if (typeof config[key] !== 'string' || config[key].trim() !== config[key] || config[key].length === 0) {
      throw new TeamModelPolicyError('provider and model must be non-empty ids without surrounding whitespace.', 'INVALID_CONFIG');
    }
  }
  if (config.reasoningEffort !== undefined && (typeof config.reasoningEffort !== 'string' || config.reasoningEffort.length === 0)) {
    throw new TeamModelPolicyError('reasoningEffort must be a non-empty id when supplied.', 'INVALID_CONFIG');
  }
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  });
}

/** Register reversible request and result policies; no Agent is created or woken. */
export function apply(ctx, config) {
  const settings = () => readSettings(config);
  let choiceStore;
  let choiceModule;
  const choices = async () => {
    choiceModule ??= import('./choices.mjs');
    choiceStore ??= choiceModule.then(module => module.createChoices({ storageDomain: ctx.get('storageDomain'), profileContext: ctx.get('profileContext') }));
    return await choiceStore;
  };
  const configuredRoute = async (caller, member, validate = true) => {
    const state = settings();
    if (state.mode === 'fixed') return parseRoute({ provider: state.provider, model: state.model,
      ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}) });
    const membership = ctx.agentTeams.membership(caller);
    const stored = await (await choices()).load(membership.root.id, member.name);
    if (stored === undefined) return undefined;
    const route = { ...stored, reasoningEffort: stored.reasoningEffort ?? state.defaultReasoningEffort };
    return validate ? authorizeCurrent(ctx, route) : route;
  };
  ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)));
  const shutdown = new AbortController();
  const pending = new Set();
  let closed = false;

  const teammate = agent => agent !== undefined && ctx.agentTeams.tryMembership(agent)?.role === 'teammate';
  const checkRuntime = agent => {
    if (agent.model !== undefined) {
      throw new TeamModelPolicyError('This plugin requires the request-waterfall DSH runtime; Agent.model runtimes need a newer plugin.', 'UNSUPPORTED_RUNTIME');
    }
  };
  const track = (signal, body) => {
    if (closed) return Promise.reject(new TeamModelPolicyError('The team model policy is unloading.', 'POLICY_UNLOADING'));
    const combined = signal === undefined ? shutdown.signal : AbortSignal.any([signal, shutdown.signal]);
    const operation = (async () => {
      combined.throwIfAborted();
      return await body(combined);
    })();
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const preflight = async (route, signal) => {
    const follow = settings().mode === 'follow-subagent';
    if (follow) authorizeCurrent(ctx, route);
    const resolved = await ctx.llm.resolveCallConfig(route, signal);
    signal.throwIfAborted();
    if (follow) authorizeCurrent(ctx, route);
    if (resolved.provider !== route.provider || resolved.model !== route.model) {
      throw new TeamModelPolicyError('The LLM adapter resolved a different teammate route.', 'ROUTE_MISMATCH');
    }
    return resolved;
  };
  const lastRequest = events => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'request/header') return events[i].data.header.config;
    }
    return undefined;
  };
  const fixMember = async (row, members, signal) => {
    const member = members.find(candidate => candidate.name === row.target);
    if (member === undefined || member.status === 'failed' || member.status === 'provisioning') return row;
    const live = ctx.agents.get(member.id);
    let actual;
    if (live !== undefined) {
      actual = lastRequest(live.session.snapshotEvents(live.session.inheritedEventCount));
    } else {
      const handle = await ctx.sessionPersistence.open(member.id, 'read', { signal });
      try {
        const stored = await handle.read();
        signal.throwIfAborted();
        actual = lastRequest(stored.events.slice(stored.inheritedEventCount));
      } finally {
        await handle.close();
      }
    }
    const { model: _oldModel, ...rest } = row;
    const planned = member.role === 'teammate' ? await configuredRoute(members.caller, member, false) : live?.options;
    const selection = actual ?? planned;
    const label = planned === undefined ? '' : planned.provider + '/' + planned.model;
    const policy = settings().mode === 'follow-subagent' ? currentAuthorization(ctx) : undefined;
    const candidate = planned ?? actual;
    const blocked = member.role === 'teammate' && policy !== undefined && candidate !== undefined
      && (!policy.enabled || !policy.routes.some(route => route.provider === candidate.provider && route.model === candidate.model));
    return {
      ...rest,
      ...(selection?.model === undefined ? {} : { model: selection.model }),
      diagnostics: blocked ? [...row.diagnostics, 'This route is no longer authorized. Refresh list_teammate_models and choose an allowed route before the next request.'] : actual === undefined
        ? [...row.diagnostics, 'No member request is recorded; model is the next configured selection.']
        : member.role === 'teammate' && planned !== undefined && (actual.provider !== planned.provider || actual.model !== planned.model)
          ? [...row.diagnostics, 'Next request is pinned to ' + label + '; model reports the latest recorded request.']
          : row.diagnostics,
    };
  };

  ctx.inject(['profileContext', 'storageDomain'], child => child.effect(async () => {
    const { registerModelTools } = await import('./model-tools.mjs');
    return await registerModelTools(child, { settings, choices, track });
  }));

  ctx.effect(function* () {
    yield ctx.on('agent/created', async ({ agent, signal }) => {
      if (!teammate(agent)) {
        if (settings().mode === 'follow-subagent' && ctx.agentTeams.tryMembership(agent)?.role === 'lead'
          && agent.session.firstLiveSeq === 0 && agent.session.eventAt(0)?.type !== 'session/end-seed') {
          const { allowedRoutes } = await import('./choices.mjs');
          if (allowedRoutes(agent.session) === undefined) {
            const owner = ctx.get('subagentModelSelection');
            const preference = typeof owner?.current === 'function' ? owner.current() : undefined;
            if (preference?.enabled) agent.session.append('subagent/model-selection-policy', { allowedModels: preference.allowedModels });
          }
        }
        return;
      }
      checkRuntime(agent);
      return track(signal, async linked => {
        const membership = ctx.agentTeams.membership(agent);
        const route = await configuredRoute(agent, membership);
        if (route !== undefined) await preflight(route, linked);
      });
    });
    yield ctx.on('agent/request', ({ agent, signal }, next) => {
      if (!teammate(agent)) return next();
      checkRuntime(agent);
      return track(signal, async linked => {
        const original = await next();
        linked.throwIfAborted();
        const membership = ctx.agentTeams.membership(agent);
        const route = await configuredRoute(agent, membership);
        if (route === undefined) {
          if (lastRequest(agent.session.snapshotEvents(agent.session.inheritedEventCount)) === undefined) {
            return await preflight({ ...original, reasoningEffort: settings().defaultReasoningEffort }, linked);
          }
          authorizeCurrent(ctx, original);
          return original;
        }
        const resolved = await preflight(route, linked);
        const { reasoningEffort: _oldEffort, ...controls } = original;
        return {
          ...controls,
          provider: resolved.provider,
          model: resolved.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        };
      });
    }, { prepend: true });
    yield ctx.on('tools/post-execute', (exec, result, next) => {
      if (result.isError || exec.agent === undefined
        || !['list_agents', 'spawn_teammate'].includes(exec.name)) return next();
      return track(exec.signal, async linked => {
        const decision = await next();
        linked.throwIfAborted();
        if (decision.kind !== 'accept' || decision.content !== undefined) return decision;
        const members = ctx.agentTeams.listMembers(exec.agent);
        members.caller = exec.agent;
        const value = decision.value === undefined ? result.value : decision.value;
        if (exec.name === 'list_agents') {
          if (!Array.isArray(value)) throw new TeamModelPolicyError('Unexpected list_agents output.', 'UNSUPPORTED_OUTPUT');
          const rows = await Promise.allSettled(value.map(row => fixMember(row, members, linked)));
          const failure = rows.find(row => row.status === 'rejected');
          if (failure !== undefined) throw failure.reason;
          return { ...decision, value: rows.map(row => row.value) };
        }
        if (value === null || typeof value !== 'object' || value.member === undefined) {
          throw new TeamModelPolicyError('Unexpected spawn_teammate output.', 'UNSUPPORTED_OUTPUT');
        }
        return { ...decision, value: { ...value, member: await fixMember(value.member, members, linked) } };
      });
    });
    yield ctx.systemPrompt.section({
      name: 'team:model-policy',
      order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: () => settings().mode === 'fixed'
        ? 'Named teammates use the fixed Team model settings. Model and effort changes apply to their next request. The Lead keeps its own model selection.'
        : 'Use create_teammate to choose an authorized model and reasoning effort when creating a named teammate. Use set_teammate_model to change an existing teammate for its next request. Run list_teammate_models to refresh the latest user-authorized providers, models and reasoning efforts. Changes saved in Subagent settings apply to this existing Team immediately; removed routes are refused for future requests. Native ordinary-subagent tools keep their own Session policy.',
    });
    yield ctx.effect(() => async () => {
      closed = true;
      shutdown.abort(new TeamModelPolicyError('The team model policy is unloading.', 'POLICY_UNLOADING'));
      await Promise.allSettled([...pending]);
      if (choiceStore !== undefined) await (await choiceStore).close();
    });
  });
}
