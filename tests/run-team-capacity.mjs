import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url))),evidence=fs.mkdtempSync(path.join(project,'.evidence/team-capacity-'));
const app='/Applications/DeepSeek Harness.app/Contents',cli=process.env.DSH_TEST_CLI?JSON.parse(process.env.DSH_TEST_CLI):fs.existsSync(app+'/Resources/app.asar')?[app+'/MacOS/DeepSeek Harness',app+'/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js']:['dsh'];
const baseline=process.argv.includes('--baseline');
if(baseline&&!process.env.DSH_TEST_POLICY_DIR)throw new Error('Set DSH_TEST_POLICY_DIR to an unpatched v0.8.0 checkout or installation for baseline reproduction.');
const policyDir=process.env.DSH_TEST_POLICY_DIR??project;
const reports=[];
function run(label,mode,limit,{home=path.join(evidence,label+'-home'),sessionId}={}){
 const env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'};for(const key of Object.keys(env))if(/KEY|SECRET|TOKEN|PASSWORD/i.test(key))delete env[key];
 const output=path.join(evidence,label+'.jsonl');
 const init=spawnSync(cli[0],[...cli.slice(1),'--profile','headless','--dump-config'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});fs.writeFileSync(path.join(evidence,label+'.init.stderr.log'),init.stderr??'');assert.equal(init.status,0,'initialize '+evidence);
 const overlay=[{id:'agent-default-model',config:{provider:'capacity-audit',model:'audit',reasoningEffort:'max'}},{id:'hmr',disabled:true},{id:'session-title-llm',disabled:true},{id:'subagent',config:{maxActiveSubagents:16}},{id:'tool-subagent-control',disabled:true},{id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:[{provider:'capacity-audit',model:'audit'}]}},{insert:[{id:'capacity-workspace',name:'@deepseek-ai/dsh-workspace'},{id:'capacity-team',name:'@deepseek-ai/dsh-experimental-agent-team',config:{maxMembers:limit}},{id:'capacity-team-tools',name:'@deepseek-ai/dsh-experimental-tool-agent-team'},{id:'capacity-authorization',name:'@deepseek-ai/dsh-tool-subagent/model-selection-settings',config:{enabled:true,allowedModels:[{provider:'capacity-audit',model:'audit'}]}},{id:'capacity-retirements',name:path.join(policyDir,'retirements.mjs')},{id:'capacity-policy',name:path.join(policyDir,'index.mjs'),config:{mode:'follow-subagent'}},{id:'capacity-fixture',name:path.join(project,'tests/team-capacity-fixture.mjs'),config:{output,mode}}]}];
 fs.writeFileSync(path.join(home,'profiles/headless/cordis.patch.yml'),JSON.stringify(overlay,null,2)+'\n');
 const child=spawnSync(cli[0],[...cli.slice(1),'--profile','headless',...sessionId?['--session-id',sessionId]:[],'CAPACITY_AUDIT'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:8e6});
 fs.writeFileSync(path.join(evidence,label+'.stdout.log'),child.stdout??'');fs.writeFileSync(path.join(evidence,label+'.stderr.log'),child.stderr??'');
 const rows=fs.existsSync(output)?fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 reports.push({label,status:child.status,signal:child.signal,error:child.error?.message,rows});fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({reports},null,2)+'\n');
 assert.equal(child.status,0,label+' failed: '+evidence);assert.match(child.stdout,/CAPACITY_FINISHED/);
 const snapshots=rows.filter(r=>r.kind==='capacity');assert.ok(snapshots.length>0,'no capacity state');assert.ok(snapshots.every(s=>s.nativeLimit===limit),'native shared limit was changed');
 return {rows,snapshots,home};
}
const history=run('historical-eight', 'history',8);
assert.equal(history.snapshots[0].historical,8);assert.equal(history.snapshots[0].released,8);assert.equal(history.snapshots[0].occupied,0);
const last=history.snapshots.at(-1);
assert.equal(last.tasks[0].status,'pending');assert.equal(last.tasks[0].ownerName,undefined);
assert.equal(history.rows.find(r=>r.kind==='tool'&&r.tool==='list_agents').value.length,1);
if(baseline){assert.equal(last.occupied,0);assert.equal(history.rows.filter(r=>r.kind==='tool'&&['create_teammate','spawn_teammate'].includes(r.tool)&&!r.isError).length,8);console.log(JSON.stringify({reproduced:true,visibleMembers:1,retired:8,newMembersCreatedAfterRemoval:0,evidence},null,2));}
else{
 assert.equal(last.historical,16);assert.equal(last.released,8);assert.equal(last.occupied,8);
 const creates=history.rows.filter(r=>r.kind==='tool'&&['create_teammate','spawn_teammate'].includes(r.tool));assert.equal(creates.filter(r=>!r.isError).length,16);assert.equal(creates.filter(r=>r.isError).length,3);
 const cold=run('cold-reuse','cold',8,{home:history.home,sessionId:last.id});assert.equal(cold.snapshots[0].historical,17);assert.equal(cold.snapshots[0].released,9);assert.equal(cold.snapshots[0].occupied,8);
 const concurrent=run('concurrent-slot','parallel',2),parallel=concurrent.rows.find(r=>r.kind==='tool'&&r.tool==='audit_capacity_parallel').value.results;
 assert.equal(parallel.filter(r=>r.ok).length,1);assert.equal(parallel.filter(r=>!r.ok&&r.code==='TEAM_MEMBER_LIMIT').length,3);assert.equal(concurrent.snapshots[0].occupied,2);
 const failed=run('failed-reservation','failed',2);assert.equal(failed.snapshots[0].historical,3);assert.equal(failed.snapshots[0].released,1);assert.equal(failed.snapshots[0].occupied,2);
 console.log(JSON.stringify({passed:true,cases:['eight-retired-members-replaced','cold-capacity-recovery','one-free-slot-concurrent-creation','failed-reservation-reclaimed'],evidence},null,2));
}
