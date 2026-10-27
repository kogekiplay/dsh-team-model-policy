import { createRequire } from 'node:module';
import { authorizeCurrent, listCurrentModels } from './authorization.mjs';

/** Register model-aware creation and next-request switching through the native Team service. */
export async function registerModelTools(ctx, { settings, choices, track }) {
  const require = createRequire(ctx.profileContext.installAnchor);
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  const retirements = () => ctx.get('teamRetirements');
  const reserved = new Set();
  const failure = (message, code) => Object.assign(new Error(message), { code });
  const lead = agent => {
    if (agent === undefined) throw failure('An active Team Lead is required.', 'TEAM_LEAD_REQUIRED');
    const member = ctx.agentTeams.membership(agent);
    if (member.role !== 'lead') throw failure('Only the Team Lead can choose teammate models.', 'TEAM_LEAD_REQUIRED');
    return member;
  };
  const routeFor = async (agent, args, signal) => {
    if (settings().mode !== 'follow-subagent') throw failure('The Team model is fixed. Enable follow mode to choose per teammate.', 'TEAM_MODEL_FIXED');
    const route = authorizeCurrent(ctx, { provider: args.provider, model: args.model,
      reasoningEffort: args.reasoning_effort ?? settings().defaultReasoningEffort });
    signal.throwIfAborted();
    const resolved = await ctx.llm.resolveCallConfig(route, signal);
    signal.throwIfAborted();
    authorizeCurrent(ctx, route);
    if (resolved.provider !== route.provider || resolved.model !== route.model) throw failure('The requested route resolved to another model.', 'ROUTE_MISMATCH');
    return route;
  };
  const key = (id, name) => JSON.stringify([id, name]);
  const nameField = { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name, at most 64 characters.' };
  const fields = {
    provider: { type: 'string', required: true, description: 'Authorized LLM provider id. Inspect list_teammate_models for the latest allowed routes.' },
    model: { type: 'string', required: true, description: 'Exact authorized model id under provider.' },
    reasoning_effort: { type: 'string', description: 'Effort supported by that model; omission uses the Team default, initially max. Explicit off keeps thinking disabled.' },
  };
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const disposers = [];
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'remove_teammate',
      description: 'Remove one teammate from this Team, stop its work, and return its unfinished tasks to the unassigned board. Keeps conversation history. Only the Lead may remove teammates.',
      parameters: { target: { type: 'string', required: true, description: 'Teammate target returned by list_agents. The Lead cannot be removed; removed names cannot be reused.' } },
      output,
      execute(args, exec) {
        return track(exec.signal, async signal => { lead(exec.agent); return await retirements().remove(exec.agent, args.target, signal); });
      },
    })));
    disposers.push(ctx.tools.register(defineTool({
      name: 'list_teammate_models',
      description: 'Refresh the latest models authorized for teammates in Subagent settings. Newly saved providers and models are available to this existing Team immediately.',
      parameters: { provider: { type: 'string', description: 'Provider id; omit to list currently authorized providers and routes.' },
        model: { type: 'string', description: 'Exact model id; requires provider. Returns its supported reasoning efforts.' } },
      output,
      execute(args, exec) {
        return track(exec.signal, async signal => { lead(exec.agent); return await listCurrentModels(ctx, args, signal); });
      },
    })));
    disposers.push(ctx.tools.register(defineTool({
      name: 'create_teammate',
      description: 'Create one named teammate with an authorized model and reasoning effort. Only the Team Lead may call this tool.',
      parameters: { name: nameField, description: { type: 'string', required: true, description: 'Responsibility of the teammate.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task.' },
        context: { type: 'string', enum: ['fresh', 'fork'], description: 'Fresh context by default; fork inherits completed Lead turns.' }, ...fields },
      output,
      execute(args, exec) {
        return track(exec.signal, async signal => {
          const member = lead(exec.agent);
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(args.name) || args.name.length > 64 || args.name === 'lead') {
            throw failure('Use a unique lower-kebab-case teammate name of at most 64 characters.', 'TEAM_INVALID_MEMBER_NAME');
          }
          const id = key(member.root.id, args.name);
          if (reserved.has(id) || ctx.agentTeams.listMembers(exec.agent).some(row => row.name === args.name)) {
            throw failure('That teammate name is already in use.', 'TEAM_NAME_IN_USE');
          }
          reserved.add(id);
          try {
            const route = await routeFor(exec.agent, args, signal);
            await (await choices()).save(member.root.id, args.name, route);
            signal.throwIfAborted();
            const context = args.context ?? 'fresh';
            const created = await ctx.agentTeams.spawnTeammate(exec.agent, { name: args.name, description: args.description,
              prompt: [{ type: 'text', text: args.prompt }], context, provider: context === 'fork' ? 'fork' : 'spawn', signal });
            const row = created.member;
            return { member: { target: row.name, role: row.role, status: row.status,
              description: row.description, provider: row.provider, context: row.context, model: route.model,
              diagnostics: row.diagnostics ?? [] }, selection: route };
          } finally { reserved.delete(id); }
        });
      },
    })));
    disposers.push(ctx.tools.register(defineTool({
      name: 'set_teammate_model',
      description: 'Choose the model and reasoning effort for an existing teammate’s next request. Current requests continue unchanged; this tool does not wake the teammate.',
      parameters: { target: { type: 'string', required: true, description: 'Existing teammate target returned by list_agents.' }, ...fields },
      output,
      execute(args, exec) {
        return track(exec.signal, async signal => {
          const caller = lead(exec.agent);
          retirements().assertActive(exec.agent, args.target);
          const row = ctx.agentTeams.listMembers(exec.agent).find(candidate => candidate.name === args.target && candidate.role === 'teammate');
          if (row === undefined) throw failure('The named teammate does not exist in this Team.', 'TEAM_MEMBER_NOT_FOUND');
          if (reserved.has(key(caller.root.id, args.target))) throw failure('Teammate creation is still in progress.', 'TEAM_MEMBER_BUSY');
          const route = await routeFor(exec.agent, args, signal);
          await (await choices()).save(caller.root.id, args.target, route);
          return { target: args.target, selection: route, applies: 'next-request', wakesTeammate: false };
        });
      },
    })));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
