/** Stable Host companion for Settings and direct user actions; policy lives in ./policy. */
import { registerTaskActions } from './task-actions.mjs';
export const name = 'team-model-policy-settings';
export const inject = ['agentTeams', 'commands'];
export function apply(ctx) { ctx.effect(function* () { yield registerTaskActions(ctx); }); }
