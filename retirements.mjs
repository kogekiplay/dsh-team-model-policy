/** Durable teammate retirement and execution admission, without rewriting native Team events. */
import { createRequire } from 'node:module';
import Schema from '@deepseek-ai/schemastery';
export const RETIREMENT_RECORD = 'plugin:team-model-policy/retirements';
export const RETIREMENT_PROJECTION = 'teamRetirements';
export const SUBAGENT_RETIREMENT_RECORD = 'plugin:team-model-policy/subagent-retirements';
export const SUBAGENT_RETIREMENT_PROJECTION = 'subagentRetirements';

/** Define the root-owned retirement state and its client view. */
export function retirementDefinition(z) {
  const member = z.object({ id: z.string().min(1), name: z.string().min(1), phase: z.enum(['removing', 'removed']),
    releasedTasks: z.array(z.string()), error: z.string().optional() }).strict();
  const payload = z.object({ version: z.literal(1), rootId: z.string().min(1), members: z.array(member) }).strict();
  const stateSchema = z.object({ rootId: z.string(), inheritedEventCount: z.number().int().nonnegative(),
    members: z.array(member), failure: z.string().optional() }).strict();
  return { key: RETIREMENT_PROJECTION, stateVersion: 1, stateSchema,
    init: (header, inheritedEventCount) => ({ rootId: header.id, inheritedEventCount, members: [] }),
    apply(state, event) {
      if (state.failure !== undefined || event.type !== RETIREMENT_RECORD || event.seq < state.inheritedEventCount) return state;
      if (event.data?.rootId !== state.rootId) return state;
      try {
        const data = payload.parse(event.data);
        const ids = new Set(), names = new Set();
        for (const row of data.members) {
          if (row.id === state.rootId || row.name === 'lead' || ids.has(row.id) || names.has(row.name)) throw new Error('Invalid retired member identity');
          ids.add(row.id); names.add(row.name);
        }
        return { ...state, members: data.members };
      } catch (error) { return { ...state, failure: error instanceof Error ? error.message : String(error) }; }
    },
    wire: { viewSchema: stateSchema, view: state => state },
  };
}

/** Define the parent-owned retirement state for ordinary subagent children. */
export function subagentRetirementDefinition(z) {
  const member = z.object({ id: z.string().min(1), parentId: z.string().min(1), mode: z.enum(['continuable', 'one-shot', 'unknown', 'external']), category: z.enum(['ordinary', 'team-member', 'external', 'unsupported']), phase: z.enum(['removing', 'removed']), error: z.string().optional() }).strict();
  const payload = z.object({ version: z.literal(1), rootId: z.string().min(1), members: z.array(member) }).strict();
  const stateSchema = z.object({ rootId: z.string(), inheritedEventCount: z.number().int().nonnegative(), members: z.array(member), failure: z.string().optional() }).strict();
  return { key: SUBAGENT_RETIREMENT_PROJECTION, stateVersion: 1, stateSchema,
    init: (header, inheritedEventCount) => ({ rootId: header.id, inheritedEventCount, members: [] }),
    apply(state, event) {
      if (state.failure !== undefined || event.type !== SUBAGENT_RETIREMENT_RECORD || event.seq < state.inheritedEventCount) return state;
      if (event.data?.rootId !== state.rootId) return state;
      try {
        const data = payload.parse(event.data);
        const ids = new Set();
        for (const row of data.members) {
          if (row.id === state.rootId || ids.has(row.id)) throw new Error('Invalid retired subagent identity');
          ids.add(row.id);
        }
        return { ...state, members: data.members };
      } catch (error) { return { ...state, failure: error instanceof Error ? error.message : String(error) }; }
    },
    wire: { viewSchema: stateSchema, view: state => state },
  };
}
export default class TeamRetirementProvider {
  static provide = 'teamRetirements';
  static Config = Schema.object({
    jobStopTimeoutMs: Schema.number().min(1).max(300000).default(30000),
  });
  static inject = ['profileContext', 'agents', 'agentTeams', 'sessions', 'sessionProjections', 'subagents', 'workspaceRegistry', 'tools', 'commands'];
  constructor(ctx, config) {
  const require = createRequire(ctx.profileContext.installAnchor);
  const { Service } = require('@deepseek-ai/cordis');
  const { HarnessError } = require('@deepseek-ai/dsh-llm');
  const { appendPluginRecord } = require('@deepseek-ai/dsh-session');
  const { WorkspaceUnknownSessionError } = require('@deepseek-ai/dsh-workspace');
  const { z } = require('zod');
  const refusal = (message, code, details) => new HarnessError(message, code, { details });
  class TeamRetirements extends Service {
    static inject = ['agents', 'agentTeams', 'sessions', 'sessionProjections', 'subagents', 'workspaceRegistry', 'tools', 'commands'];
    constructor(owner) {
      super(owner, 'teamRetirements');
      this.pending = new Set();
      this.tails = new Map();
      this.subagentTail = undefined;
      this.closing = false;
      this.shutdown = new AbortController();
      this.jobStopTimeoutMs = config.jobStopTimeoutMs;
      this.projection = undefined;
      this.subagentProjection = undefined;
    }
    async [Service.init]() {
      const self = this;
      let registered;
      let subagentRegistered;
      try {
        registered = self.ctx.sessionProjections.register(retirementDefinition(z));
        subagentRegistered = self.ctx.sessionProjections.register(subagentRetirementDefinition(z));
      } catch (error) {
        if (typeof registered === 'function') registered();
        throw error;
      }
      self.projection = { stateOf: session => self.ctx.sessionProjections.snapshot(session).values[RETIREMENT_PROJECTION] };
      self.subagentProjection = { stateOf: session => self.ctx.sessionProjections.snapshot(session).values[SUBAGENT_RETIREMENT_PROJECTION] };
      self.ctx.effect(function* () {
        // Synchronous yield preserves disposer identity; async generators await Cordis thenables.
        if (typeof registered === 'function') yield registered;
        if (typeof subagentRegistered === 'function') yield subagentRegistered;
        yield self.ctx.on('agent/created', async ({ agent, signal }) => {
          const reason = self.blockedReason(agent) ?? await self.storedBlockedReason(agent, signal);
          if (reason !== undefined) throw refusal(reason, 'TEAM_MEMBER_REMOVED');
        });
        yield self.ctx.on('agent/pre-step', ({ agent }, next) => {
          try { return self.blockedReason(agent) === undefined ? next() : Promise.resolve({ kind: 'reject' }); }
          catch (error) { self.ctx.logger.error('Cannot determine Team retirement state', error); return Promise.resolve({ kind: 'reject' }); }
        });
        yield self.ctx.tools.guard(execution => {
          try {
            if (execution.agent === undefined) return;
            const reason = self.blockedReason(execution.agent);
            if (reason !== undefined) return reason;
            const args = execution.arguments;
            if (args === null || typeof args !== 'object' || Array.isArray(args)) return;
            const childId = args.agent_id ?? args.session_id;
            if (['send_message', 'interrupt_agent'].includes(execution.name) && typeof childId === 'string'
              && self.isRetiredSubagent(execution.agent.session, childId)) return '该子智能体已被移除，不能再接收工作。';
            const membership = self.ctx.agentTeams.tryMembership(execution.agent);
            if (membership === undefined) return;
            let target;
            if (['send_message', 'set_teammate_model', 'interrupt_agent'].includes(execution.name)) target = args.target;
            if (execution.name === 'team_task_update' && args.action === 'reassign') target = args.owner;
            if (typeof target === 'string' && self.state(membership.root.session).members.some(row => row.name === target)) return 'This teammate has been removed from the Team and cannot receive work.';
          } catch (error) { return 'Team retirement state is unavailable; the requested operation was denied.'; }
        });
        yield self.ctx.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next();
          if (exec.name !== 'list_agents' || result.isError || exec.agent === undefined || decision.kind !== 'accept' || decision.content !== undefined) return decision;
          const value = decision.value ?? result.value;
          if (!Array.isArray(value) || !value.some(row => typeof row.id === 'string' && row.kind !== undefined)) return decision;
          return self.trackSubagent(async signal => {
            const allowed = new Set((await self.listManageableSubagents(exec.agent, signal)).children.map(row => row.id));
            return { ...decision, value: value.filter(row => allowed.has(row.id)) };
          }, exec.signal);
        });
        yield self.ctx.commands.register({
          name: 'subagent-remove', description: '移除普通子智能体：停止并归档，保留会话历史；团队成员自动走退队流程',
          input: { hint: '<session-id>' },
          async handler(invocation) {
            const target = invocation.rawInput.trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(target)) return { kind: 'error', text: '用法：/subagent-remove <session-id>' };
            await self.removeSubagent(invocation.agent, target, invocation.signal);
            return { kind: 'success' };
          },
        });
        const { defineTool } = require('@deepseek-ai/dsh-tools');
        const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
        yield self.ctx.tools.register(defineTool({
          name: 'list_manageable_subagents',
          description: 'List this session’s ordinary subagents and Team members eligible for manual removal, including descendants. Returns session IDs, parent IDs, type, activity, and diagnostic rows. Inactive does not mean completed.',
          parameters: {}, output,
          execute(_args, exec) { return self.trackSubagent(signal => self.listManageableSubagents(exec.agent, signal), exec.signal); },
        }));
        yield self.ctx.tools.register(defineTool({
          name: 'remove_subagent',
          description: 'Manually remove one child subagent or its subtree: stop work, hide it from the plugin catalog, and retain history. Team members use the Team removal flow and return unfinished tasks. Only the owning parent or ancestor may remove it.',
          parameters: { session_id: { type: 'string', required: true, description: 'Exact session ID from list_manageable_subagents. Never the current session, an ancestor, or an unrelated session.' } }, output,
          execute(args, exec) { return self.removeSubagent(exec.agent, args.session_id, exec.signal); },
        }));
        yield self.ctx.commands.register({
          name: 'team-remove', description: 'Remove a teammate, stop its work and return unfinished tasks to the board',
          input: { hint: '<teammate-name>' },
          async handler(invocation) {
            const target = invocation.rawInput.trim();
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) return { kind: 'error', text: 'Use /team-remove <teammate-name>.' };
            await self.remove(invocation.agent, target, invocation.signal);
            return { kind: 'success' };
          },
        });
        // A composed effect retains the projection and guards until admitted cleanup settles.
        yield self.ctx.effect(() => async () => {
          self.closing = true;
          self.shutdown.abort(new Error('Team retirement service is unloading.'));
          await Promise.allSettled([...self.pending]);
        });
      });
      if (Object.prototype.toString.call(registered) === '[object Promise]') self.projection = await registered;
      if (Object.prototype.toString.call(subagentRegistered) === '[object Promise]') self.subagentProjection = await subagentRegistered;
    }
    subagentState(session) {
      const value = this.subagentProjection?.stateOf(session);
      if (value === undefined) throw refusal('Subagent retirement state is not ready.', 'SUBAGENT_RETIREMENT_NOT_READY');
      if (value.failure !== undefined) throw refusal('Cannot read subagent retirement state: ' + value.failure, 'SUBAGENT_RETIREMENT_STATE_INVALID');
      return value;
    }
    trackSubagent(body, signal) {
      if (this.closing) return Promise.reject(refusal('子智能体清理服务正在重载，请稍后重试。', 'SUBAGENT_RETIREMENT_UNLOADING'));
      const linked = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
      const operation = Promise.resolve().then(() => { linked.throwIfAborted(); return body(linked); });
      this.pending.add(operation);
      operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
      return operation;
    }
    assertParent(caller) {
      if (caller === undefined || this.ctx.agents.get(caller.id) !== caller) throw refusal('需要当前会话的有效父智能体。', 'SUBAGENT_PARENT_REQUIRED');
      const blocked = this.blockedReason(caller);
      if (blocked !== undefined) throw refusal(blocked, 'SUBAGENT_REMOVED');
    }
    async observeSubagent(id, signal) {
      const query = this.ctx.get('sessionQuery');
      if (query === undefined) throw refusal('会话查询服务不可用，不能安全清理子智能体。', 'SUBAGENT_QUERY_REQUIRED');
      const observation = await query.observeSession(id, { signal });
      try { return { header: observation.header, values: observation.projections?.values ?? {} }; }
      finally { observation[Symbol.dispose](); }
    }
    async storedBlockedReason(agent, signal) {
      const archived = this.ctx.workspaceRegistry.archivedSessionIds;
      const visited = new Set([agent.id]);
      let header = agent.session.header;
      while (header.origin === 'subagent' && header.parentSession !== undefined) {
        const parentId = header.parentSession;
        if (visited.has(parentId)) throw refusal('子会话所属关系存在循环。', 'SUBAGENT_LINEAGE_INVALID');
        if (archived.includes(parentId)) return 'An ancestor Session has been archived.';
        const parent = await this.observeSubagent(parentId, signal);
        for (const key of [SUBAGENT_RETIREMENT_PROJECTION, RETIREMENT_PROJECTION]) {
          const state = parent.values[key];
          if (state?.failure) throw refusal('移除记录损坏，拒绝恢复子会话。', 'SUBAGENT_RETIREMENT_STATE_INVALID');
          if (state?.members?.some(row => visited.has(row.id))) return 'This subagent has been removed and cannot resume.';
        }
        visited.add(parentId); header = parent.header;
      }
    }
    async listManageableSubagents(caller, signal) {
      this.assertParent(caller); signal.throwIfAborted();
      const entries = await this.ctx.subagents.listDescendants(caller.id, signal);
      const hidden = this.subagentState(caller.session).members.filter(row => row.phase === 'removed');
      const hiddenIds = new Set(hidden.map(row => row.id));
      const observations = new Map();
      const rows = [];
      for (const entry of entries) {
        signal.throwIfAborted();
        if (hiddenIds.has(entry.id) || hiddenIds.has(entry.parentId)) { hiddenIds.add(entry.id); continue; }
        if (entry.kind === 'diagnostic') { rows.push({ ...entry }); continue; }
        let parent = observations.get(entry.parentId);
        if (parent === undefined) { parent = await this.observeSubagent(entry.parentId, signal); observations.set(entry.parentId, parent); }
        if (parent.values.subagentRetirements?.failure || parent.values.agentTeam?.failure || parent.values.teamRetirements?.failure) throw refusal('子智能体的持久状态损坏，停止清理。', 'SUBAGENT_RETIREMENT_STATE_INVALID');
        const removed = parent.values.subagentRetirements?.members?.some(row => row.id === entry.id && row.phase === 'removed')
          || parent.values.teamRetirements?.members?.some(row => row.id === entry.id && row.phase === 'removed');
        if (removed) { hiddenIds.add(entry.id); continue; }
        const member = parent.values.agentTeam?.members?.find(row => row.id === entry.id && row.role === 'teammate');
        const retirement = this.subagentState(caller.session).members.find(row => row.id === entry.id);
        rows.push({ ...entry, type: member ? 'teammate' : entry.mode === 'external' ? 'external' : 'subagent',
          removable: entry.mode !== 'external', ...(member ? { teammateName: member.name } : {}),
          ...(retirement ? { retirement: retirement.phase, ...(retirement.error ? { error: retirement.error } : {}) } : {}) });
      }
      return { parentSessionId: caller.id, children: rows };
    }
    removeSubagent(caller, targetId, signal) {
      return this.trackSubagent(async linked => {
        this.assertParent(caller); linked.throwIfAborted();
        if (typeof targetId !== 'string' || targetId === caller.id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(targetId)) throw refusal('请选择有效的子会话 ID，不能移除当前会话。', 'SUBAGENT_INVALID_TARGET');
        // Serialize all generic removals, including overlapping ancestor/descendant requests.
        const previous = this.subagentTail ?? Promise.resolve();
        const operation = previous.then(() => this.removeSubagentAdmitted(caller, targetId, linked));
        this.subagentTail = operation.then(() => undefined, () => undefined);
        return await operation;
      }, signal);
    }
    async writeSubagents(root, rows) {
      const before = this.subagentState(root.session);
      const changed = new Set(rows.map(row => row.id));
      appendPluginRecord(root.session, SUBAGENT_RETIREMENT_RECORD, { version: 1, rootId: root.id,
        members: [...before.members.filter(row => !changed.has(row.id)), ...rows] });
      await this.ctx.sessions.flush(root.session);
    }
    async settleSubagent(id, signal) {
      const deadline = Date.now() + this.jobStopTimeoutMs;
      const jobs = this.ctx.get('jobs');
      if (jobs !== undefined) {
        for (const job of jobs.list(id).filter(job => job.owner === id && ['running', 'stopping'].includes(job.status))) {
          jobs.kill(job.id, id, 'Subagent removed');
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('等待子智能体后台作业停止超时。');
          let settled;
          try { settled = await jobs.wait(job.id, remaining, id, signal); }
          catch (error) { if (jobs.list(id).some(current => current.id === job.id)) throw error; }
          if (settled && ['running', 'stopping'].includes(settled.status)) throw new Error('子智能体后台作业尚未停止。');
        }
      }
      while (true) {
        signal.throwIfAborted();
        const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
        if (activity.length === 0 && this.ctx.agents.get(id)?.status !== 'running') return;
        if (Date.now() >= deadline) throw new Error('子智能体仍有活动，清理未完成，请重试。');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    async removeSubagentAdmitted(caller, targetId, signal) {
      this.assertParent(caller); signal.throwIfAborted();
      const old = this.subagentState(caller.session).members.find(row => row.id === targetId);
      const entries = await this.ctx.subagents.listDescendants(caller.id, signal);
      const target = entries.find(row => row.id === targetId && row.kind === 'child');
      if (target === undefined) throw refusal('该 ID 不是当前会话可验证的子智能体。', 'SUBAGENT_NOT_CHILD');
      const parent = await this.observeSubagent(target.parentId, signal);
      if (parent.values.agentTeam?.failure || parent.values.teamRetirements?.failure) throw refusal('Team 状态无效，不能绕过任务回收。', 'SUBAGENT_TEAM_STATE_INVALID');
      const teamMember = parent.values.agentTeam?.members?.find(row => row.id === targetId && row.role === 'teammate');
      if (teamMember !== undefined) {
        const owner = this.ctx.agents.get(target.parentId);
        if (owner === undefined || this.ctx.agentTeams.tryMembership(owner)?.role !== 'lead') throw refusal('该子智能体是团队成员，请先打开其 Lead 会话以执行退队与任务回收。', 'SUBAGENT_TEAM_LEAD_REQUIRED');
        return { ...(await this.remove(owner, teamMember.name, signal)), kind: 'teammate' };
      }
      if (old?.phase === 'removed') return { sessionId: targetId, removed: true, alreadyRemoved: true, kind: 'subagent' };
      const plan = [target];
      const selected = new Set([targetId]);
      for (const entry of entries) {
        if (entry.id === targetId || !selected.has(entry.parentId)) continue;
        if (entry.kind === 'diagnostic') throw refusal('子树中有无法验证的子会话，请先处理该会话：' + entry.id, 'SUBAGENT_SUBTREE_UNREADABLE');
        selected.add(entry.id); plan.push(entry);
      }
      for (const entry of plan) {
        signal.throwIfAborted();
        if (!['continuable', 'one-shot'].includes(entry.mode)) throw refusal('外部执行或未知类型没有可验证的本地子会话，暂不支持持久移除。', 'SUBAGENT_UNSUPPORTED_MODE');
        const observed = await this.observeSubagent(entry.id, signal);
        if (observed.header.origin !== 'subagent' || observed.header.parentSession !== entry.parentId) throw refusal('子会话所属关系与目录不一致。', 'SUBAGENT_LINEAGE_MISMATCH');
        const team = observed.values.agentTeam;
        if (team?.failure || team?.members?.some(row => row.role === 'teammate')) throw refusal('该子树包含独立 Team，请先通过其 Lead 清理团队成员。', 'SUBAGENT_CONTAINS_TEAM');
        if (entry.id !== targetId) {
          const owner = await this.observeSubagent(entry.parentId, signal);
          if (owner.values.agentTeam?.failure || owner.values.agentTeam?.members?.some(row => row.id === entry.id && row.role === 'teammate')) throw refusal('该子树包含团队成员，不能绕过退队和任务回收。', 'SUBAGENT_CONTAINS_TEAM');
        }
      }
      let rows = plan.map(entry => ({ id: entry.id, parentId: entry.parentId, mode: entry.mode, category: 'ordinary', phase: 'removing' }));
      await this.writeSubagents(caller, rows);
      const workSignal = this.shutdown.signal;
      let stage = 'archive';
      try {
        // Durable removing records already block every stop-induced wake.
        for (const entry of plan) this.ctx.subagents.interrupt(entry.id, { kind: 'user', parentSessionId: entry.parentId });
        for (const entry of plan) await this.ctx.workspaceRegistry.archiveSession(entry.id, { stopActivity: true });
        stage = 'stop';
        const targetAgent = this.ctx.agents.get(targetId);
        if (targetAgent !== undefined) await this.ctx.subagents.drainDescendants([targetAgent]);
        for (const entry of [...plan].reverse()) {
          workSignal.throwIfAborted();
          const owner = this.ctx.agents.get(entry.parentId);
          if (owner !== undefined) await this.ctx.subagents.drainChildren(owner, [entry.id]);
          await this.settleSubagent(entry.id, workSignal);
        }
        stage = 'commit';
        rows = rows.map(row => ({ ...row, phase: 'removed' }));
        await this.writeSubagents(caller, rows);
        return { sessionId: targetId, kind: 'subagent', removed: true, alreadyRemoved: false, removedSessionIds: rows.map(row => row.id), historyKept: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.closing) await this.writeSubagents(caller, rows.map(row => ({ ...row, error: message }))).catch(recordError => this.ctx.logger.error('Could not record subagent removal failure', recordError));
        throw refusal('清理在 ' + stage + ' 阶段未完成；子智能体仍被阻止，重试 remove_subagent。' + message, 'SUBAGENT_RETIREMENT_INCOMPLETE', { targetId, stage });
      }
    }
    state(session) {
      const value = this.projection?.stateOf(session);
      if (value === undefined) throw refusal('Team retirement state is not ready.', 'TEAM_RETIREMENT_NOT_READY');
      if (value.failure !== undefined) throw refusal('Cannot read Team retirement state: ' + value.failure, 'TEAM_RETIREMENT_STATE_INVALID');
      return value;
    }
    assertActive(caller, target) {
      const { root } = this.ctx.agentTeams.membership(caller);
      if (this.state(root.session).members.some(row => row.name === target)) throw refusal('This teammate has been removed from the Team.', 'TEAM_MEMBER_REMOVED', { target });
    }
    visibleRows(caller, rows) {
      const { root } = this.ctx.agentTeams.membership(caller);
      const removed = new Set(this.state(root.session).members.filter(row => row.phase === 'removed').map(row => row.name));
      return rows.filter(row => !removed.has(row.target));
    }
    isRetiredSubagent(session, id) {
      const visited = new Set();
      while (session !== undefined && !visited.has(session.id)) {
        visited.add(session.id);
        if (this.subagentState(session).members.some(row => row.id === id && ['removing', 'removed'].includes(row.phase))) return true;
        const parentId = session.header.parentSession;
        if (parentId === undefined) break;
        session = this.ctx.sessions.get(parentId);
      }
      return false;
    }
    blockedReason(agent) {
      const archived = this.ctx.workspaceRegistry.archivedSessionIds;
      let session = agent.session;
      const visited = new Set();
      while (session !== undefined && !visited.has(session.id)) {
        visited.add(session.id);
        if (archived.includes(session.id)) return 'This Session has been archived and cannot execute Team or subagent work.';
        const header = session.header;
        if (header.origin !== 'subagent' || header.parentSession === undefined) return;
        const parent = this.ctx.sessions.get(header.parentSession);
        if (parent === undefined) return archived.includes(header.parentSession) ? 'An ancestor Session has been archived.' : undefined;
        if (this.state(parent).members.some(row => row.id === session.id)) return 'This teammate has been removed from the Team.';
        if (this.subagentState(parent).members.some(row => visited.has(row.id) && ['removing', 'removed'].includes(row.phase))) return 'This subagent has been removed and cannot execute work.';
        session = parent;
      }
    }
    async write(root, row) {
      const before = this.state(root.session);
      const members = before.members.filter(member => member.id !== row.id);
      members.push(row);
      appendPluginRecord(root.session, RETIREMENT_RECORD, { version: 1, rootId: root.id, members });
      await this.ctx.sessions.flush(root.session);
    }
    remove(caller, target, signal) {
      if (this.closing) return Promise.reject(refusal('Team retirement is unloading.', 'TEAM_RETIREMENT_UNLOADING'));
      signal.throwIfAborted();
      const membership = this.ctx.agentTeams.membership(caller);
      if (membership.role !== 'lead') return Promise.reject(refusal('Only the Team Lead may remove a teammate.', 'TEAM_LEAD_REQUIRED'));
      if (target === 'lead') return Promise.reject(refusal('The Lead cannot remove itself.', 'TEAM_INVALID_TARGET'));
      const root = membership.root;
      const previous = this.tails.get(root.id) ?? Promise.resolve();
      const operation = previous.then(() => this.removeAdmitted(root, target, signal), () => this.removeAdmitted(root, target, signal));
      const tail = operation.then(() => undefined, () => undefined);
      this.tails.set(root.id, tail); this.pending.add(operation);
      const settled = () => { this.pending.delete(operation); if (this.tails.get(root.id) === tail) this.tails.delete(root.id); };
      operation.then(settled, settled);
      return operation;
    }
    async removeAdmitted(root, target, signal) {
      signal.throwIfAborted();
      const member = this.ctx.agentTeams.listMembers(root).find(row => row.role === 'teammate' && row.name === target);
      if (member === undefined) throw refusal('The named teammate does not exist in this Team.', 'TEAM_MEMBER_NOT_FOUND', { target });
      if (member.status === 'provisioning') throw refusal('Wait for teammate creation to finish before removing it.', 'TEAM_MEMBER_BUSY', { target });
      const old = this.state(root.session).members.find(row => row.id === member.id);
      const owned = () => this.ctx.agentTeams.listTasks(root).filter(task => task.ownerName === target && ['pending', 'in_progress'].includes(task.status));
      if (old?.phase === 'removed' && this.ctx.workspaceRegistry.archivedSessionIds.includes(member.id) && owned().length === 0) {
        return { target, sessionId: member.id, removed: true, alreadyRemoved: true, releasedTasks: old.releasedTasks, remainingAssignedTasks: 0 };
      }
      let row = { id: member.id, name: target, phase: 'removing', releasedTasks: old?.releasedTasks ?? [] };
      let stage = 'record';
      await this.write(root, row);
      // After durable admission, finish cleanup even if the calling turn is cancelled.
      const workSignal = this.shutdown.signal;
      try {
        stage = 'archive';
        try { await this.ctx.workspaceRegistry.archiveSession(member.id, { stopActivity: true }); }
        catch (error) {
          if (!(member.status === 'failed' && error instanceof WorkspaceUnknownSessionError)) throw error;
          // A failed reservation may never have produced a child Session to archive.
        }
        workSignal.throwIfAborted();
        stage = 'stop';
        const stopDeadline = Date.now() + this.jobStopTimeoutMs;
        await this.ctx.subagents.drainChildren(root, [member.id]);
        workSignal.throwIfAborted();
        const jobs = this.ctx.get('jobs');
        if (jobs !== undefined) {
          for (const job of jobs.list(member.id).filter(job => job.owner === member.id && ['running', 'stopping'].includes(job.status))) {
            jobs.kill(job.id, member.id, 'Team member removed');
            const remaining = stopDeadline - Date.now();
            if (remaining <= 0) throw new Error('Background jobs have not stopped within the configured wait');
            let settled;
            try { settled = await jobs.wait(job.id, remaining, member.id, workSignal); }
            catch (error) {
              if (jobs.list(member.id).some(current => current.id === job.id)) throw error;
              // Owner disposal removes records only after their producers have settled.
            }
            if (settled !== undefined && ['running', 'stopping'].includes(settled.status)) throw new Error('A background job is still stopping');
            workSignal.throwIfAborted();
          }
        }
        while (true) {
          const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: member.id }, () => Promise.resolve([]));
          if (activity.length === 0 && this.ctx.agents.get(member.id)?.status !== 'running') break;
          const remaining = stopDeadline - Date.now();
          if (remaining <= 0) throw new Error('The teammate still has active work after the configured stop wait');
          await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
          workSignal.throwIfAborted();
        }
        stage = 'tasks';
        const releaseTask = async taskId => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = owned().find(task => task.id === taskId);
            if (current === undefined) return false;
            try {
              await this.ctx.agentTeams.updateTask(root, { taskId: current.id, expectedRevision: current.revision, action: 'reassign' });
              return true;
            } catch (error) {
              if (error?.code !== 'TEAM_TASK_STALE_REVISION' || attempt === 2) throw error;
            }
          }
          return false;
        };
        for (const task of owned()) {
          if (await releaseTask(task.id)) row = { ...row, releasedTasks: [...new Set([...row.releasedTasks, task.id])] };
        }
        if (owned().length !== 0) throw new Error('The teammate still owns unfinished tasks');
        stage = 'commit';
        await this.write(root, { ...row, phase: 'removed' });
        return { target, sessionId: member.id, removed: true, alreadyRemoved: false, releasedTasks: row.releasedTasks, remainingAssignedTasks: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.closing) {
          try { await this.write(root, { ...row, error: 'Removal incomplete at ' + stage + ': ' + message }); }
          catch (recordError) { this.ctx.logger.error('Could not record incomplete Team removal', recordError); }
        }
        throw refusal('Removal is incomplete at ' + stage + '. The teammate remains blocked; retry remove_teammate to finish. ' + message,
          'TEAM_RETIREMENT_INCOMPLETE', { target, sessionId: member.id, stage });
      }
    }
  }
  return new TeamRetirements(ctx);
  }
}
