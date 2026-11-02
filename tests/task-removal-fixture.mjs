import {appendFileSync} from 'node:fs';
export const name='completed-task-removal-fixture';
export const inject=['llm','agents','agentTeams','commands','sessionProjections'];
const text=value=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}];
const call=(n,name,args)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'task-cleanup-'+n,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:'task-cleanup-'+n,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
export function apply(ctx,config){
 const record=value=>appendFileSync(config.output,JSON.stringify(value)+'\n');let step=0;
 const update=(id,rev,action)=>['team_task_update',{task_id:id,expected_revision:rev,action}];
 const create=(subject,blocked_by=[])=>['team_task_create',{subject,description:'isolated completed task removal audit',blocked_by}];
 const cmd=(id,rev,expected,label)=>({line:'/team-task-remove '+id+' '+rev,expected,label});
 const actions=config.resume?[cmd('task-1',3,'success','cold-idempotent')]:[
  create('completed-row'),update('task-1',1,'claim'),update('task-1',2,'complete'),create('pending-row'),
  cmd('task-1',3,'success','remove-completed'),cmd('task-1',3,'success','repeat'),cmd('task-2',1,'error','refuse-pending'),
  update('task-2',1,'claim'),update('task-2',2,'complete'),update('task-2',3,'reopen'),cmd('task-2',3,'error','refuse-reopened'),
  create('completed-prerequisite'),update('task-3',1,'claim'),update('task-3',2,'complete'),create('dependent-row',['task-3']),cmd('task-3',3,'error','preserve-dependency'),
 ];
 const resolveModel=async(provider,model)=>({provider,id:model,name:model,reasoning:{efforts:[{id:'max',name:'max'}],defaultEffort:'max'}});
 const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,image)=>({width:image.width,height:image.height,maxBytes:image.bytes}),listModels:async()=>[{id:'audit',name:'Audit'}],resolveModel,
  prepareCall:async(provider,model)=>({model:await resolveModel(provider,model),stream:options=>adapter.stream(options)}),
  async *stream(options){
   const agent=ctx.agents.requireInitiator();record({kind:'request',id:agent.id});
   while(step<actions.length){const action=actions[step++];if(Array.isArray(action)){yield*call(step,action[0],action[1]);return;}
    let result;
    try { result=await ctx.commands.execute(agent,action.line,[],options.signal); }
    catch(error) { result={result:{kind:'error',text:error instanceof Error?error.message:String(error)}}; }
    record({kind:'command',label:action.label,result:result?.result});
    if(result?.result.kind!==action.expected)throw new Error('Unexpected command result: '+action.label);
   }
   record({kind:'state',id:agent.id,deleted:ctx.agentTeams.getTask(agent,'task-1'),tasks:ctx.agentTeams.listTasks(agent),projection:ctx.sessionProjections.snapshot(agent.session).values.agentTeam});
   yield*text('TASK_REMOVAL_FINISHED');
  }};
 ctx.llm.registerAdapter(['task-removal-audit'],adapter);
 ctx.on('tools/result',(exec,result)=>{if(exec.name.startsWith('team_task_'))record({kind:'tool',name:exec.name,isError:result.isError,...result.isError?{error:result.error}:{value:result.value}});});
}
