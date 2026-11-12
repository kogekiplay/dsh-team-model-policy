import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url))),root=fs.mkdtempSync(path.join(project,'.evidence/task-removal-'));
const app='/Applications/DeepSeek Harness.app/Contents';
const cli=process.env.DSH_TEST_CLI?JSON.parse(process.env.DSH_TEST_CLI):fs.existsSync(app+'/Resources/app.asar')?[app+'/MacOS/DeepSeek Harness',app+'/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js']:['dsh'];
const home=path.join(root,'home'),env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'};for(const key of Object.keys(env))if(/KEY|SECRET|TOKEN|PASSWORD/i.test(key))delete env[key];
const init=spawnSync(cli[0],[...cli.slice(1),'--profile','headless','--dump-config'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});fs.writeFileSync(path.join(root,'init.stderr.log'),init.stderr??'');assert.equal(init.status,0,'initialize '+root);
function run(label,sessionId){
 const output=path.join(root,label+'.jsonl');
 const overlay=[{id:'agent-default-model',config:{provider:'task-removal-audit',model:'audit',reasoningEffort:'max'}},{id:'hmr',disabled:true},{id:'session-title-llm',disabled:true},{id:'agent-team',config:{defaultEnabled:true}},{id:'tool-subagent-control',disabled:true},{insert:[{id:'task-removal-ui',name:path.join(project,'ui.mjs')},{id:'task-removal-fixture',name:path.join(project,'tests/task-removal-fixture.mjs'),config:{output,resume:Boolean(sessionId)}}]}];
 fs.writeFileSync(path.join(home,'profiles/headless/cordis.patch.yml'),JSON.stringify(overlay,null,2)+'\n');
 const result=spawnSync(cli[0],[...cli.slice(1),'--profile','headless',...sessionId?['--session-id',sessionId]:[],'TASK_REMOVAL_AUDIT'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});
 fs.writeFileSync(path.join(root,label+'.stdout.log'),result.stdout??'');fs.writeFileSync(path.join(root,label+'.stderr.log'),result.stderr??'');assert.equal(result.status,0,label+' '+root);assert.match(result.stdout,/TASK_REMOVAL_FINISHED/);
 const rows=fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),state=rows.findLast(row=>row.kind==='state');assert.ok(state,'state must be observed');
 assert.equal(state.deleted.status,'deleted');assert.ok(!state.tasks.some(task=>task.id==='task-1'));assert.ok(!state.projection.tasks.some(task=>task.id==='task-1'));
 assert.equal(state.tasks.find(task=>task.id==='task-2').status,'pending');assert.equal(state.tasks.find(task=>task.id==='task-3').status,'completed');assert.deepEqual(state.tasks.find(task=>task.id==='task-4').blockedBy,['task-3']);
 assert.ok(rows.filter(row=>row.kind==='tool').every(row=>!row.isError));return {rows,state};
}
const fresh=run('fresh');assert.deepEqual(fresh.rows.filter(r=>r.kind==='command').map(r=>r.result.kind),['success','success','error','error','error']);
const cold=run('cold',fresh.state.id);assert.equal(cold.rows.find(r=>r.kind==='command').result.kind,'success');
fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({passed:true,fresh:fresh.rows,cold:cold.rows},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:['completed-remove-and-repeat','pending-and-reopened-refusal','dependency-preservation','cold-persistence'],evidence:root},null,2));
