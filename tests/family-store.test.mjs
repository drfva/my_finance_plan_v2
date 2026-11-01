import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../src/core/store.js';

const clone = value => JSON.parse(JSON.stringify(value));
function fixture({ personal = false, gate, failAfterCommit = false, invalid = false } = {}) {
  const state = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  state.account.id = personal ? 'source' : 'family';
  state.account.plan_kind = personal ? 'personal' : 'family';
  state.family_connection = {id:'family'};
  state.family_private = {membership:{id:'m',source_account_id:'source',active:true}};
  state.family = {id:'family',version:0,categories:[],audit:[]};
  const other = clone(state); other.account = {...state.account,id:'other',plan_kind:'personal'};
  const calls=[],requests=new Map(); let failed=false,refreshes=0;
  const client={
    async rpc(name,args={}) {
      calls.push({name,args:clone(args)});
      if(name==='bootstrap_user')return {data:clone(state),error:null};
      if(name==='state_get')return {data:clone(args.p_account==='other'?other:state),error:null};
      if(name==='state_save'){
        Object.assign(state[args.p_domain],clone(args.p_patch));
        state.versions[args.p_domain]=(state.versions[args.p_domain]??0)+1;
        return {data:{version:state.versions[args.p_domain]},error:null};
      }
      if(name==='family_command'){
        if(requests.has(args.p_request))return {data:requests.get(args.p_request),error:null};
        if(gate)await gate(args);
        if(invalid)return {error:{code:'23514',message:'Неверное значение'}};
        if(args.p_version!==state.family.version)return {error:{code:'PT409',message:'Конфликт'}};
        state.family.categories.push(clone(args.p_payload));state.family.version++;
        const result={family_id:'family'}; requests.set(args.p_request,result);
        if(failAfterCommit&&!failed){failed=true;return {error:{message:'Соединение прервано'}};}
        return {data:result,error:null};
      }
      throw new Error(`Неожиданный RPC ${name}`);
    },
    functions:{async invoke(){refreshes++;return {data:{processed:1},error:null};}},
  };
  return {state,client,calls,get refreshes(){return refreshes;}};
}

test('семейное сохранение: очередь использует свежие версии, переключение ждёт обе правки', async()=>{
  let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);let n=0;
  const f=fixture({gate:async()=>{if(!n++){started();await hold;}}});
  const store=createStore({client:f.client});await store.load();
  const first=store.familyCommand('category',{id:'a',title:'А'});
  const second=store.familyCommand('category',{id:'b',title:'Б'});
  await ready;
  const switched=store.switchAccount('other');
  assert.equal(store.state.account.id,'family');
  assert.equal(f.calls.filter(c=>c.name==='family_command').length,1);
  release();await Promise.all([first,second,switched]);
  assert.equal(store.state.account.id,'other');
  assert.deepEqual(f.state.family.categories.map(c=>c.id),['a','b']);
  assert.deepEqual(f.calls.filter(c=>c.name==='family_command').map(c=>c.args.p_version),[0,1]);
});

test('семейное сохранение: повтор после потерянного ответа использует прежний ID и не дублирует изменение', async()=>{
  const f=fixture({failAfterCommit:true}),store=createStore({client:f.client});await store.load();
  await assert.rejects(store.familyCommand('category',{id:'a',title:'А'}),/прервано/);
  assert.equal(store.hasPending(),true);
  await Promise.all([store.flush(),store.flush()]);
  assert.equal(f.state.family.categories.length,1);
  assert.equal(f.state.family.version,1);
  const requests=f.calls.filter(c=>c.name==='family_command');
  assert.equal(requests.length,2);
  assert.equal(requests[0].args.p_request,requests[1].args.p_request);
  assert.equal(store.hasPending(),false);
  assert.equal(store.status(),'saved');
});

test('семейное сохранение: ошибка проверки не остаётся в бесконечной очереди повторов', async()=>{
  const f=fixture({invalid:true}),store=createStore({client:f.client});await store.load();
  await assert.rejects(store.familyCommand('category',{id:'a',title:''}),/Неверное/);
  assert.equal(store.hasPending(),false);
  await store.flush();
  assert.equal(f.calls.filter(c=>c.name==='family_command').length,1);
});

test('семейный прогноз: личные изменения обновляют его после сохранения; статистический факт не запускает расчёт', async()=>{
  const f=fixture({personal:true}),store=createStore({client:f.client});await store.load();
  store.update('income',d=>{d.periods[0].income_net=12345;});
  await store.flush();
  assert.equal(f.refreshes,1);
  assert.equal(store.state.income.periods[0].income_net,12345);
  assert.equal(store.hasPending(),false);
  store.update('facts',d=>{(d.expense_facts??=[]).push({ym:'2026-11',category_id:'food',amount:1});});
  await store.flush();
  assert.equal(f.refreshes,1);
});

test('история: страница заменяет записи, обновление снимает закреплённый диапазон',async()=>{
  const f=fixture(),base=f.client.rpc.bind(f.client),historyCalls=[];
  f.state.family.audit_anchor=25;
  f.client.rpc=async(name,args)=>{
    if(name!=='family_history_page')return base(name,args);
    historyCalls.push(args);
    return {data:{items:[{id:args.p_page===2?15:30}],page:args.p_page,pages:3,total:25,anchor:args.p_anchor??30},error:null};
  };
  const store=createStore({client:f.client});await store.load();
  await store.familyHistory(2);
  assert.deepEqual(store.state.family.audit,[{id:15}]);assert.equal(store.state.family.audit_page,2);
  assert.equal(historyCalls[0].p_anchor,25);assert.equal(store.state.family.history_loading,false);
  await store.familyHistory(1,{refresh:true});
  assert.equal(historyCalls[1].p_anchor,null);assert.equal(store.state.family.audit_anchor,30);
  assert.deepEqual(store.state.family.audit,[{id:30}]);
});

test('история: запоздавший ответ не заменяет новую страницу и не переносится в другой план',async()=>{
  const f=fixture(),base=f.client.rpc.bind(f.client),pending=[];
  f.client.rpc=async(name,args)=>name==='family_history_page'?new Promise(resolve=>pending.push({args,resolve})):base(name,args);
  const store=createStore({client:f.client});await store.load();
  const second=store.familyHistory(2),third=store.familyHistory(3);
  pending[1].resolve({data:{items:[{id:3}],page:3,pages:3,total:21,anchor:21}});await third;
  pending[0].resolve({data:{items:[{id:13}],page:2,pages:3,total:21,anchor:21}});await second;
  assert.equal(store.state.family.audit_page,3);assert.deepEqual(store.state.family.audit,[{id:3}]);
  const old=store.familyHistory(2);await store.switchAccount('other');
  pending[2].resolve({data:{items:[{id:100}],page:2,pages:3,total:21,anchor:21}});await old;
  assert.equal(store.state.account.id,'other');assert.deepEqual(store.state.family.audit,[]);
});
