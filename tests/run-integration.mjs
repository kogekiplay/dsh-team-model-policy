import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = join(project, '.evidence'); mkdirSync(evidence, { recursive: true });
const runRoot = mkdtempSync(join(evidence, 'integration-'));
const installed = '/Applications/DeepSeek Harness.app/Contents';
const cli = process.env.DSH_TEST_CLI ? JSON.parse(process.env.DSH_TEST_CLI) : existsSync(installed + '/Resources/app.asar')
  ? [installed + '/MacOS/DeepSeek Harness', installed + '/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'] : ['dsh'];
const results = [];
function runCase(label, { enabled = true, mode = 'normal', home, sessionId, model = 'deepseek-v4.1-flash', policyMode = 'fixed', defaultEffort = 'max' } = {}) {
  home ??= join(runRoot, label + '-home');
  const output = join(runRoot, label + '.jsonl');
  const overlay = [
    { id: 'agent-default-model', config: { provider: 'route-audit', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'subagent-model-selection-settings', config: { enabled: true, allowedModels: [
      { provider: 'route-audit', model: 'gpt-6.1-sol' }, { provider: 'route-audit', model: 'deepseek-v4.1-flash' } ] } },
    { insert: [
      { id: 'audit-model-selection-policy', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [
        { provider: 'route-audit', model: 'gpt-6.1-sol' }, { provider: 'route-audit', model: 'deepseek-v4.1-flash' } ] } },
      { id: 'audit-team', name: '@deepseek-ai/dsh-experimental-agent-team' },
      { id: 'audit-team-tools', name: '@deepseek-ai/dsh-experimental-tool-agent-team' },
      { id: 'audit-adapter', name: join(project, 'tests/fixture.mjs'), config: { output, mode } },
      ...(enabled ? [{ id: 'audit-policy', name: join(project, 'index.mjs'), config: { mode: policyMode, provider: 'route-audit', model, defaultReasoningEffort: defaultEffort } }] : []),
    ] },
    { id: 'tool-subagent-control', disabled: true },
  ];
  const patch = join(runRoot, label + '.patch.json'); writeFileSync(patch, JSON.stringify(overlay, null, 2) + '\n');
  const env = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) delete env[key];
  // A real profile layer is writable, unlike a command-line overlay.
  const initialize = spawnSync(cli[0], [...cli.slice(1), '--profile', 'headless', '--dump-config'], { cwd: project, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(runRoot, label + '.init.stderr.log'), initialize.stderr ?? '');
  assert.equal(initialize.status, 0, 'Could not initialize isolated profile');
  writeFileSync(join(home, 'profiles', 'headless', 'cordis.patch.yml'), JSON.stringify(overlay, null, 2) + '\n');
  const args = [...cli.slice(1), '--profile', 'headless',
    ...(sessionId ? ['--session-id', sessionId] : []), 'AUDIT_ROOT'];
  const child = spawnSync(cli[0], args, { cwd: project, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(runRoot, label + '.stdout.log'), child.stdout ?? '');
  writeFileSync(join(runRoot, label + '.stderr.log'), child.stderr ?? '');
  const events = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(v => JSON.parse(v)) : [];
  const summary = { label, command: [cli[0], ...args], status: child.status, signal: child.signal, error: child.error?.message, home,
    requests: events.filter(e => e.kind === 'request'), tools: events.filter(e => e.kind === 'tool') };
  results.push(summary); writeFileSync(join(runRoot, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  assert.equal(child.error, undefined, label + ': ' + child.error?.message);
  assert.equal(child.signal, null, label + ': unexpectedly signalled');
  assert.equal(child.status, 0, label + ': see stderr log in ' + runRoot);
  assert.match(child.stdout, /AUDIT_FINISHED/);
  const sessions = join(home, 'sessions');
  const artifacts = readdirSync(sessions, { recursive: true }).filter(p => p.endsWith('.jsonl.zstd'));
  const last = new Map(summary.requests.map(request => [request.id, request]));
  for (const [id, request] of last) {
    const artifact = artifacts.find(p => p.split(/[\\/]/).includes(id));
    assert(artifact, label + ': missing durable session ' + id);
    const decoded = spawnSync(process.env.DSH_TEST_ZSTD ?? 'zstd', ['-d', '-q', '-c', join(sessions, artifact)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(decoded.status, 0, 'zstd is required to audit durable session logs');
    const persisted = decoded.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    const descriptorIndex = persisted.findIndex(event => event.type === 'subagent/descriptor');
    const own = descriptorIndex < 0 ? persisted : persisted.slice(descriptorIndex);
    const logged = own.findLast(event => event.type === 'request/header')?.data.header.config;
    assert(logged, label + ': missing own request/header for ' + id);
    assert.equal(logged.provider, request.provider);
    assert.equal(logged.model, request.model);
    assert.equal(logged.reasoningEffort, request.reasoningEffort);
  }
  return { ...summary, events };
}
try {
  const before = runCase('baseline', { enabled: false });
  assert.equal(before.requests.filter(r => r.role === 'teammate').length, 2);
  assert(before.requests.filter(r => r.role === 'teammate').every(r => r.model === 'gpt-6.1-sol'));
  assert.equal(before.tools.find(t => t.tool === 'list_agents').value[0].model, 'deepseek-v4.1-flash');
  const after = runCase('enabled');
  assert.equal(after.requests.filter(r => r.role === 'teammate').length, 2);
  assert(after.requests.filter(r => r.role === 'teammate').every(r => r.model === 'deepseek-v4.1-flash' && r.reasoningEffort === 'off'));
  assert(after.requests.filter(r => r.role === 'lead').every(r => r.model === 'gpt-6.1-sol'));
  assert.equal(after.tools.find(t => t.tool === 'list_agents').value[0].model, 'gpt-6.1-sol');
  assert(after.tools.filter(t => t.tool === 'spawn_teammate').every(t => !t.isError && t.value.member.model === 'deepseek-v4.1-flash'));
  const rootId = before.requests.find(r => r.role === 'lead').id;
  const resumed = runCase('cold-resume', { mode: 'resume', home: before.home, sessionId: rootId });
  assert.equal(resumed.requests.filter(r => r.role === 'teammate').length, 2);
  assert(resumed.requests.filter(r => r.role === 'teammate').every(r => r.model === 'deepseek-v4.1-flash'));
  const followed = runCase('follow-default-max-and-switch', { mode: 'follow', policyMode: 'follow-subagent' });
  const firstRequests = followed.requests.filter(r => r.name === 'first');
  assert.equal(firstRequests[0]?.model, 'deepseek-v4.1-flash');
  assert.equal(firstRequests[0]?.reasoningEffort, 'max');
  assert.equal(firstRequests.at(-1)?.model, 'gpt-6.1-sol');
  assert.equal(firstRequests.at(-1)?.reasoningEffort, 'high');
  assert(followed.requests.filter(r => r.name === 'second').every(r => r.reasoningEffort === 'off'));
  assert(followed.tools.filter(t => t.tool === 'create_teammate' || t.tool === 'set_teammate_model').every(t => !t.isError));
  const configuredHigh = runCase('follow-configured-default-high', { mode: 'follow', policyMode: 'follow-subagent', defaultEffort: 'high' });
  const highFirst = configuredHigh.requests.find(r => r.name === 'first');
  assert.equal(highFirst?.model, 'deepseek-v4.1-flash');
  assert.equal(highFirst?.reasoningEffort, 'high');
  assert(configuredHigh.requests.filter(r => r.name === 'second').every(r => r.reasoningEffort === 'off'));
  const nativeFollow = runCase('native-follow-default-max', { mode: 'native-follow', policyMode: 'follow-subagent' });
  assert.equal(nativeFollow.requests.filter(r => r.role === 'teammate').length, 2);
  assert(nativeFollow.requests.filter(r => r.role === 'lead').every(r => r.reasoningEffort === 'off'));
  assert(nativeFollow.requests.filter(r => r.role === 'teammate').every(r => r.reasoningEffort === 'max'));
  const dynamic = runCase('dynamic-authority-existing-session', { mode: 'dynamic', policyMode: 'follow-subagent' });
  const catalogs = dynamic.tools.filter(t => t.tool === 'list_teammate_models');
  assert(catalogs.every(t => !t.isError));
  assert(!catalogs[0].value.providers.some(p => p.id === 'other-audit'));
  assert(catalogs[1].value.providers.some(p => p.id === 'other-audit'));
  assert.equal(catalogs[2].value.model, 'glm-5.3');
  assert(catalogs[2].value.reasoningEfforts.some(e => e.id === 'high'));
  assert(!catalogs[3].value.providers.some(p => p.id === 'other-audit'));
  assert.equal(catalogs[4].value.enabled, false);
  assert.deepEqual(catalogs[4].value.providers, []);
  const switches = dynamic.tools.filter(t => t.tool === 'set_teammate_model');
  assert.deepEqual(switches.map(t => t.isError), [false, true, false, true]);
  const first = dynamic.requests.filter(r => r.name === 'first');
  assert.equal(first.filter(r => r.provider === 'other-audit').length, 1);
  assert.equal(first.find(r => r.provider === 'other-audit').reasoningEffort, 'high');
  assert.equal(first.at(-1).model, 'gpt-6.1-sol');
  assert.equal(first.at(-1).reasoningEffort, 'off');
  assert(dynamic.requests.some(r => r.name === 'second' && r.provider === 'other-audit' && r.reasoningEffort === 'max'));
  assert(dynamic.events.filter(e => e.kind === 'saved-policy').every(e => e.sessionPolicies.flat().every(p => p.provider !== 'other-audit')));
  const invalid = runCase('invalid-route', { mode: 'invalid-route', model: 'missing-audit-model' });
  assert.equal(invalid.requests.filter(r => r.role === 'teammate').length, 0);
  assert.equal(invalid.tools.find(t => t.tool === 'spawn_teammate').isError, true);
  console.log(JSON.stringify({ passed: true, cases: results.map(r => r.label), evidence: runRoot }, null, 2));
} catch (error) {
  console.error(error); console.error('Evidence preserved at ' + runRoot); process.exitCode = 1;
}
