/** Team-specific model policy and effective-model reporting. */
import { readSettings } from './settings.mjs';
import { authorizeCurrent, currentAuthorization } from './authorization.mjs';
import { registerModelTools } from './model-tools.mjs';
import { registerTeamCapacity } from './team-capacity.mjs';
import { registerTeammateAccess } from './teammate-access.mjs';
export { Config } from './settings.mjs';
export const name = 'team-model-policy';
export const inject = ['agents', 'agentTeams', 'llm', 'tools', 'systemPrompt', 'sessionPersistence', 'teamRetirements'];

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
  let readyChoices;
  let settingsEpoch = 0;
  const choices = async () => {
    choiceModule ??= import('./choices.mjs');
    choiceStore ??= choiceModule.then(module => module.createChoices({ storageDomain: ctx.get('storageDomain'), profileContext: ctx.get('profileContext') }));
    readyChoices = await choiceStore;
    return readyChoices;
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
    if (typeof agent.model?.current !== 'function' || typeof agent.model?.select !== 'function') {
      throw new TeamModelPolicyError('This plugin requires DSH 0.2.2-rc.1 with Agent.model selection.', 'UNSUPPORTED_RUNTIME');
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
  const sameSelection = (left, right) => left?.provider === right?.provider && left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort;
  const configuredRouteNow = member => {
    const state = settings();
    if (state.mode === 'fixed') return parseRoute({ provider: state.provider, model: state.model,
      ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}) });
    const saved = readyChoices?.load(member.root.id, member.name);
    return saved === undefined ? undefined : authorizeCurrent(ctx, { ...saved, reasoningEffort: saved.reasoningEffort ?? state.defaultReasoningEffort });
  };
  const synchronizeSelections = () => {
    for (const agent of ctx.agents.list?.() ?? []) {
      const member = ctx.agentTeams.tryMembership(agent);
      if (member?.role !== 'teammate') continue;
      try {
        ctx.teamRetirements.assertActive?.(member.root, member.name);
        checkRuntime(agent);
        const route = configuredRouteNow(member);
        if (route !== undefined) agent.model.select(route);
      } catch (error) { ctx.logger.warn('Teammate model update deferred; step validation will refuse invalid choices: ' + String(error)); }
    }
  };
  ctx.on('settings/document-updated', () => { settingsEpoch += 1; synchronizeSelections(); });
  const lastRequest = events => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'request/header') return events[i].data.header.config;
    }
    return undefined;
  };
  // One persisted history at a time across all rosters. JSONL backends may decode
  // the complete log even for a slice, so parallel cold reads multiply peak memory.
  let coldReadTail = Promise.resolve();
  const readColdModel = (id, signal) => {
    const operation = coldReadTail.then(async () => {
      signal.throwIfAborted();
      const handle = await ctx.sessionPersistence.open(id, 'read', { signal });
      try {
        const offset = handle.inheritedEventCount;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TeamModelPolicyError('The stored teammate handle has no valid inherited event count.', 'UNSUPPORTED_RUNTIME');
        const stored = await handle.read(offset, undefined, { signal });
        signal.throwIfAborted();
        return lastRequest(stored.events);
      } finally {
        await handle.close();
      }
    });
    coldReadTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const fixMember = async (row, members, signal) => {
    const member = members.find(candidate => candidate.name === row.target);
    if (member === undefined || member.status === 'failed' || member.status === 'provisioning') return row;
    const live = ctx.agents.get(member.id);
    let actual;
    if (live !== undefined) {
      actual = lastRequest(live.session.snapshotEvents(live.session.inheritedEventCount));
    } else {
      actual = await readColdModel(member.id, signal);
    }
    const { model: _oldModel, ...rest } = row;
    const planned = member.role === 'teammate' ? await configuredRoute(members.caller, member, false) : live?.model?.current() ?? live?.options;
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

  ctx.inject(['profileContext', 'agentTeams', 'teamRetirements'], child => child.effect(() => registerTeamCapacity(child)));
  ctx.inject(['profileContext', 'storageDomain'], child => child.effect(() => {
    const dispose = registerModelTools(child, { settings, choices, track });
    // Register tools before warming storage; existing members are selected only after it is ready.
    void track(undefined, async signal => { await choices(); signal.throwIfAborted(); synchronizeSelections(); })
      .catch(error => { if (!closed) child.logger.warn('Cannot initialize teammate choices: ' + String(error)); });
    return dispose;
  }));
  ctx.inject(['profileContext', 'sandboxPolicy', 'approval'], child => child.effect(() => registerTeammateAccess(child)));

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
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const epoch = settingsEpoch;
          const planned = await configuredRoute(agent, membership);
          const current = agent.model.current();
          const route = planned ?? (lastRequest(agent.session.snapshotEvents(agent.session.inheritedEventCount)) === undefined
            ? { ...current, reasoningEffort: settings().defaultReasoningEffort } : current);
          if (!route?.provider || !route?.model) throw new TeamModelPolicyError('The teammate has no model selection.', 'INVALID_CONFIG');
          await preflight(route, linked);
          if (epoch !== settingsEpoch) continue;
          agent.model.select(route);
          return;
        }
        throw new TeamModelPolicyError('Team model settings changed repeatedly during initialization; retry after saving them.', 'TEAM_MODEL_SETTINGS_CHANGED');
      });
    });
    yield ctx.on('agent/pre-step', ({ agent, signal, modelSelection }, next) => {
      if (!teammate(agent)) return next();
      checkRuntime(agent);
      return track(signal, async linked => {
        // Selection was frozen before this hook. Validate it; never replace or revert it.
        const membership = ctx.agentTeams.membership(agent);
        await configuredRoute(agent, membership);
        const captured = modelSelection ?? agent.model.current();
        const planned = configuredRouteNow(membership);
        if (planned !== undefined && !sameSelection(captured, planned) && !sameSelection(agent.model.current(), planned)) {
          agent.model.select(planned);
          throw new TeamModelPolicyError('The prepared model conflicts with the Team policy. The next selection was restored; retry without overriding the teammate model directly.', 'TEAM_MODEL_POLICY_MISMATCH');
        }
        await preflight(captured, linked);
        return await next();
      });
    }, { prepend: true });
    yield ctx.on('tools/post-execute', (exec, result, next) => {
      if (result.isError || exec.agent === undefined
        || !['list_agents', 'spawn_teammate'].includes(exec.name)) return next();
      return track(exec.signal, async linked => {
        const decision = await next();
        linked.throwIfAborted();
        if (decision.kind !== 'accept' || decision.content !== undefined) return decision;
        const value = decision.value === undefined ? result.value : decision.value;
        // Native ordinary-subagent listing has IDs rather than Team targets.
        if (exec.name === 'list_agents' && Array.isArray(value) && value.some(row => row.kind !== undefined && typeof row.id === 'string')) return decision;
        if (ctx.agentTeams.tryMembership(exec.agent) === undefined) return decision;
        const members = ctx.agentTeams.listMembers(exec.agent);
        members.caller = exec.agent;
        if (exec.name === 'list_agents') {
          if (!Array.isArray(value)) throw new TeamModelPolicyError('Unexpected list_agents output.', 'UNSUPPORTED_OUTPUT');
          const visible = ctx.teamRetirements.visibleRows(exec.agent, value);
          const rows = await Promise.allSettled(visible.map(row => fixMember(row, members, linked)));
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
      name: 'team:member-removal',
      order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: 'For manual cleanup, list_manageable_subagents discovers ordinary child sessions as well as Team members. Use remove_subagent with its session ID, or remove_teammate with a Team name. Removal stops and archives the selected subtree while preserving history; Team removal reclaims unfinished tasks. Do not infer that inactive means unused or remove children automatically.',
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
