import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import locales from '../src/client/team-locale.cjs';
const require=createRequire(import.meta.url);
process.env.DSH_UI_TEST_MODULES=new URL('../node_modules',import.meta.url).pathname;
const {React,ReactDOM,mount,fire}=require('../src/client/test/renderer.cjs');
const primitives={StateDot:()=>null,IconChevronDownOutlineRegular:()=>null,SettingsForm:()=>null};
const compiled=buildSync({entryPoints:[new URL('../src/client/team-view.tsx',import.meta.url).pathname],bundle:true,write:false,outfile:'task-card-test.cjs',format:'cjs',platform:'node',loader:{'.css':'local-css'},external:['react','react-dom','@deepseek-ai/*'],jsxFactory:'React.createElement',jsxFragment:'React.Fragment'}).outputFiles.find(f=>f.path.endsWith('.cjs')).text;
const module={exports:{}};
new Function('module','exports','require',compiled)(module,module.exports,id=>id==='react'?React:id==='react-dom'?require('react-dom'):primitives);
const {TaskCard}=module.exports;
const t=(key,values={})=>(locales.zh[key]??key).replace(/\{(\w+)\}/g,(full,name)=>String(values[name]??full));
const task=(status='completed')=>({id:'task-1',revision:3,subject:'验收任务',description:'专用任务卡片测试',status,blockedBy:[],writeScopes:[],writeScopeWarnings:[],ready:true});
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));ReactDOM.flushSync(()=>{});};
const button=dom=>dom.all(n=>n.nodeName==='BUTTON'&&n.getAttribute('aria-label')==='移除已完成任务 task-1')[0];

test('only completed tasks offer direct removal; no confirmation is requested',async()=>{
 const before=globalThis.window.confirm;globalThis.window.confirm=()=>{throw new Error('unexpected confirmation');};
 try {
  for(const status of ['pending','in_progress','completed']){
   let calls=0;const dom=mount(React.createElement(TaskCard,{task:task(status),t,onRemove:async current=>{calls++;assert.equal(current.revision,3);}}));
   try {assert.equal(Boolean(button(dom)),status==='completed');if(button(dom)){ReactDOM.flushSync(()=>fire(button(dom),'click'));await settle();assert.equal(calls,1);assert.equal(dom.all(n=>n.getAttribute?.('role')==='dialog').length,0);}}
   finally{dom.unmount();}
  }
 }finally{globalThis.window.confirm=before;}
});
test('an in-flight removal ignores double clicks and displays the busy state',async()=>{
 const gate=Promise.withResolvers();let calls=0;
 const dom=mount(React.createElement(TaskCard,{task:task(),t,onRemove:()=>{calls++;return gate.promise;}}));
 try{const control=button(dom);ReactDOM.flushSync(()=>{fire(control,'click');fire(control,'click');});assert.equal(calls,1);assert.equal(button(dom).disabled,true);assert.ok(button(dom).childNodes.some(node=>/移除中/.test(node.nodeValue??node.textContent)));gate.resolve();await settle();assert.equal(button(dom).disabled,false);}
 finally{gate.resolve();dom.unmount();}
});
test('a rejected stale or dependency mutation keeps the task and shows its reason',async()=>{
 const dom=mount(React.createElement(TaskCard,{task:task(),t,onRemove:async()=>{throw new Error('任务已变化，未移除');}}));
 try{ReactDOM.flushSync(()=>fire(button(dom),'click'));await settle();assert.match(dom.text(),/验收任务/);assert.match(dom.text(),/任务已变化/);assert.ok(dom.all(n=>n.getAttribute?.('role')==='alert').length);assert.equal(button(dom).disabled,false);}
 finally{dom.unmount();}
});
test('the actual client inject face sends one versioned command then refreshes the Lead projection',async()=>{
 let registration;vm.runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:r=>{registration=r;}}},queueMicrotask,setTimeout,clearTimeout});
 const plugin=registration.factory(id=>id==='react'?React:id==='react-dom'?require('react-dom'):primitives);
 const seats=[],commands=[],refresh=[];
 const ctx={locale:{bind:()=>key=>key,register:()=>()=>{}},effect:fn=>fn(),on:()=>()=>{},
  slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{seats.push({options,component});return ()=>{};}},
  configForms:{get:()=>({getSnapshot:()=>({status:'ready',writable:true,revision:1,value:{},user:{}}),subscribe:()=>()=>{},mutate:async()=>false}),whileServed:(_names,fn)=>fn()},
  sessions:{refreshProjections:async id=>{refresh.push(id);}},uiWorkspace:{},
  remote:{$on:()=>()=>{},session:{modelCatalog:async()=>({ok:true,value:{groups:[]}})},commands:{execute:async(...args)=>{commands.push(args);return {ok:true,value:{result:{kind:'success'}}};}}}};
 plugin.apply(ctx);
 await seats.find(s=>s.options.id==='agent-team').options.inject().removeCompletedTask('lead-session','task-7',5);
 assert.deepEqual(JSON.parse(JSON.stringify(commands)),[['lead-session','/team-task-remove task-7 5',[]]]);assert.deepEqual(refresh,['lead-session']);
});
