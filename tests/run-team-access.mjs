import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = fs.mkdtempSync(path.join(project, '.evidence/team-access-'));
const app = '/Applications/DeepSeek Harness.app/Contents';
const cli = process.env.DSH_TEST_CLI ? JSON.parse(process.env.DSH_TEST_CLI) : fs.existsSync(app + '/Resources/app.asar') ? [app + '/MacOS/DeepSeek Harness', app + '/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'] : ['dsh'];
const verify = process.argv.includes('--verify');
const native = process.argv.includes('--native');
const ptc = process.argv.includes('--ptc');
const race = process.argv.includes('--race');
const output = path.join(evidence, 'events.jsonl'), home = path.join(evidence, 'home'), workspace = path.join(evidence, 'workspace'), outside = path.join(evidence, 'outside');
fs.mkdirSync(workspace); fs.mkdirSync(outside); fs.writeFileSync(path.join(workspace, 'input.txt'), 'native read probe');
const env = {...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1'}; for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
const init = spawnSync(cli[0], [...cli.slice(1), '--profile', 'headless', '--dump-config'], {cwd: workspace, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4e6});
fs.writeFileSync(path.join(evidence, 'init.stderr.log'), init.stderr ?? ''); assert.equal(init.status, 0, 'initialize ' + evidence);
const overlay = [
 {id:'agent-default-model',config:{provider:'team-access-audit',model:'audit-model',reasoningEffort:'max'}},
 {id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},
 {id:'tools',config:{mode:ptc?'ptc':'native'}},
 {id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:[{provider:'team-access-audit',model:'audit-model'}]}},
 {id:'tool-subagent-control',disabled:true},
 {insert:[
   {id:'access-workspace',name:'@deepseek-ai/dsh-workspace'},
   {id:'access-team',name:'@deepseek-ai/dsh-experimental-agent-team'},
   {id:'access-team-tools',name:'@deepseek-ai/dsh-experimental-tool-agent-team'},
   {id:'access-model-selection',name:'@deepseek-ai/dsh-tool-subagent/model-selection-settings',config:{enabled:true,allowedModels:[{provider:'team-access-audit',model:'audit-model'}]}},
   {id:'access-fixture',name:path.join(project,'tests/team-access-fixture.mjs'),config:{output,workspace,outside,race,...native?{creationTool:'spawn_teammate'}:{}}},
   ...native?[]:[{id:'access-retirements',name:path.join(project,'retirements.mjs')},{id:'access-policy',name:path.join(project,'index.mjs'),config:{mode:'follow-subagent'}}],
 ]},
];
fs.writeFileSync(path.join(home,'profiles/headless/cordis.patch.yml'), JSON.stringify(overlay,null,2)+'\n');
const child = spawnSync(cli[0],[...cli.slice(1),'--profile','headless','TEAM_ACCESS_AUDIT'],{cwd:workspace,env,encoding:'utf8',timeout:60000,maxBuffer:8e6});
fs.writeFileSync(path.join(evidence,'stdout.log'),child.stdout??'');fs.writeFileSync(path.join(evidence,'stderr.log'),child.stderr??'');
const rows = fs.existsSync(output) ? fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({status:child.status,signal:child.signal,error:child.error?.message,rows},null,2)+'\n');
assert.equal(child.status,0,'runtime failed: '+evidence);assert.match(child.stdout,/TEAM_ACCESS_FINISHED/);
const requests=rows.filter(r=>r.kind==='request'&&r.role==='teammate');
const summary={evidence,native,ptc,requests:[...new Map(requests.map(r=>[r.name+':'+r.phase,{phase:r.phase,name:r.name,mode:r.mode,approval:r.approval,tools:['read','bash','write','edit','skill'].filter(n=>r.tools.includes(n)),actualTools:r.actualTools}])).values()],calls:rows.filter(r=>r.kind==='tool'&&r.role==='teammate').map(r=>({phase:r.phase,name:r.name,tool:r.tool,isError:r.isError,error:r.error}))};
console.log(JSON.stringify(summary,null,2));
assert.equal(new Set(requests.map(r=>r.name)).size,race?1:2,'expected teammates must request');
if(verify&&race){
 const writes=rows.filter(r=>r.kind==='tool'&&r.role==='teammate'&&r.tool==='write');
 assert.ok(writes.length>0&&writes.every(r=>r.isError),'write admitted before Lead tightening must not succeed');
 assert.equal(fs.existsSync(path.join(workspace,'fresh-worker-0.txt')),false,'blocked write must not create a file');
 console.log('TEAM_ACCESS_RACE_VERIFIED');
}
if(verify&&!race){
 for(const name of ['fresh-worker','fork-worker']){
  for(const phase of [0,1,2]){
   const req=requests.find(r=>r.name===name&&r.phase===phase);assert.ok(req,name+' phase '+phase);
   assert.equal(req.mode,['workspace-write','danger-full-access','read-only'][phase]);
   assert.equal(req.approval,phase===1?'never':'ask');
   for(const tool of ['read','write','bash'])assert.ok(req.tools.includes(tool),name+' lacks '+tool);
   assert.equal(req.tools.includes('create_teammate'),false,'Lead-only plugin tools must not be advertised to teammates');
   if(ptc) assert.deepEqual(req.actualTools,['run_code']);
   const calls=rows.filter(r=>r.kind==='tool'&&r.name===name&&r.phase===phase);
   assert.ok(calls.some(r=>r.tool==='read'&&!r.isError),'native read failed');
   assert.ok(calls.some(r=>r.tool==='bash'&&!r.isError),'native bash failed');
   assert.ok(calls.some(r=>r.tool==='write'&&r.isError===(phase===2)),'native write policy mismatch');
  }
 }
 const ordinary=rows.filter(r=>r.kind==='request'&&r.role==='ordinary');
 assert.ok(ordinary.length>0,'ordinary subagent probe must run');
 assert.ok(ordinary.every(r=>r.mode==='workspace-write'&&r.approval==='never'),'ordinary delegation must retain its original scope');
 for(const phase of [0,1,2]) assert.ok(rows.some(r=>r.kind==='tool'&&r.role==='ordinary'&&r.phase===phase&&r.tool==='write'&&r.isError===(phase===1)),'ordinary write snapshot must remain unchanged');
 console.log('TEAM_ACCESS_VERIFIED');
}
