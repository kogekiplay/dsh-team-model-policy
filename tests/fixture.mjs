import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
      if (membership.role === 'teammate') chunks = text('AUDIT_CHILD_DONE');
      else {
        const i = step++;
        if (config.mode === 'dynamic') {
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
    if (['list_agents', 'spawn_teammate', 'send_message', 'create_teammate', 'set_teammate_model', 'list_teammate_models', 'audit_model_selection'].includes(exec.name)) {
      record({ kind: 'tool', tool: exec.name, isError: result.isError,
        ...(result.isError ? { error: result.error } : { value: result.value }) });
    }
  });
}
