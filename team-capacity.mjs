import { createRequire } from 'node:module';

/** Count only matching, fully committed retirements; inactive/failed/removing still occupy slots. */
export function capacityOf(limit, rows, retirement) {
  if (!Number.isSafeInteger(limit) || limit < 1 || retirement?.failure || !Array.isArray(retirement?.members)) throw new Error('Cannot determine Team capacity safely.');
  const members = rows.filter(row => row.role === 'teammate');
  const retired = new Map(retirement.members.filter(row => row.phase === 'removed' && row.error === undefined).map(row => [row.id, row.name]));
  const released = members.filter(row => retired.get(row.id) === row.name).length;
  const ceiling = limit + released;
  if (!Number.isSafeInteger(ceiling)) throw new Error('Team historical capacity exceeds the safe integer range.');
  return { limit, occupied: members.length - released, released, historical: members.length, ceiling };
}

/** rc.5 adapter: use a read-only per-call roster view, never mutate the shared native limit/state. */
export function capacitySpawn(native, retirements, dispatch) {
  const roster = native.roster;
  const limit = roster?.maxMembers;
  const property = roster && Object.getOwnPropertyDescriptor(roster, 'maxMembers');
  if (typeof roster?.spawn !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || (property && !property.configurable && !property.writable)) {
    throw new Error('Unsupported Team runtime: safe capacity adaptation is unavailable.');
  }
  return async (caller, request) => {
    const member = native.membership(caller);
    if (member.role !== 'lead') throw Object.assign(new Error('Only the Team Lead may create teammates.'), { code: 'TEAM_LEAD_REQUIRED' });
    const root = member.root;
    let sampled;
    const view = new Proxy(roster, { get(target, key, receiver) {
      if (key !== 'maxMembers') return Reflect.get(target, key, receiver);
      // The first read occurs inside the native serialized check-and-append transaction.
      sampled ??= capacityOf(limit, native.listMembers(root), retirements.state(root.session));
      return sampled.ceiling;
    } });
    try { return await dispatch(() => roster.spawn.call(view, caller, request)); }
    catch (error) {
      if (error?.code !== 'TEAM_MEMBER_LIMIT') throw error;
      const state = sampled ?? capacityOf(limit, native.listMembers(root), retirements.state(root.session));
      throw Object.assign(new Error('团队名额已满：' + state.occupied + '/' + limit + ' 个成员尚未成功移除。未运行或移除中的成员仍占名额。', { cause: error }),
        { code: 'TEAM_MEMBER_LIMIT', details: state });
    }
  };
}

/** Install/release the public creation adapter without reloading the native Team service. */
export function registerTeamCapacity(ctx) {
  const require = createRequire(ctx.profileContext.installAnchor);
  if (require('@deepseek-ai/dsh-experimental-agent-team/package.json').version !== '0.2.1-rc.5') throw new Error('This Team capacity adapter requires DSH 0.2.1-rc.5.');
  const native = ctx.agentTeams;
  const before = Object.getOwnPropertyDescriptor(native, 'spawnTeammate');
  if (before !== undefined) throw new Error('Another Team creation adapter is already installed; refusing to bypass it.');
  const original = native.spawnTeammate.bind(native);
  const pending = new Set();
  let closing = false;
  const adapted = capacitySpawn(native, ctx.teamRetirements, body => {
    const operation = Promise.resolve().then(body);
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  });
  const wrapped = (caller, request) => closing ? original(caller, request) : adapted(caller, request);
  Object.defineProperty(native, 'spawnTeammate', { configurable: true, writable: true, value: wrapped });
  return async () => {
    closing = true;
    await Promise.allSettled([...pending]);
    if (Object.getOwnPropertyDescriptor(native, 'spawnTeammate')?.value !== wrapped) return;
    if (before) Object.defineProperty(native, 'spawnTeammate', before);
    else Reflect.deleteProperty(native, 'spawnTeammate');
  };
}
