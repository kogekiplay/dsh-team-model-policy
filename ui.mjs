/** Completed task removal only; the native Team service owns data and persistence. */
import { registerTaskActions } from './task-actions.mjs';
export const name = 'completed-team-task-cleanup';
export const inject = ['agentTeams', 'subagents', 'commands'];
export function apply(ctx) {
  ctx.effect(() => registerTaskActions(ctx));
}
