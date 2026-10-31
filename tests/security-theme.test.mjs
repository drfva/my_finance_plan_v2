import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, readTheme, nextTheme, currentTheme } from '../src/core/theme.js';
import { createSecurity } from '../src/core/security.js';
import { accountDeletionDialog } from '../src/ui/settings.js';

const preview=()=>({version:'v1',plans:[{id:'p',title:'Мой личный план',delete:true,blocked:false,recipients:[]}],family:{title:'Семья',last_member:true}});
test('кнопка темы: светлая → тёмная → системная, выбор сохраняется и без доступного хранилища',()=>{
  assert.equal(nextTheme('light'),'dark');assert.equal(nextTheme('dark'),'system');assert.equal(nextTheme('system'),'light');
  const storage={setItem:()=>{throw new Error('blocked');}},root={setAttribute:()=>{},removeAttribute:()=>{}};
  for(const mode of ['light','dark','system']){applyTheme(mode,{root,storage});assert.equal(currentTheme(),mode);}
});
function client(handler){
  const calls=[],signouts=[];
  return {calls,signouts,auth:{signOut:async args=>{signouts.push(args);return {};}},rpc:async(name,args)=>{
    calls.push({name,args});return handler?handler(name,args):{data:preview()};
  }};
}

test('тема: светлая и тёмная сохраняются, системная снимает принудительную тему',()=>{
  const values=new Map(),attrs=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const root={setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
  for(const mode of ['light','dark']){applyTheme(mode,{root,storage});assert.equal(readTheme(storage),mode);assert.equal(attrs.get('data-theme'),mode);}
  applyTheme('system',{root,storage});assert.equal(readTheme(storage),'system');assert.equal(attrs.has('data-theme'),false);
});

test('тема: недоступное хранилище не мешает переключению, неизвестное значение возвращает системную тему',()=>{
  let selected;
  const root={setAttribute:(k,v)=>{selected=v;},removeAttribute:()=>{selected=null;}};
  const storage={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  assert.equal(readTheme(storage),'system');
  applyTheme('dark',{root,storage});assert.equal(selected,'dark');
  applyTheme('unknown',{root,storage});assert.equal(selected,null);
});

test('удаление аккаунта: без подтверждения и при единственном владельце запрос не отправляется',async()=>{
  const c=client(),sec=createSecurity(c);await sec.prepareDeletion();
  assert.equal(await sec.deleteAccount('да'),false);
  sec.state.deletion.preview.plans[0].blocked=true;
  assert.equal(await sec.deleteAccount('УДАЛИТЬ'),false);
  assert.equal(c.calls.length,1);assert.equal(c.signouts.length,0);
});

test('удаление аккаунта: только собственная учётная запись, повторный клик не дублирует запрос, сессия очищается',async()=>{
  let complete;
  const c=client((name)=>name==='account_deletion_preview'?{data:preview()}:new Promise(resolve=>{complete=resolve;}));
  const sec=createSecurity(c);await sec.prepareDeletion();
  const first=sec.deleteAccount('УДАЛИТЬ');
  assert.equal(await sec.deleteAccount('УДАЛИТЬ'),false);
  complete({data:{deleted:true}});assert.equal(await first,true);
  assert.deepEqual(c.calls[1],{name:'delete_my_account',args:{p_confirmation:'УДАЛИТЬ',p_version:'v1'}});
  assert.deepEqual(c.signouts,[{scope:'local'}]);
});

test('удаление аккаунта: изменение состава перечитывает условия и сбрасывает подтверждение',async()=>{
  let reads=0;
  const c=client(name=>name==='account_deletion_preview'?{data:{...preview(),version:`v${++reads}`}}:{error:{code:'PT409',message:'Состав планов изменился'}});
  const sec=createSecurity(c);await sec.prepareDeletion();sec.state.deletion.confirmation='УДАЛИТЬ';
  assert.equal(await sec.deleteAccount('УДАЛИТЬ'),false);
  assert.equal(sec.state.deletion.preview.version,'v2');assert.equal(sec.state.deletion.confirmation,'');
  assert.equal(sec.state.deletion.error,'Состав планов изменился');assert.equal(c.signouts.length,0);
});

test('удаление аккаунта: ошибка сети сохраняет окно и сессию, подтверждённое удаление не зависит от сетевого logout',async()=>{
  const c=client(name=>name==='account_deletion_preview'?{data:preview()}:Promise.reject(new Error('offline')));
  const sec=createSecurity(c);await sec.prepareDeletion();assert.equal(await sec.deleteAccount('УДАЛИТЬ'),false);
  assert.equal(sec.state.deleting,false);assert.equal(sec.state.deletion.error,'offline');assert.equal(c.signouts.length,0);
  c.rpc=async()=>({data:{deleted:true}});c.auth.signOut=async()=>{throw new Error('offline logout');};
  assert.equal(await sec.deleteAccount('УДАЛИТЬ'),true);
});

test('удаление аккаунта: окно показывает последствия для последнего участника и блокировку общего плана',async()=>{
  const sec=createSecurity(client());await sec.prepareDeletion();
  let html=accountDeletionDialog({security:sec});
  assert.match(html,/семейный план тоже будет удалён/);assert.match(html,/data-account-delete-word/);
  assert.match(html,/data-account-delete-confirm="" disabled/);
  sec.state.deletion.preview.plans[0]={id:'p',title:'Общий',delete:false,blocked:true,recipients:[{id:'b',email:'b@example.test'}]};
  html=accountDeletionDialog({security:sec});assert.match(html,/Назначить владельцем/);assert.doesNotMatch(html,/data-account-delete-confirm/);
});
