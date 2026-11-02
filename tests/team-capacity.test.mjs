import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capacityOf,capacitySpawn} from '../team-capacity.mjs';
const row=(id,name=id,status='inactive')=>({id,name,role:'teammate',status});
const removed=(id,name=id,phase='removed')=>({id,name,phase});

test('capacity credits only matching successful removals and never inactive, failed or removing members',()=>{
 const rows=[{id:'lead',role:'lead'},row('a'),row('b','b','failed'),row('c','c','provisioning'),row('d')];
 const state=capacityOf(8,rows,{members:[removed('a'),removed('b','b','removing'),removed('c','wrong-name'),removed('other'),{...removed('d'),error:'cleanup incomplete'}]});
 assert.deepEqual(state,{limit:8,occupied:3,released:1,historical:4,ceiling:9});
});
test('a fully retired historical roster releases its configured capacity without reusing identities',()=>{
 const rows=Array.from({length:8},(_,n)=>row('old-'+n));
 const state=capacityOf(8,rows,{members:rows.map(r=>removed(r.id,r.name))});
 assert.deepEqual(state,{limit:8,occupied:0,released:8,historical:8,ceiling:16});
 assert.equal(rows.length,8);assert.equal(rows[0].name,'old-0');
});
test('invalid or corrupt capacity state fails closed',()=>{
 for(const limit of [0,-1,Infinity])assert.throws(()=>capacityOf(limit,[],{members:[]}));
 assert.throws(()=>capacityOf(8,[],{failure:'bad state',members:[]}));
 assert.throws(()=>capacityOf(8,[],undefined));
 assert.throws(()=>capacityOf(Number.MAX_SAFE_INTEGER,[row('a')],{members:[removed('a')]}));
});
test('overlapping creations get independent readonly roster views across Teams',async()=>{
 const a={id:'a',session:{id:'a'}},b={id:'b',session:{id:'b'}},entries=new Map([[a,Array.from({length:8},(_,n)=>row('a'+n))],[b,[row('b0')]]]);
 const gate=Promise.withResolvers();const ceilings=[];
 const roster={maxMembers:8,async spawn(caller){ceilings.push([caller.id,this.maxMembers]);await gate.promise;return this.maxMembers;}};
 const native={roster,membership:caller=>({role:'lead',root:caller}),listMembers:root=>entries.get(root)};
 const retirements={state:session=>({members:session.id==='a'?entries.get(a).map(r=>removed(r.id)):[]})};
 const spawn=capacitySpawn(native,retirements,body=>body());
 const first=spawn(a,{}),second=spawn(b,{});assert.equal(roster.maxMembers,8);assert.deepEqual(ceilings,[['a',16],['b',8]]);
 gate.resolve();assert.deepEqual(await Promise.all([first,second]),[16,8]);assert.equal(roster.maxMembers,8);
});
test('real full capacity reports logical occupancy and preserves native duplicate-name errors',async()=>{
 const root={id:'root',session:{}},roster={maxMembers:2,async spawn(){const limit=this.maxMembers;throw Object.assign(new Error('Team member limit '+limit+' reached'),{code:'TEAM_MEMBER_LIMIT'});}};
 const native={roster,membership:()=>({role:'lead',root}),listMembers:()=>[row('a'),row('b'),row('old')]};
 const spawn=capacitySpawn(native,{state:()=>({members:[removed('old')]})},body=>body());
 await assert.rejects(spawn(root,{}),e=>e.code==='TEAM_MEMBER_LIMIT'&&e.details.limit===2&&e.details.occupied===2&&e.message.includes('2/2'));
 const duplicate=Object.assign(new Error('name reserved'),{code:'TEAM_MEMBER_NAME_TAKEN'});roster.spawn=async()=>{throw duplicate;};
 await assert.rejects(spawn(root,{}),e=>e===duplicate);assert.equal(roster.maxMembers,2);
});
test('non-Lead requests and unsupported native layouts cannot bypass creation authority',async()=>{
 const native={roster:{maxMembers:2,spawn(){throw new Error('must not execute');}},membership:()=>({role:'teammate'})};
 const spawn=capacitySpawn(native,{state:()=>({members:[]})},body=>body());await assert.rejects(spawn({},{}),{code:'TEAM_LEAD_REQUIRED'});
 assert.throws(()=>capacitySpawn({roster:{}},{},body=>body()),/Unsupported/);
 const frozen=Object.freeze({maxMembers:2,spawn(){}});assert.throws(()=>capacitySpawn({roster:frozen},{},body=>body()),/Unsupported/);
});
