import {test} from 'node:test';
import assert from 'node:assert/strict';
import {removeCompletedTask, registerTaskActions} from '../task-actions.mjs';

function fixture(status='completed', revision=3) {
 const calls=[], caller={id:'lead'};
 const ctx={agentTeams:{membership:()=>({role:'lead'}),getTask:()=>({id:'task-1',status,revision}),updateTask:async(_a,change)=>{calls.push(change);return {...change,status:'deleted'};}}};
 return {ctx,caller,calls};
}
test('completed task removal uses its exact revision and native delete transition', async()=>{
 const f=fixture();const result=await removeCompletedTask(f.ctx,f.caller,'task-1',3);
 assert.deepEqual(f.calls,[{taskId:'task-1',expectedRevision:3,action:'delete'}]);assert.equal(result.removed,true);
});
test('pending, reopened, in-progress and stale completed tasks are not removed',async()=>{
 for(const status of ['pending','in_progress']){const f=fixture(status);await assert.rejects(removeCompletedTask(f.ctx,f.caller,'task-1',3),{code:'TEAM_TASK_NOT_COMPLETED'});assert.deepEqual(f.calls,[]);}
 const f=fixture('completed',4);await assert.rejects(removeCompletedTask(f.ctx,f.caller,'task-1',3),{code:'TEAM_TASK_STALE_REVISION'});assert.deepEqual(f.calls,[]);
});
test('dependency and transaction conflicts are surfaced without retry or graph mutation',async()=>{
 for(const code of ['TEAM_TASK_HAS_DEPENDENTS','TEAM_TASK_STALE_REVISION']){const f=fixture();f.ctx.agentTeams.updateTask=async(_a,change)=>{f.calls.push(change);throw Object.assign(new Error('native refusal'),{code});};await assert.rejects(removeCompletedTask(f.ctx,f.caller,'task-1',3),e=>e.code===code&&e.message.includes('未移除'));assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'delete');}
});
test('non-Lead, cancelled and malformed calls are refused before updates',async()=>{
 const f=fixture();f.ctx.agentTeams.membership=()=>({role:'teammate'});await assert.rejects(removeCompletedTask(f.ctx,f.caller,'task-1',3),{code:'TEAM_LEAD_REQUIRED'});
 for(const [id,rev] of [['bad',3],['task-1',0],['task-1',Number.MAX_SAFE_INTEGER+1]])await assert.rejects(removeCompletedTask(f.ctx,f.caller,id,rev),{code:'TEAM_TASK_INVALID_ARGUMENT'});
 const controller=new AbortController();controller.abort(new Error('cancelled'));await assert.rejects(removeCompletedTask(f.ctx,f.caller,'task-1',3,controller.signal),/cancelled/);assert.deepEqual(f.calls,[]);
});
test('repeated deletion is idempotent and the command invokes the same operation once',async()=>{
 const f=fixture('deleted',4);assert.equal((await removeCompletedTask(f.ctx,f.caller,'task-1',3)).alreadyRemoved,true);assert.deepEqual(f.calls,[]);
 const g=fixture();let command;g.ctx.commands={register:d=>{command=d;return ()=>{};}};registerTaskActions(g.ctx);
 assert.equal((await command.handler({agent:g.caller,rawInput:' task-1 3',signal:new AbortController().signal})).kind,'success');assert.equal(g.calls.length,1);
 assert.equal((await command.handler({agent:g.caller,rawInput:'task-1',signal:new AbortController().signal})).kind,'error');assert.equal(g.calls.length,1);
});
