/** Durable teammate retirement and execution admission, without rewriting native Team events. */
import { createRequire } from 'node:module';
import Schema from '@deepseek-ai/schemastery';
export const RETIREMENT_RECORD = 'plugin:team-model-policy/retirements';
export const RETIREMENT_PROJECTION = 'teamRetirements';

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

/** Mount an independently owned service; the native Team service remains installed. */
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
      this.closing = false;
      this.shutdown = new AbortController();
      this.jobStopTimeoutMs = config.jobStopTimeoutMs;
      this.projection = undefined;
    }
    async [Service.init]() {
      const self = this;
      const registered = self.ctx.sessionProjections.register(retirementDefinition(z));
      self.projection = { stateOf: session => self.ctx.sessionProjections.snapshot(session).values[RETIREMENT_PROJECTION] };
      self.ctx.effect(function* () {
        // Synchronous yield preserves disposer identity; async generators await Cordis thenables.
        if (typeof registered === 'function') yield registered;
        yield self.ctx.on('agent/created', ({ agent }) => {
          const reason = self.blockedReason(agent);
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
            const membership = self.ctx.agentTeams.tryMembership(execution.agent);
            if (membership === undefined) return;
            const args = execution.arguments;
            if (args === null || typeof args !== 'object' || Array.isArray(args)) return;
            let target;
            if (['send_message', 'set_teammate_model', 'interrupt_agent'].includes(execution.name)) target = args.target;
            if (execution.name === 'team_task_update' && args.action === 'reassign') target = args.owner;
            if (typeof target === 'string' && self.state(membership.root.session).members.some(row => row.name === target)) return 'This teammate has been removed from the Team and cannot receive work.';
          } catch (error) { return 'Team retirement state is unavailable; the requested operation was denied.'; }
        });
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
    blockedReason(agent) {
      const archived = this.ctx.workspaceRegistry.archivedSessionIds;
      let session = agent.session;
      const visited = new Set();
      while (session !== undefined && !visited.has(session.id)) {
        visited.add(session.id);
        if (archived.includes(session.id)) return 'This Session has been archived and cannot execute Team work.';
        const header = session.header;
        if (header.origin !== 'subagent' || header.parentSession === undefined) return;
        const parent = this.ctx.sessions.get(header.parentSession);
        if (parent === undefined) return archived.includes(header.parentSession) ? 'An ancestor Session has been archived.' : undefined;
        if (this.state(parent).members.some(row => row.id === session.id)) return 'This teammate has been removed from the Team.';
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
