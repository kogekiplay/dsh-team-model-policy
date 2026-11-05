import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {retirementDefinition,subagentRetirementDefinition,RETIREMENT_RECORD,SUBAGENT_RETIREMENT_RECORD} from '../retirements.mjs';
const require=createRequire(process.env.DSH_TEST_INSTALL_ANCHOR??'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json');
const {Context}=require('@deepseek-ai/cordis');
const Projection=require('@deepseek-ai/dsh-session-projection').default;
const {Session}=require('@deepseek-ai/dsh-session');
const {createSessionFormatV3ToV4}=require('@deepseek-ai/dsh-session-format-v3-to-v4');
const {z}=require('zod');
const team={id:'retired-team-child',name:'retired-worker',phase:'removed',releasedTasks:['task-1']};
const ordinary={id:'retired-ordinary-child',parentId:'root',mode:'continuable',category:'ordinary',phase:'removed'};
const v3={version:3,id:'root',createdAt:1,cwd:'/audit',isSeeded:false,delegationDepth:0};
function migration(){
 const migrate=createSessionFormatV3ToV4([]),header=migrate.migrateHeader(v3),events=[];
 const stage=migrate.createStage({sourceHeader:v3,targetHeader:header,sourceInheritedEventCount:0,sourceKind:'decoded'});
 const source=[{type:RETIREMENT_RECORD,seq:0,time:2,ignorable:true,data:{version:1,rootId:'root',members:[team]}},{type:SUBAGENT_RETIREMENT_RECORD,seq:1,time:3,ignorable:true,data:{version:1,rootId:'root',members:[ordinary]}}];
 const output={emitEvent:event=>events.push(event),emitRun:()=>{throw new Error('unexpected run');}};
 for(const event of source)stage.transformEvent(event,output);
 assert.equal(stage.finish(output),0);
 return {header,events};
}

test('official V3 to V4 migration retains retired Team and ordinary identities in both live and cold projections',async t=>{
 const {header,events}=migration();
 assert.equal(events[0].type,'plugin:'+RETIREMENT_RECORD);assert.equal(events[1].type,'plugin:'+SUBAGENT_RETIREMENT_RECORD);
 const ctx=new Context();await ctx.plugin(Projection);t.after(()=>ctx.fiber.dispose());
 const defs=[retirementDefinition(z),subagentRetirementDefinition(z)];
 for(const def of defs)await ctx.sessionProjections.register(def);
 const restored=ctx.sessionProjections.restore({},events,0,header,0);
 assert.deepEqual(restored.snapshot.values.teamRetirements.members,[team]);assert.deepEqual(restored.snapshot.values.subagentRetirements.members,[ordinary]);
 const session=Session.create('root',events,header);
 assert.deepEqual(ctx.sessionProjections.snapshot(session).values.teamRetirements.members,[team]);
 const checkpoint=ctx.sessionProjections.checkpoint(session);
 const cold=ctx.sessionProjections.restore(checkpoint,events,0,header,0);
 assert.deepEqual(cold.snapshot.values.subagentRetirements.members,[ordinary]);
});

test('old empty migration checkpoints are invalidated and rebuilt without rewriting any Session events',async t=>{
 const {header,events}=migration(),ctx=new Context();await ctx.plugin(Projection);t.after(()=>ctx.fiber.dispose());
 for(const def of [retirementDefinition(z),subagentRetirementDefinition(z)])await ctx.sessionProjections.register(def);
 const stale=Object.fromEntries(['teamRetirements','subagentRetirements'].map(key=>[key,{ver:1,seq:1,val:{rootId:'root',inheritedEventCount:0,members:[]}}]));
 const before=JSON.stringify(events);assert.equal(ctx.sessionProjections.restoreFloor(stale),0);
 const rebuilt=ctx.sessionProjections.restore(stale,events,0,header,0);
 assert.equal(rebuilt.checkpoint.teamRetirements.ver,2);assert.deepEqual(rebuilt.snapshot.values.teamRetirements.members,[team]);assert.deepEqual(rebuilt.snapshot.values.subagentRetirements.members,[ordinary]);assert.equal(JSON.stringify(events),before);
});

test('mixed migrated and canonical writes remain root-owned, ignore fork inheritance, and fail closed on corruption',()=>{
 const {events}=migration();
 for(const [def,event,row,canonical] of [[retirementDefinition(z),events[0],team,RETIREMENT_RECORD],[subagentRetirementDefinition(z),events[1],ordinary,SUBAGENT_RETIREMENT_RECORD]]){
  const initial=def.init({id:'root'},0),migrated=def.apply(initial,event);assert.equal(migrated.members.length,1);
  const latest=def.apply(migrated,{...event,type:canonical,seq:2,data:{version:1,rootId:'root',members:[{...row,phase:'removing',error:'retry pending'}]}});
  assert.equal(latest.members[0].phase,'removing');assert.equal(latest.members[0].error,'retry pending');
  const fork=def.init({id:'new-root'},3);assert.equal(def.apply(fork,event),fork);
  const wrong=def.init({id:'other-root'},0);assert.equal(def.apply(wrong,event),wrong);
  const bad=def.apply(initial,{...event,data:{version:1,rootId:'root',members:[{id:'root'}]}});assert.equal(typeof bad.failure,'string');assert.equal(def.apply(bad,event),bad);
 }
});
