const failure = (message, code) => Object.assign(new Error(message), { code });

/** Delete exactly the completed task revision the user clicked; retain native tombstones. */
export async function removeCompletedTask(ctx, caller, taskId, expectedRevision, signal) {
  signal?.throwIfAborted();
  if (!/^task-[1-9]\d*$/.test(taskId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw failure('任务 ID 或版本无效。', 'TEAM_TASK_INVALID_ARGUMENT');
  }
  if (caller === undefined || ctx.subagents.rootOf(caller) !== caller) throw failure('请从 Lead 会话移除已完成任务。', 'TEAM_LEAD_REQUIRED');
  const current = ctx.agentTeams.getTask(caller, taskId);
  if (current.status === 'deleted') return { removed: true, alreadyRemoved: true, taskId };
  if (current.status !== 'completed') throw failure('该任务已不再是已完成状态，未移除。', 'TEAM_TASK_NOT_COMPLETED');
  if (current.revision !== expectedRevision) throw failure('任务已变化，未移除，请按最新状态重试。', 'TEAM_TASK_STALE_REVISION');
  signal?.throwIfAborted();
  try {
    await ctx.agentTeams.updateTask(caller, { taskId, expectedRevision, action: 'delete' }, signal);
    return { removed: true, alreadyRemoved: false, taskId };
  } catch (error) {
    if (error?.code === 'TEAM_TASK_STALE_REVISION') throw failure('任务已变化，未移除，请按最新状态重试。', error.code);
    if (error?.code === 'TEAM_TASK_HAS_DEPENDENTS') throw failure('该任务仍被其他任务依赖，未移除。请先移除已完成的后续任务或调整依赖。', error.code);
    throw error;
  }
}

/** UI command over the same native task transition available as team_task_update(delete). */
export function registerTaskActions(ctx) {
  return ctx.commands.register({
    name: 'team-task-remove',
    description: '直接移除指定版本的已完成团队任务，保留历史，不再确认',
    input: { hint: '<task-id> <revision>' },
    async handler(invocation) {
      const match = /^(task-[1-9]\d*)\s+([1-9]\d*)$/.exec(invocation.rawInput.trim());
      if (!match) return { kind: 'error', text: '用法：/team-task-remove <task-id> <revision>' };
      await removeCompletedTask(ctx, invocation.agent, match[1], Number(match[2]), invocation.signal);
      return { kind: 'success' };
    },
  });
}
