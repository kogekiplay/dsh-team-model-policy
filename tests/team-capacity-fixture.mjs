import {appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
export const name='team-capacity-fixture';
export const inject=['llm','agents','agentTeams','tools','profileContext','teamRetirements'];
const text=value=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}];
const call=(n,name,args)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'capacity-'+n,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:'capacity-'+n,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
export function apply(ctx,config){
 const require=createRequire(ctx.profileContext.installAnchor),{defineTool}=require('@deepseek-ai/dsh-tools');
 const record=value=>appendFileSync(config.output,JSON.stringify(value)+'\n');let step=0;
 const jsonOutput={schema:{type:'object',additionalProperties:true},render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}]};
 ctx.tools.register(defineTool({name:'audit_capacity_snapshot',description:'Read isolated capacity state and verify the native limit was not changed.',parameters:{},output:jsonOutput,
  execute(_a,exec){const members=ctx.agentTeams.listMembers(exec.agent).filter(r=>r.role==='teammate');const retired=ctx.teamRetirements.state(exec.agent.session).members;const hidden=new Set(retired.filter(r=>r.phase==='removed').map(r=>r.id));const value={id:exec.agent.id,nativeLimit:ctx.agentTeams.roster.maxMembers,historical:members.length,released:members.filter(r=>hidden.has(r.id)).length,occupied:members.filter(r=>!hidden.has(r.id)).length,names:members.map(r=>r.name),tasks:ctx.agentTeams.listTasks(exec.agent)};record({kind:'capacity',...value});return value;}}));
 ctx.tools.register(defineTool({name:'audit_capacity_parallel',description:'Attempt four concurrent creations against one freed slot in an isolated Team.',parameters:{},output:jsonOutput,
  async execute(_a,exec){const results=await Promise.allSettled(Array.from({length:4},(_,n)=>ctx.agentTeams.spawnTeammate(exec.agent,{name:'parallel-'+n,description:'capacity parallel probe',prompt:[{type:'text',text:'CAPACITY_CHILD'}],context:'fresh',provider:'spawn',signal:exec.signal})));return {results:results.map(row=>row.status==='fulfilled'?{ok:true,name:row.value.member.name}:{ok:false,code:row.reason?.code,message:String(row.reason?.message)})};}}));
 ctx.tools.register(defineTool({name:'audit_capacity_failed_reservation',description:'Create one intentionally failed reservation in the isolated Team.',parameters:{},output:jsonOutput,
  async execute(_a,exec){try{await ctx.agentTeams.spawnTeammate(exec.agent,{name:'failed-worker',description:'intentional missing test provider',prompt:[{type:'text',text:'CAPACITY_CHILD'}],context:'fresh',provider:'missing-capacity-provider',signal:exec.signal});throw new Error('missing provider unexpectedly succeeded');}catch(error){return {code:error.code??'unknown'};}}}));
 const creation=(name,native=false)=>[native?'spawn_teammate':'create_teammate',{name,description:'dedicated capacity test',prompt:'CAPACITY_CHILD',context:name.endsWith('1')?'fork':'fresh',...native?{}:{provider:'capacity-audit',model:'audit'}}];
 const remove=name=>['remove_teammate',{target:name}];
 const actions=config.mode==='cold'?[remove('replacement-0'),creation('after-cold'),['audit_capacity_snapshot',{}]]:
  config.mode==='parallel'?[creation('old-0'),creation('old-1'),creation('overflow'),remove('old-0'),['audit_capacity_parallel',{}],['audit_capacity_snapshot',{}]]:
  config.mode==='failed'?[['audit_capacity_failed_reservation',{}],creation('normal-0'),creation('overflow'),remove('failed-worker'),creation('normal-1',true),['audit_capacity_snapshot',{}]]:
  [...Array.from({length:8},(_,n)=>creation('old-'+n)),creation('overflow'),['team_task_create',{subject:'preserve unfinished task',description:'must survive member capacity recovery'}],['team_task_update',{task_id:'task-1',expected_revision:1,action:'reassign',owner:'old-0'}],...Array.from({length:8},(_,n)=>remove('old-'+n)),['list_agents',{}],['audit_capacity_snapshot',{}],...Array.from({length:8},(_,n)=>creation('replacement-'+n,n%2===1)),creation('overflow-after-retire'),creation('old-0'),['audit_capacity_snapshot',{}]];
 const resolveModel=async(provider,model)=>({provider,id:model,name:model,reasoning:{efforts:[{id:'max',name:'max'}],defaultEffort:'max'}});
 const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,image)=>({width:image.width,height:image.height,maxBytes:image.bytes}),listModels:async()=>[{id:'audit',name:'Audit'}],resolveModel,prepareCall:async(provider,model)=>({model:await resolveModel(provider,model),stream:options=>adapter.stream(options)}),
  async *stream(){const agent=ctx.agents.requireInitiator(),member=ctx.agentTeams.membership(agent);record({kind:'request',id:agent.id,role:member.role,name:member.name});if(member.role==='teammate'){yield*text('CAPACITY_CHILD_DONE');return;}const action=actions[step++];yield*action?call(step,action[0],action[1]):text('CAPACITY_FINISHED');}};
 ctx.llm.registerAdapter(['capacity-audit'],adapter);
 ctx.on('tools/result',(exec,result)=>{record({kind:'tool',tool:exec.name,isError:result.isError,...result.isError?{error:result.error}:{value:result.value}});});
}
