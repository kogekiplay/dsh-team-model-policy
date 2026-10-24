import z from '@deepseek-ai/schemastery';

/** Host-owned settings shown on the Team models card. */
export const Config = z.object({
  mode: z.union(['follow-subagent', 'fixed']).default('follow-subagent').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  defaultReasoningEffort: z.string().default('max').volatile(),
});

/** Read one detached request-time view of ordinary values or volatile references. */
export function readSettings(config) {
  const read = key => typeof config[key]?.get === 'function' ? config[key].get() : config[key];
  return { mode: read('mode') ?? (read('provider') ? 'fixed' : 'follow-subagent'),
    provider: read('provider') ?? '', model: read('model') ?? '', reasoningEffort: read('reasoningEffort') ?? '', defaultReasoningEffort: read('defaultReasoningEffort') ?? 'max' };
}
