/** Fixed LLM route for named teammates on the request-waterfall DSH runtime. */
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
  const route = parseRoute(config);
  const label = route.provider + '/' + route.model;
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
  const preflight = async signal => {
    const resolved = await ctx.llm.resolveCallConfig(route, signal);
    signal.throwIfAborted();
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
    const selection = actual ?? (member.role === 'teammate' ? route : live?.options);
    return {
      ...rest,
      ...(selection?.model === undefined ? {} : { model: selection.model }),
      diagnostics: actual === undefined
        ? [...row.diagnostics, 'No member request is recorded; model is the next configured selection.']
        : member.role === 'teammate' && (actual.provider !== route.provider || actual.model !== route.model)
          ? [...row.diagnostics, 'Next request is pinned to ' + label + '; model reports the latest recorded request.']
          : row.diagnostics,
    };
  };

  ctx.effect(function* () {
    yield ctx.on('agent/created', ({ agent, signal }) => {
      if (!teammate(agent)) return;
      checkRuntime(agent);
      return track(signal, async linked => {
        await preflight(linked);
      });
    });
    yield ctx.on('agent/request', ({ agent, signal }, next) => {
      if (!teammate(agent)) return next();
      checkRuntime(agent);
      return track(signal, async linked => {
        const original = await next();
        linked.throwIfAborted();
        const resolved = await preflight(linked);
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
      text: 'Named teammates use ' + label + '. The Lead keeps its own model selection. Existing teammates use this route from their next request.',
    });
    yield ctx.effect(() => async () => {
      closed = true;
      shutdown.abort(new TeamModelPolicyError('The team model policy is unloading.', 'POLICY_UNLOADING'));
      await Promise.allSettled([...pending]);
    });
  });
}
