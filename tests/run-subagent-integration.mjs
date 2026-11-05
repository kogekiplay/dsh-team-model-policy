import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const root=fs.mkdtempSync(path.join(project,'.evidence/ordinary-subagent-'));
const app='/Applications/DeepSeek Harness.app/Contents';
const cli=process.env.DSH_TEST_CLI?JSON.parse(process.env.DSH_TEST_CLI):fs.existsSync(app+'/Resources/app.asar')?[app+'/MacOS/DeepSeek Harness',app+'/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js']:['dsh'];
const reports=[];
function run(mode,{home=path.join(root,mode+'-home'),sessionId,targetId}={}){
 const output=path.join(root,mode+'.jsonl'),env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'};
 for(const key of Object.keys(env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(key))delete env[key];
 const init=spawnSync(cli[0],[...cli.slice(1),'--profile','headless','--dump-config'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});fs.writeFileSync(path.join(root,mode+'.init.stderr.log'),init.stderr??'');assert.equal(init.status,0,'initialize '+root);
 const patch=[{id:'agent-default-model',config:{provider:'route-audit',model:'gpt-6.1-sol',reasoningEffort:'max'}},{id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},{id:'subagent',config:{maxDepth:4,maxActiveSubagents:16}},{id:'tool-subagent-control',disabled:true},{insert:[{id:'audit-workspace',name:'@deepseek-ai/dsh-workspace'},{id:'audit-team',name:'@deepseek-ai/dsh-experimental-agent-team'},{id:'audit-team-tools',name:'@deepseek-ai/dsh-experimental-tool-agent-team'},{id:'ordinary-fixture',name:path.join(project,'tests/subagent-fixture.mjs'),config:{output,mode,...targetId?{targetId}:{}}},{id:'audit-retirements',name:path.join(project,'retirements.mjs')}]}];
 fs.writeFileSync(path.join(home,'profiles/headless/cordis.patch.yml'),JSON.stringify(patch,null,2)+'\n');
 const child=spawnSync(cli[0],[...cli.slice(1),'--profile','headless',...sessionId?['--session-id',sessionId]:[],'ORDINARY_ROOT'],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});
 fs.writeFileSync(path.join(root,mode+'.stdout.log'),child.stdout??'');fs.writeFileSync(path.join(root,mode+'.stderr.log'),child.stderr??'');
 const rows=fs.existsSync(output)?fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 reports.push({mode,status:child.status,signal:child.signal,error:child.error?.message,rows});fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(reports,null,2)+'\n');
 assert.equal(child.status,0,mode+' failed '+root);assert.match(child.stdout,/ORDINARY_AUDIT_FINISHED/);
 return {rows,tools:rows.filter(e=>e.kind==='tool'),home};
}
function assertRemoval(result,nested){
 const target=result.rows.find(e=>e.kind==='child-started'&&e.role==='target').id;
 const sibling=result.rows.find(e=>e.kind==='child-started'&&e.role==='sibling').id;
 const grand=result.rows.find(e=>e.kind==='child-started'&&e.role==='nested')?.id;
 const removal=result.tools.find(e=>e.tool===(nested?'remove_subagent':'audit_remove_command'));
 assert.equal(removal.isError,false);
 if(nested)assert.deepEqual(removal.value.removedSessionIds,[target,grand]);else assert.equal(removal.value.commandSuccess,true);
 const exit=result.rows.findIndex(e=>e.kind==='owned-worker-exit');assert.ok(exit>=0&&exit<result.rows.indexOf(removal),'worker must exit before reporting success');
 const state=result.rows.find(e=>e.kind==='state');assert.equal(state.archived,true);assert.equal(state.resident,false);assert.equal(state.headerExists,true);assert.ok(state.catalogIds.includes(target));if(grand)assert.ok(state.retired.includes(grand));
 assert.equal(result.tools.find(e=>e.tool==='audit_direct_send').value.blocked,true);
 assert.deepEqual(result.tools.filter(e=>e.tool==='list_manageable_subagents').at(-1).value.children.map(e=>e.id),[sibling]);
 return {target,grand,rootId:result.rows.find(e=>e.kind==='request'&&e.role==='lead').id};
}
const nested=run('normal'),identity=assertRemoval(nested,true);
const cold=run('cold',{home:nested.home,sessionId:identity.rootId,targetId:identity.target});assert.equal(cold.tools.find(e=>e.tool==='remove_subagent').value.alreadyRemoved,true);assert.equal(cold.tools.find(e=>e.tool==='audit_direct_send').value.blocked,true);assert.ok(!cold.rows.some(e=>e.kind==='request'&&[identity.target,identity.grand].includes(e.id)));
assertRemoval(run('command'),false);
const safety=run('safety');assert.equal(safety.tools.filter(e=>e.tool==='remove_subagent').length,3);assert.ok(safety.tools.filter(e=>e.tool==='remove_subagent').every(e=>e.isError));
console.log(JSON.stringify({passed:true,cases:['nested-running-removal','removed-subtree-cold-resume','slash-command-removal','self-unrelated-external-refusal'],evidence:root},null,2));
