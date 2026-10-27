import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
export const name = 'team-model-policy-fixture';
export const inject = ['llm', 'agents', 'agentTeams', 'tools', 'profileContext'];
const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const call = (ordinal, name, args) => {
  const id = 'audit-call-' + ordinal;
  const argumentsJson = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
};
export function apply(ctx, config) {
  let step = 0;
  const childSteps = new Map();
  const workerReady = Promise.withResolvers();
  let archivePause;
  const record = value => appendFileSync(config.output, JSON.stringify(value) + '\n');
  const resolveModel = async (provider, model) => {
    if (!['gpt-6.1-sol', 'deepseek-v4.1-flash', 'glm-5.3'].includes(model)) throw new Error('Unknown audit model: ' + model);
    const effort = model === 'gpt-6.1-sol' ? 'max' : 'off';
    return { provider, id: model, name: model, reasoning: { efforts: ['max', 'high', 'off'].map(id => ({ id, name: id })), defaultEffort: effort } };
  };
  const adapter = {
    providerInfo: id => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [{ id: 'gpt-6.1-sol', name: 'GPT fixture' }, { id: 'deepseek-v4.1-flash', name: 'Flash fixture' }],
    resolveModel,
    prepareCall: async (provider, model) => ({ model: await resolveModel(provider, model), stream: options => adapter.stream(options) }),
    async * stream(options) {
      const agent = ctx.agents.requireInitiator();
      const membership = ctx.agentTeams.membership(agent);
      record({ kind: 'request', id: agent.id, role: membership.role, name: membership.name,
        provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });
      let chunks;
      if (membership.role === 'teammate') {
        if (['retire-running', 'retire-command', 'retire-reload'].includes(config.mode) && membership.name === 'first') {
          const turn = childSteps.get(agent.id) ?? 0; childSteps.set(agent.id, turn + 1);
          if (turn === 0) chunks = call(700, 'team_task_update', { task_id: 'task-1', expected_revision: 1, action: 'claim' });
          else if (turn === 1) chunks = call(701, 'audit_start_owned_job', {});
          else {
            if (options.signal === undefined) throw new Error('Missing real request cancellation signal');
            record({ kind: 'worker-running', id: agent.id }); workerReady.resolve();
            await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
            record({ kind: 'worker-stopped', id: agent.id }); options.signal.throwIfAborted();
          }
        } else chunks = text('AUDIT_CHILD_DONE');
      }
      else {
        const i = step++;
        if (['retire-running', 'retire-command', 'retire-reload'].includes(config.mode)) {
          const steps = [
            ['team_task_create', { subject: 'unfinished assigned task', description: 'Must return to pending unassigned when its worker is removed.' }],
            ['create_teammate', { name: 'first', description: 'running worker', prompt: 'AUDIT_CLAIM_AND_WAIT', provider: 'route-audit', model: 'deepseek-v4.1-flash' }],
            ['audit_worker_barrier', {}],
            ['create_teammate', { name: 'second', description: 'unaffected worker', prompt: 'AUDIT_OTHER_WORKER', provider: 'route-audit', model: 'deepseek-v4.1-flash' }],
            [config.mode === 'retire-command' ? 'audit_remove_command' : config.mode === 'retire-reload' ? 'audit_remove_reload' : 'remove_teammate', { target: 'first' }],
            ['list_agents', {}],
            ['team_task_get', { task_id: 'task-1' }],
            ['send_message', { target: 'first', message: 'AUDIT_MUST_NOT_WAKE' }],
            ['audit_direct_send', { target: 'first' }],
            ['remove_teammate', { target: 'first' }],
            ['remove_teammate', { target: 'lead' }],
            ['audit_retirement_state', {}],
            ['send_message', { target: 'second', message: 'AUDIT_UNAFFECTED_MEMBER' }],
          ];
          chunks = steps[i] ? call(i, steps[i][0], steps[i][1]) : text('AUDIT_FINISHED');
        } else if (config.mode === 'retire-resume') {
          const steps = [['list_agents', {}], ['remove_teammate', { target: 'first' }],
            ['send_message', { target: 'first', message: 'AUDIT_COLD_MUST_NOT_WAKE' }],
            ['audit_direct_send', { target: 'first' }], ['audit_retirement_state', {}],
            ['send_message', { target: 'second', message: 'AUDIT_COLD_UNAFFECTED' }]];
          chunks = steps[i] ? call(i, steps[i][0], steps[i][1]) : text('AUDIT_FINISHED');
        } else if (config.mode === 'dynamic') {
          const steps = [
            ['create_teammate', { name: 'first', description: 'existing teammate', prompt: 'AUDIT_CHILD_FIRST', provider: 'route-audit', model: 'deepseek-v4.1-flash' }],
            ['list_teammate_models', {}],
            ['audit_model_selection', { stage: 'add-provider' }],
            ['list_teammate_models', {}],
            ['list_teammate_models', { provider: 'other-audit', model: 'glm-5.3' }],
            ['set_teammate_model', { target: 'first', provider: 'other-audit', model: 'glm-5.3', reasoning_effort: 'high' }],
            ['send_message', { target: 'first', message: 'AUDIT_CHILD_USE_NEW_PROVIDER' }],
            ['create_teammate', { name: 'second', description: 'new provider default effort', prompt: 'AUDIT_CHILD_SECOND', provider: 'other-audit', model: 'glm-5.3' }],
            ['audit_model_selection', { stage: 'remove-provider' }],
            ['list_teammate_models', {}],
            ['set_teammate_model', { target: 'first', provider: 'other-audit', model: 'glm-5.3' }],
            ['send_message', { target: 'first', message: 'AUDIT_CHILD_MUST_BE_BLOCKED' }],
            ['list_agents', {}],
            ['set_teammate_model', { target: 'first', provider: 'route-audit', model: 'gpt-6.1-sol', reasoning_effort: 'off' }],
            ['send_message', { target: 'first', message: 'AUDIT_CHILD_RECOVER' }],
            ['audit_model_selection', { stage: 'disable' }],
            ['list_teammate_models', {}],
            ['set_teammate_model', { target: 'second', provider: 'route-audit', model: 'gpt-6.1-sol' }],
          ];
          chunks = steps[i] ? call(i, steps[i][0], steps[i][1]) : text('AUDIT_FINISHED');
        } else if (config.mode === 'follow') {
          chunks = i === 0 ? call(i, 'create_teammate', { name: 'first', description: 'default max fixture', prompt: 'AUDIT_CHILD_FIRST', provider: 'route-audit', model: 'deepseek-v4.1-flash' })
            : i === 1 ? call(i, 'create_teammate', { name: 'second', description: 'explicit off fixture', prompt: 'AUDIT_CHILD_SECOND', context: 'fork', provider: 'route-audit', model: 'deepseek-v4.1-flash', reasoning_effort: 'off' })
            : i === 2 ? call(i, 'set_teammate_model', { target: 'first', provider: 'route-audit', model: 'gpt-6.1-sol', reasoning_effort: 'high' })
            : i === 3 ? call(i, 'send_message', { target: 'first', message: 'AUDIT_CHILD_CHANGED' })
            : i === 4 ? call(i, 'list_agents', {}) : text('AUDIT_FINISHED');
        } else if (config.mode === 'resume') {
          chunks = i === 0 ? call(i, 'send_message', { target: 'first', message: 'AUDIT_CHILD_RESUME_FIRST' })
            : i === 1 ? call(i, 'send_message', { target: 'second', message: 'AUDIT_CHILD_RESUME_SECOND' })
            : i === 2 ? call(i, 'list_agents', {}) : text('AUDIT_FINISHED');
        } else if (config.mode === 'invalid-route') {
          chunks = i === 0 ? call(i, 'spawn_teammate', { name: 'first', description: 'route failure control', prompt: 'AUDIT_CHILD_FIRST' })
            : text('AUDIT_FINISHED');
        } else {
          chunks = i === 0 ? call(i, 'list_agents', {})
            : i === 1 ? call(i, 'spawn_teammate', { name: 'first', description: 'fresh fixture', prompt: 'AUDIT_CHILD_FIRST' })
            : i === 2 ? call(i, 'spawn_teammate', { name: 'second', description: 'fork fixture', prompt: 'AUDIT_CHILD_SECOND', context: 'fork' })
            : i === 3 ? call(i, 'list_agents', {}) : text('AUDIT_FINISHED');
        }
      }
      for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
    },
  };
  ctx.llm.registerAdapter(['route-audit', 'other-audit'], adapter);
  const { defineTool } = createRequire(ctx.profileContext.installAnchor)('@deepseek-ai/dsh-tools');
  const jsonOutput = { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.on('workspace/session-stop', async ({ sessionId }) => {
    if (archivePause?.target !== sessionId) return;
    archivePause.entered.resolve(); await archivePause.release.promise;
  });
  ctx.tools.register(defineTool({ name: 'audit_remove_command', description: 'Run the same command as the roster button.',
    parameters: { target: { type: 'string', required: true } }, output: jsonOutput,
    async execute(args, exec) {
      const outcome = await ctx.get('commands').execute(exec.agent, '/team-remove ' + args.target, [], exec.signal);
      if (outcome?.result.kind !== 'success') throw new Error(outcome?.result.text ?? 'Missing retirement command');
      return { removed: true, commandSuccess: true };
    } }));
  ctx.tools.register(defineTool({ name: 'audit_remove_reload', description: 'Reload the removal provider while an admitted archive is paused.',
    parameters: { target: { type: 'string', required: true } }, output: jsonOutput,
    async execute(args, exec) {
      const old = ctx.get('teamRetirements');
      const member = ctx.agentTeams.listMembers(exec.agent).find(m => m.name === args.target);
      archivePause = { target: member.id, entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const attempt = old.remove(exec.agent, args.target, exec.signal).then(value => ({ value }), error => ({ error: error.message }));
      await archivePause.entered.promise;
      const entry = [...ctx.get('loader').entries()].find(e => e.options.id === 'audit-retirements');
      if (!entry) throw new Error('Removal provider entry unavailable');
      record({ kind: 'reload-effects', effects: entry.fiber.getEffects() });
      let finished = false;
      const restart = Promise.resolve(entry.fiber.restart()).then(() => { finished = true; });
      try {
        const deadline = Date.now() + 10000;
        while (!old.closing && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
        if (!old.closing || finished) throw new Error('Reload did not wait for the admitted removal');
        if (!ctx.get('sessionProjections').snapshot(exec.agent.session).values.teamRetirements) throw new Error('Projection released before admitted cleanup settled');
        record({ kind: 'reload-barrier', waited: true, projectionAlive: true });
      } finally { archivePause.release.resolve(); }
      const outcome = await attempt; await restart; archivePause = undefined;
      const current = ctx.get('teamRetirements');
      if (!current || current === old || !outcome.error) throw new Error('Removal provider was not replaced cleanly');
      const result = await current.remove(exec.agent, args.target, exec.signal);
      record({ kind: 'reload-completed', recovered: result.removed, interruptedOutcome: outcome.error });
      return result;
    } }));
  ctx.tools.register(defineTool({ name: 'audit_start_owned_job', description: 'Start an actual owned background worker.', parameters: {}, output: jsonOutput,
    execute(_args, exec) {
      const jobId = ctx.get('jobs').start({ kind: 'bash', label: 'retirement owned worker thread', owner: exec.agent.id,
        run() {
          const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
          const done = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', code => { record({ kind: 'owned-job-exit', code }); resolve({ status: 'killed' }); }); });
          return { done, cancel() { void worker.terminate(); } };
        } });
      record({ kind: 'owned-job-start', jobId, owner: exec.agent.id }); return { jobId };
    } }));
  ctx.tools.register(defineTool({ name: 'audit_worker_barrier', description: 'Wait for the real claimed worker request.', parameters: {}, output: jsonOutput,
    async execute() { await workerReady.promise; return { workerRunning: true }; } }));
  ctx.tools.register(defineTool({ name: 'audit_direct_send', description: 'Probe direct service delivery after retirement.',
    parameters: { target: { type: 'string', required: true } }, output: jsonOutput,
    async execute(args, exec) {
      try { await ctx.agentTeams.sendMessage(exec.agent, { target: args.target, content: [{ type: 'text', text: 'AUDIT_DIRECT_MUST_NOT_WAKE' }], signal: exec.signal }); return { blocked: false }; }
      catch (error) { return { blocked: true, message: error instanceof Error ? error.message : String(error) }; }
    } }));
  ctx.tools.register(defineTool({ name: 'audit_retirement_state', description: 'Read actual retirement and native projections.', parameters: {}, output: jsonOutput,
    async execute(_args, exec) {
      const rawMembers = ctx.agentTeams.listMembers(exec.agent);
      const child = rawMembers.find(row => row.name === 'first');
      const result = { rawMembers, archived: ctx.get('workspaceRegistry').archivedSessionIds.includes(child.id),
        childResident: ctx.agents.get(child.id) !== undefined, snapshot: await ctx.get('sessionProjections').snapshot(exec.agent.session) };
      record({ kind: 'retirement-state', ...result }); return result;
    } }));
  // Test-only simulation of a user saving the real Subagent settings namespace.
  ctx.tools.register(defineTool({ name: 'audit_model_selection', description: 'Save isolated test model settings.',
    parameters: { stage: { type: 'string', required: true, enum: ['add-provider', 'remove-provider', 'disable'] } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const owner = ctx.get('settings');
      const namespace = 'audit-model-selection-policy';
      const current = (await owner.describe()).find(row => row.ns === namespace);
      if (current === undefined) throw new Error('Real Subagent settings are not exposed');
      const routes = [{ provider: 'route-audit', model: 'gpt-6.1-sol' }, { provider: 'route-audit', model: 'deepseek-v4.1-flash' },
        ...(args.stage === 'add-provider' ? [{ provider: 'other-audit', model: 'glm-5.3' }] : [])];
      await owner.mutate(namespace, [{ op: 'set', path: ['allowedModels'], value: routes },
        { op: 'set', path: ['enabled'], value: args.stage !== 'disable' }], current.revision);
      const result = { stage: args.stage, preference: ctx.get('subagentModelSelection').current(),
        sessionPolicies: exec.agent.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy').map(event => event.data.allowedModels) };
      record({ kind: 'saved-policy', ...result }); return result;
    },
  }));
  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next();
    if (ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return proposal;
    return { ...proposal, provider: 'route-audit', model: 'gpt-6.1-sol', reasoningEffort: config.mode === 'native-follow' ? 'off' : 'max' };
  });
  ctx.on('tools/result', (exec, result) => {
    if (['list_agents', 'spawn_teammate', 'send_message', 'create_teammate', 'set_teammate_model', 'list_teammate_models', 'audit_model_selection', 'remove_teammate', 'team_task_create', 'team_task_get', 'team_task_update', 'audit_worker_barrier', 'audit_direct_send', 'audit_retirement_state', 'audit_start_owned_job', 'audit_remove_command', 'audit_remove_reload'].includes(exec.name)) {
      record({ kind: 'tool', tool: exec.name, isError: result.isError,
        ...(result.isError ? { error: result.error } : { value: result.value }) });
    }
  });
}
