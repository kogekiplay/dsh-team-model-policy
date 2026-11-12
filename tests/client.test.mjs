import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
function fixture(response={ok:true,value:{result:{kind:'success'}}}) {
 let registration;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>{registration=value;}}}});
 const imports=[];const plugin=registration.factory(id=>{imports.push(id);assert.equal(id,'react');return require('react');});
 const seats=[],commands=[],refresh=[],disposers=[];
 const ctx={locale:{bind:()=>key=>key,register:()=>()=>{}},effect:fn=>{const dispose=fn();if(dispose)disposers.push(dispose);},
  slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{seats.push({options,component});return ()=>{seats.splice(0);};}},
  sessions:{refreshProjections:async id=>{refresh.push(id);}},
  remote:{commands:{execute:async(...args)=>{commands.push(args);return response;}}}};
 plugin.apply(ctx);return {plugin,imports,seats,commands,refresh,ctx,dispose:()=>{for(const fn of disposers.reverse())fn();}};
}
test('only the native task-board footer is enhanced and no platform UI package is imported',()=>{
 const f=fixture();assert.deepEqual(f.imports,['react']);assert.equal(f.seats.length,1);
 assert.equal(f.seats[0].options.name,'conversation.session.header.actions.subagent.footer');
 assert.equal(f.seats[0].options.id,'agent-team');assert.equal(f.seats[0].options.priority,-1);
 f.dispose();assert.equal(f.seats.length,0);
});
test('the installed factory invokes one revision-fenced command and then refreshes its projection',async()=>{
 const f=fixture();await f.seats[0].options.inject().removeCompletedTask('root','task-7',5);
 assert.deepEqual(JSON.parse(JSON.stringify(f.commands)),[['root','/team-task-remove task-7 5',[]]]);assert.deepEqual(f.refresh,['root']);
});
test('failed commands keep their reason and never report a successful refresh',async()=>{
 const f=fixture({ok:true,value:{result:{kind:'error',text:'任务已变化，未移除'}}});
 await assert.rejects(f.seats[0].options.inject().removeCompletedTask('root','task-7',5),/任务已变化/);assert.deepEqual(f.refresh,[]);
});
test('a projection refresh error does not turn a confirmed native deletion into a failed mutation',async()=>{
 const f=fixture();f.ctx.sessions.refreshProjections=async()=>{throw new Error('reconnecting');};
 await f.seats[0].options.inject().removeCompletedTask('root','task-7',5);assert.equal(f.commands.length,1);
});
test('the removal action ignores rapid duplicates and records success without asking for confirmation',async()=>{
 const {plugin}=fixture(),gate=Promise.withResolvers(),states=[];let calls=0;
 const run=plugin.createRemovalAction(async(id,revision)=>{calls++;assert.equal(id,'task-1');assert.equal(revision,3);await gate.promise;},{id:'task-1',revision:3,status:'completed'},state=>states.push(state));
 const first=run();await run();assert.equal(calls,1);assert.equal(states.at(-1).busy,true);gate.resolve();await first;
 assert.equal(states.at(-1).removed,true);assert.equal(states.at(-1).busy,false);
});
test('pending tasks cannot be removed and a rejected completed task stays retryable',async()=>{
 const {plugin}=fixture();let calls=0;const states=[];
 await plugin.createRemovalAction(async()=>{calls++;},{status:'pending'},()=>{})();assert.equal(calls,0);
 const run=plugin.createRemovalAction(async()=>{calls++;throw new Error('dependency');},{id:'task-1',revision:3,status:'completed'},state=>states.push(state));
 await run();assert.equal(states.at(-1).removed,false);assert.equal(states.at(-1).error,'dependency');await run();assert.equal(calls,2);
});
