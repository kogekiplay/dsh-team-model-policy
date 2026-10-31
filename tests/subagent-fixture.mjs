import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

export const name = 'ordinary-subagent-retirement-fixture';
export const inject = ['llm', 'agents', 'agentTeams', 'tools', 'profileContext', 'subagents', 'workspaceRegistry'];

const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];

const call = (ordinal, name, args) => {
  const id = 'ordinary-audit-call-' + ordinal;
  const argumentsJson = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
};

const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('ordinary fixture timed out waiting for child publication');
    await new Promise(resolve => setImmediate(resolve));
  }
};

export function apply(ctx, config) {
  let rootStep = 0;
  const record = value => appendFileSync(config.output, JSON.stringify(value) + '\n');
  const require = createRequire(ctx.profileContext.installAnchor);
  const { defineTool } = require('@deepseek-ai/dsh-tools');

  const resolveModel = async (provider, model) => {
    if (!['gpt-6.1-sol', 'deepseek-v4.1-flash'].includes(model)) throw new Error('Unknown ordinary audit model: ' + model);
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'max', name: 'max' }, { id: 'off', name: 'off' }], defaultEffort: 'max' },
    };
  };

  const adapter = {
    providerInfo: id => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [{ id: 'gpt-6.1-sol', name: 'GPT ordinary fixture' }, { id: 'deepseek-v4.1-flash', name: 'Flash ordinary fixture' }],
    resolveModel,
    prepareCall: async (provider, model) => ({ model: await resolveModel(provider, model), stream: options => adapter.stream(options) }),
    async *stream(options) {
      const agent = ctx.agents.requireInitiator();
      const membership = ctx.agentTeams.tryMembership(agent);
      const descriptor = agent.session.snapshotEvents().findLast(event => event.type === 'subagent/descriptor')?.data;
      const label = descriptor?.label;
      if (label === undefined) config.rootId = agent.id;
      record({ kind: 'request', id: agent.id, role: membership?.role ?? 'ordinary-subagent', label,
        provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });

      if (label === 'ordinary-target') {
        record({ kind: 'worker-running', id: agent.id });
        if (options.signal === undefined) throw new Error('ordinary target request missing cancellation signal');
        await new Promise(resolve => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', resolve, { once: true });
        });
        record({ kind: 'worker-stopped', id: agent.id });
        options.signal.throwIfAborted();
      }
      yield* label === undefined ? rootNext() : text('ORDINARY_CHILD_DONE');
    },
  };
  ctx.llm.registerAdapter(['route-audit'], adapter);

  const jsonOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

  ctx.tools.register(defineTool({
    name: 'audit_start_ordinary',
    description: 'Start one ordinary native subagent for the retirement fixture.',
    parameters: { role: { type: 'string', required: true, enum: ['target', 'sibling'] }, nested: { type: 'boolean' } },
    output: jsonOutput,
    async execute(args, exec) {
      const label = 'ordinary-' + args.role;
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label,
        request: { parent: exec.agent, prompt: [{ type: 'text', text: 'ORDINARY_AUDIT_CHILD_' + args.role }] },
        signal: exec.signal,
        delivery: 'parent',
      });
      const childId = activation.childId;
      if (args.role === 'target') config.targetId = childId;
      else config.siblingId = childId;
      record({ kind: 'child-started', role: args.role, id: childId });
      if (args.role === 'target') {
        const jobs = ctx.get('jobs');
        if (jobs === undefined) throw new Error('jobs service is required for the ordinary worker check');
        const jobId = jobs.start({ kind: 'bash', label: 'ordinary retirement owned worker', owner: childId,
          run() {
            const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
            const done = new Promise((resolve, reject) => {
              worker.once('error', reject);
              worker.once('exit', code => { record({ kind: 'owned-worker-exit', id: childId, code }); resolve({ status: 'killed' }); });
            });
            return { done, cancel() { void worker.terminate(); } };
          },
        });
        record({ kind: 'owned-worker-start', id: childId, jobId });
      }
      if (args.role === 'target' && args.nested === true) {
        await waitFor(() => ctx.agents.get(childId) !== undefined);
        const parent = ctx.agents.get(childId);
        if (parent === undefined) throw new Error('ordinary target Agent was not published');
        const nested = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: 'ordinary-nested',
          request: { parent, prompt: [{ type: 'text', text: 'ORDINARY_AUDIT_NESTED' }] },
          signal: exec.signal,
          delivery: 'parent',
        });
        record({ kind: 'child-started', role: 'nested', id: nested.childId, parentId: childId });
      }
      return { role: args.role, sessionId: childId, nested: args.nested === true };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'audit_state',
    description: 'Read ordinary-subagent retirement state and native persistence.',
    parameters: { target: { type: 'string', required: true } },
    output: jsonOutput,
    async execute(args, exec) {
      const query = ctx.get('sessionQuery');
      const observation = query === undefined ? undefined : await query.observeSession(args.target, { signal: exec.signal });
      let headerExists = observation !== undefined;
      if (observation !== undefined) observation[Symbol.dispose]();
      const catalog = await ctx.subagents.listDescendants(exec.agent.id, exec.signal);
      const state = ctx.get('teamRetirements').subagentState(exec.agent.session);
      const result = {
        target: args.target,
        archived: ctx.workspaceRegistry.archivedSessionIds.includes(args.target),
        resident: ctx.agents.get(args.target) !== undefined,
        headerExists,
        catalogIds: catalog.filter(row => row.kind === 'child').map(row => row.id),
        retired: state.members.filter(row => row.phase === 'removed').map(row => row.id),
      };
      record({ kind: 'state', ...result });
      return result;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'audit_direct_send',
    description: 'Probe direct native subagent delivery after retirement.',
    parameters: { target: { type: 'string', required: true } },
    output: jsonOutput,
    async execute(args, exec) {
      try {
        await ctx.subagents.sendMessage(exec.agent, args.target, [{ type: 'text', text: 'ORDINARY_MUST_NOT_WAKE' }], { signal: exec.signal });
        return { blocked: false };
      } catch (error) {
        return { blocked: true, code: error?.code, message: error instanceof Error ? error.message : String(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'audit_remove_command',
    description: 'Run the ordinary subagent slash command.',
    parameters: { target: { type: 'string', required: true } },
    output: jsonOutput,
    async execute(args, exec) {
      const outcome = await ctx.get('commands').execute(exec.agent, '/subagent-remove ' + args.target, [], exec.signal);
      if (outcome?.result.kind !== 'success') throw new Error(outcome?.result.text ?? 'Missing subagent retirement command');
      return { commandSuccess: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'audit_list_native',
    description: 'Read native reachable subagent catalog.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      const rows = await ctx.subagents.listDescendants(exec.agent.id, exec.signal);
      return { rows };
    },
  }));

  ctx.subagents.registerProvider({
    name: 'ordinary-audit-external', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() { return { id: 'external-ordinary-audit', result: Promise.resolve({ output: [{ type: 'text', text: 'EXTERNAL_DONE' }], stopReason: 'completed' }), async dispose() {} }; },
  });
  ctx.tools.register(defineTool({ name: 'audit_start_external', description: 'Start an external execution for unsupported-removal checks.', parameters: {}, output: jsonOutput,
    async execute(_args, exec) {
      const started = await ctx.subagents.startActivation({ provider: 'ordinary-audit-external', label: 'ordinary-external', request: { parent: exec.agent, prompt: [{ type: 'text', text: 'EXTERNAL_AUDIT' }] }, signal: exec.signal, delivery: 'parent' });
      config.externalId = started.childId; return { sessionId: started.childId };
    },
  }));

  const resultTools = new Set(['audit_start_external', 'audit_start_ordinary', 'list_manageable_subagents', 'remove_subagent', 'audit_state', 'audit_direct_send', 'audit_remove_command', 'audit_list_native']);
  ctx.on('tools/result', (exec, result) => {
    if (!resultTools.has(exec.name)) return;
    record({ kind: 'tool', tool: exec.name, isError: result.isError, ...(result.isError ? { error: result.error } : { value: result.value }) });
  });

  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next();
    if (ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return proposal;
    return { ...proposal, provider: 'route-audit', model: 'gpt-6.1-sol', reasoningEffort: 'max' };
  });

  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next();
    const descriptor = agent.session.snapshotEvents().findLast(event => event.type === 'subagent/descriptor')?.data;
    if (descriptor?.label === 'ordinary-target' || descriptor?.label === 'ordinary-nested' || descriptor?.label === 'ordinary-sibling') {
      return { ...proposal, provider: 'route-audit', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' };
    }
    return proposal;
  });

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'list_manageable_subagents' || result.isError) return;
    record({ kind: 'manageable', value: result.value });
  });

  const rootNext = () => {
    if (config.mode === 'cold') {
      const target = config.targetId;
      return rootStep++ === 0 ? call(0, 'list_manageable_subagents', {})
        : rootStep === 2 ? call(1, 'remove_subagent', { session_id: target })
        : rootStep === 3 ? call(2, 'audit_direct_send', { target })
        : rootStep === 4 ? call(3, 'audit_state', { target })
        : text('ORDINARY_AUDIT_FINISHED');
    }
    if (config.mode === 'safety') {
      const safetySteps = [
        ['remove_subagent', { session_id: config.rootId }],
        ['remove_subagent', { session_id: 'unrelated-session' }],
        ['audit_start_external', {}],
        ['list_manageable_subagents', {}],
        ['remove_subagent', { session_id: config.externalId }],
      ];
      const action = safetySteps[rootStep++];
      return action ? call(rootStep, action[0], action[1]) : text('ORDINARY_AUDIT_FINISHED');
    }
    const target = config.targetId;
    if (rootStep === 0) return rootStep++, call(0, 'audit_start_ordinary', { role: 'target', nested: config.mode !== 'command' });
    if (rootStep === 1) return rootStep++, call(1, 'audit_start_ordinary', { role: 'sibling' });
    if (rootStep === 2) return rootStep++, call(2, 'list_manageable_subagents', {});
    if (rootStep === 3) return rootStep++, config.mode === 'command' ? call(3, 'audit_remove_command', { target }) : call(3, 'remove_subagent', { session_id: target });
    if (rootStep === 4) return rootStep++, call(4, 'audit_state', { target });
    if (rootStep === 5) return rootStep++, call(5, 'audit_direct_send', { target });
    if (rootStep === 6) return rootStep++, call(6, 'list_manageable_subagents', {});
    if (rootStep === 7) return rootStep++, call(7, 'remove_subagent', { session_id: target });
    if (rootStep === 8) return rootStep++, call(8, 'audit_list_native', {});
    return text('ORDINARY_AUDIT_FINISHED');
  };
}
