import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
export const name = 'team-access-fixture';
export const inject = ['profileContext', 'agents', 'agentTeams', 'tools', 'llm', 'sandboxPolicy', 'approval', 'subagents'];
const text = value => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }];
const call = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
export function apply(ctx, config) {
  const require = createRequire(ctx.profileContext.installAnchor);
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  const { setSandboxMode } = require('@deepseek-ai/dsh-sandbox-policy');
  const { setApprovalPolicy } = require('@deepseek-ai/dsh-user-approval');
  const record = value => appendFileSync(config.output, JSON.stringify(value) + '\n');
  let phase = 0, rootStep = 0, ordinaryId;
  const turns = new Map();
  const writeEntered = Promise.withResolvers(), releaseWrite = Promise.withResolvers();
  if (config.race) ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'write' && ctx.agentTeams.tryMembership(exec.agent)?.role === 'teammate') { writeEntered.resolve(); await releaseWrite.promise; }
    return await next();
  });
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agentTeams.tryMembership(agent)?.role === 'lead') {
      setSandboxMode(agent.session, 'workspace-write');
      setApprovalPolicy(agent.session, 'ask');
    }
  });
  ctx.tools.register(defineTool({ name: 'audit_access_race', description: 'Tighten the Lead policy while a teammate write is waiting in the dispatch gate.', parameters: {}, output, isConcurrencySafe: () => true,
    async execute(_args, exec) { await writeEntered.promise; phase = 2; setSandboxMode(exec.agent.session, 'read-only'); setApprovalPolicy(exec.agent.session, 'never'); releaseWrite.resolve(); return { changed: true }; } }));
  ctx.tools.register(defineTool({ name: 'audit_access_phase', description: 'Simulate the user changing the isolated Lead policy.', parameters: { mode: { type: 'string', required: true } }, output,
    execute(args, exec) {
      phase += 1;
      setSandboxMode(exec.agent.session, args.mode);
      setApprovalPolicy(exec.agent.session, phase === 1 ? 'never' : 'ask');
      record({ kind: 'lead-policy', phase, mode: args.mode, approval: ctx.approval.overrideOf(exec.agent.session) });
      return { phase, mode: args.mode };
    } }));
  ctx.tools.register(defineTool({ name: 'audit_access_wait', description: 'Wait for the dedicated test children to finish their native tool calls.', parameters: {}, output,
    async execute(_args, exec) {
      await ctx.subagents.waitForChildren(exec.agent);
      return { phase, finished: true };
    } }));
  ctx.tools.register(defineTool({ name: 'audit_access_ordinary', description: 'Probe an ordinary subagent without changing its delegated scope.', parameters: { action: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (args.action === 'start') {
        ordinaryId = (await ctx.subagents.startActivation({ provider: 'spawn', label: 'ordinary-worker', request: { parent: exec.agent, prompt: [{ type: 'text', text: 'Probe ordinary delegated permissions' }] }, signal: exec.signal, delivery: 'parent' })).childId;
      } else await ctx.subagents.sendMessage(exec.agent, ordinaryId, [{ type: 'text', text: 'ORDINARY_ACCESS_PHASE' }], { signal: exec.signal });
      return { sessionId: ordinaryId };
    } }));
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined) return;
    const membership = ctx.agentTeams.tryMembership(exec.agent);
    record({ kind: 'tool', phase, id: exec.agent.id, role: membership?.role ?? 'ordinary', name: membership?.name ?? 'ordinary-worker', tool: exec.name, isError: result.isError,
      ...(result.isError ? { error: result.error } : { value: result.value }) });
  });
  const resolveModel = async (provider, model) => ({ provider, id: model, name: model, reasoning: { efforts: [{ id: 'max', name: 'max' }], defaultEffort: 'max' } });
  const adapter = {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [{ id: 'audit-model', name: 'Audit model' }], resolveModel,
    prepareCall: async (provider, model) => ({ model: await resolveModel(provider, model), stream: options => adapter.stream(options) }),
    async *stream(options) {
      const agent = ctx.agents.requireInitiator(), member = ctx.agentTeams.tryMembership(agent);
      record({ kind: 'request', phase, id: agent.id, role: member?.role ?? 'ordinary', name: member?.name ?? 'ordinary-worker',
        mode: ctx.sandboxPolicy.resolve({ session: agent.session }).mode, approval: ctx.approval.overrideOf(agent.session),
        tools: ctx.tools.schemas(agent).map(tool => tool.name), actualTools: (options.tools ?? []).map(tool => tool.name) });
      const emit = (id, name, args) => (options.tools ?? []).some(tool => tool.name === 'run_code')
        ? call(id, 'run_code', { code: `try { console.log(JSON.stringify(await tools[${JSON.stringify(name)}](${JSON.stringify(args)}))); } catch (error) { console.log(String(error)); }`, description: 'Run isolated Team access probe' })
        : call(id, name, args);
      if (member?.role !== 'lead') {
        const n = turns.get(agent.id) ?? 0; turns.set(agent.id, n + 1);
        const step = n % 4;
        if (step === 0) yield* emit('access-read-' + n, 'read', { file_path: join(config.workspace, 'input.txt') });
        else if (step === 1) yield* emit('access-bash-' + n, 'bash', { description: 'Check isolated teammate shell access', command: 'printf team-access-probe' });
        else if (step === 2) yield* emit('access-write-' + n, 'write', { file_path: join(phase === 1 ? config.outside : config.workspace, (member?.name ?? 'ordinary-worker') + '-' + phase + '.txt'), content: 'team access phase ' + phase });
        else yield* text('ACCESS_CHILD_DONE');
        return;
      }
      const creation = (name, context) => [config.creationTool ?? 'create_teammate', { name, description: 'native tool and permission audit', prompt: 'Run the access fixture', ...(config.creationTool === 'spawn_teammate' ? {} : { provider: 'team-access-audit', model: 'audit-model' }), context }];
      const steps = [creation('fresh-worker', 'fresh'), creation('fork-worker', 'fork'), ['audit_access_ordinary', { action: 'start' }], ['audit_access_wait', {}],
        ['audit_access_phase', { mode: 'danger-full-access' }], ['send_message', { target: 'fresh-worker', message: 'ACCESS_PHASE_ONE' }], ['send_message', { target: 'fork-worker', message: 'ACCESS_PHASE_ONE' }], ['audit_access_ordinary', { action: 'send' }], ['audit_access_wait', {}],
        ['audit_access_phase', { mode: 'read-only' }], ['send_message', { target: 'fresh-worker', message: 'ACCESS_PHASE_TWO' }], ['send_message', { target: 'fork-worker', message: 'ACCESS_PHASE_TWO' }], ['audit_access_ordinary', { action: 'send' }], ['audit_access_wait', {}]];
      const action = (config.race ? [creation('fresh-worker', 'fresh'), ['audit_access_race', {}], ['audit_access_wait', {}]] : steps)[rootStep++];
      yield* action ? emit('access-root-' + rootStep, action[0], action[1]) : text('TEAM_ACCESS_FINISHED');
    },
  };
  ctx.llm.registerAdapter(['team-access-audit'], adapter);
}
