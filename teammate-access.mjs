import { createRequire } from 'node:module';

// These operations require the Lead or a direct human interaction by design.
// Filesystem, shell, terminal, search and other ordinary capabilities are not restricted here.
export const LEAD_ONLY_TOOLS = Object.freeze([
  'create_teammate', 'list_teammate_models', 'set_teammate_model', 'remove_teammate',
  'spawn_teammate', 'interrupt_agent', 'ask_user_question', 'create_goal', 'update_goal', 'auto_continue_settings',
]);
export const TEAM_ACCESS_CONTEXT = 'Named Team teammate: the Host keeps your standing sandbox and approval policy aligned with the live Lead, replacing the ordinary subagent snapshot rule. Follow the current permission facts. One-shot grants are not standing access. When only run_code is advertised, use its generated tools SDK. Request human-only or Lead-only actions through send_message to the Lead.';

/** Mirror only the exact live Team Lead's standing policy; ordinary subagents are untouched. */
export function syncTeammateAccess(ctx, agent, setters) {
  if (agent === undefined) return undefined;
  const membership = ctx.agentTeams.tryMembership(agent);
  if (membership?.role !== 'teammate') return undefined;
  const root = membership.root;
  if (ctx.agents.get(root.id) !== root || ctx.agents.get(agent.id) !== agent) throw new Error('Team access requires the exact live Lead and teammate.');
  ctx.get('teamRetirements')?.assertActive(root, membership.name);
  const sandbox = root.ctx.get('sandboxPolicy');
  const approval = root.ctx.get('approval');
  if (sandbox === undefined || approval === undefined) throw new Error('Team access requires the Lead sandbox and approval services.');
  const target = sandbox.resolve({ session: root.session });
  const current = sandbox.resolve({ session: agent.session });
  if (target.workspaceRoot !== current.workspaceRoot) throw new Error('Teammate workspace boundary differs from the Lead; refusing to rewrite Session identity.');
  const presets = root.ctx.get('permissionPresets');
  const preset = presets?.current(root.session);
  const targetApproval = approval.overrideOf(root.session) ?? (preset && preset !== 'custom' ? presets.resolve(preset).approval : undefined);
  // A missing durable/default policy must never turn a delegated 'never' into 'ask'.
  if (preset && preset !== 'custom' && targetApproval !== undefined) {
    presets.set(agent.session, preset);
  }
  if (sandbox.resolve({ session: agent.session }).mode !== target.mode) setters.setSandboxMode(agent.session, target.mode);
  if (targetApproval !== undefined && approval.overrideOf(agent.session) !== targetApproval) setters.setApprovalPolicy(agent.session, targetApproval);
  return { leadSessionId: root.id, sandbox: target.mode, ...(targetApproval === undefined ? {} : { approval: targetApproval }) };
}

/** Lifecycle-owned policy synchronization and truthful teammate tool discovery. */
export function registerTeammateAccess(ctx) {
  const require = createRequire(ctx.profileContext.installAnchor);
  const { setSandboxMode } = require('@deepseek-ai/dsh-sandbox-policy');
  const { setApprovalPolicy } = require('@deepseek-ai/dsh-user-approval');
  const setters = { setSandboxMode, setApprovalPolicy };
  const installed = new Map();
  const changedLeads = new Set();
  let queued = false, closed = false;
  const install = agent => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent)?.role !== 'teammate') return;
    // The member's scope owns the resource; the plugin also retains it for hot unload.
    const dispose = agent.ctx.effect(function* () {
      yield agent.ctx.systemPrompt.context({ name: 'team:shared-access',
        order: agent.ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1, text: TEAM_ACCESS_CONTEXT });
      // rc.5 restrict() validates global names; native Team tools are scoped.
      const deny = LEAD_ONLY_TOOLS.filter(name => ctx.tools.get(name) !== undefined);
      if (deny.length > 0) yield agent.ctx.tools.restrict({ deny });
    });
    installed.set(agent, dispose);
  };
  const synchronize = agent => { if (agent !== undefined) install(agent); return syncTeammateAccess(ctx, agent, setters); };
  ctx.on('agent/created', ({ agent }) => { synchronize(agent); });
  ctx.on('agent/pre-step', async ({ agent }, next) => { synchronize(agent); return await next(); }, { prepend: true });
  ctx.on('tools/pre-execute', async (exec, next) => { synchronize(exec.agent); return await next(); }, { prepend: true });
  ctx.on('tools/execute', async (exec, next) => { synchronize(exec.agent); return await next(); }, { prepend: true });
  ctx.on('session/event', (session, event) => {
    if (!['sandbox/mode', 'approval/policy', 'permission/preset'].includes(event.type)) return;
    const root = ctx.agents.get(session.id);
    if (root === undefined || ctx.agentTeams.tryMembership(root)?.role !== 'lead') return;
    changedLeads.add(root);
    if (queued) return;
    queued = true;
    // Run after append publication; never append recursively from a Session observer.
    queueMicrotask(() => {
      queued = false;
      if (closed) return;
      const roots = new Set(changedLeads); changedLeads.clear();
      for (const agent of ctx.agents.list()) {
        const member = ctx.agentTeams.tryMembership(agent);
        if (member?.role !== 'teammate' || !roots.has(member.root)) continue;
        try { synchronize(agent); }
        catch (error) { ctx.logger.warn('Teammate permission synchronization failed; dispatch will refuse it: ' + String(error)); }
      }
    });
  });
  ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent); });
  for (const agent of ctx.agents.list()) install(agent);
  return () => { closed = true; changedLeads.clear(); for (const dispose of installed.values()) dispose(); installed.clear(); };
}
