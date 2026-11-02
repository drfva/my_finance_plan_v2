import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../src/core/store.js';

const sample=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
const plan=id=>({...structuredClone(sample),account:{...sample.account,id,plan_kind:'personal'}});
const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(read){
  const calls=[];
  const store=createStore({client:{async rpc(name,args){
    if(name==='bootstrap_user')return {data:plan('mine')};
    assert.equal(name,'state_get');calls.push(args.p_account);
    return read(args.p_account,calls.length);
  }}});
  await store.load();return {store,calls};
}

test('переключение: возврат на текущий план отменяет ещё не завершившийся переход в общий',async()=>{
  const started=pending(),response=pending();
  const {store}=await fixture(async()=>{started.resolve();return response.promise;});
  const shared=store.switchAccount('shared');await started.promise;
  await store.switchAccount('mine');response.resolve({data:plan('shared')});await shared;
  assert.equal(store.state.account.id,'mine');
});

test('переключение: поздний ответ и ошибка предыдущего запроса не отменяют последний выбор',async()=>{
  for(const old of [{data:plan('shared')},{error:{code:'PT403',message:'Нет доступа'}}]){
    const started=pending(),response=pending();
    const {store}=await fixture(async id=>{if(id==='shared'){started.resolve();return response.promise;}return {data:plan(id)};});
    const first=store.switchAccount('shared');await started.promise;
    await store.switchAccount('other');response.resolve(old);await first;
    assert.equal(store.state.account.id,'other');
  }
});

test('переключение: сетевой Load failed Safari повторяется один раз, права не повторяются',async()=>{
  for(const thrown of [false,true]){
    const {store,calls}=await fixture(async(id,n)=>{
      if(n===1){if(thrown)throw new TypeError('Load failed');return {error:{message:'TypeError: Load failed',code:''}};}
      return {data:plan(id)};
    });
    await store.switchAccount('shared');assert.equal(store.state.account.id,'shared');
    assert.deepEqual(calls,['shared','shared']);
  }
  const {store,calls}=await fixture(async()=>({error:{code:'PT403',message:'Нет доступа'}}));
  await assert.rejects(store.switchAccount('shared'),/Нет доступа/);
  assert.deepEqual(calls,['shared']);assert.equal(store.state.account.id,'mine');
});

test('переключение: постоянный сетевой сбой сохраняет открытый план и позволяет повторить выбор',async()=>{
  let online=false;
  const {store,calls}=await fixture(async id=>online?{data:plan(id)}:{error:{message:'Load failed'}});
  await assert.rejects(store.switchAccount('shared'),{code:'NETWORK_ERROR'});
  assert.equal(calls.length,2);assert.equal(store.state.account.id,'mine');
  online=true;await store.switchAccount('shared');assert.equal(store.state.account.id,'shared');
  const wrong=await fixture(async()=>({data:plan('unexpected')}));
  await assert.rejects(wrong.store.switchAccount('shared'),/выбранный план/);
  assert.equal(wrong.store.state.account.id,'mine');
});
