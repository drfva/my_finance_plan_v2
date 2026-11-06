import {esc} from './dom.js';
import {uid} from './edit.js';
import {isValid} from '../engine/dates.js';
import {simulate,goalBalanceAt,goalMilestoneAt} from '../engine/allocation.js';
import {setGoalView} from './goal-card.js';

const ownStages=(ctx,id)=>(ctx.state.savings.goal_milestones??[]).filter(m=>m.goal_id===id).sort((a,b)=>(a.deadline||'9999').localeCompare(b.deadline||'9999'));
const val=(name,label,value,type='text')=>`<label>${esc(label)}<input data-goal-modal-field="${name}" type="${type}"${name==='amount'?' inputmode="decimal"':''} value="${esc(value??'')}"></label>`;
function openOperation(ctx,gid,tx=null,stage=null){
 const list=ownStages(ctx,gid),goal=ctx.state.savings.goals.find(g=>g.id===gid);
 const draft={goal_id:gid,id:tx?.id??null,kind:tx?.kind?.startsWith('transfer')?'transfer':tx?.kind??'spend',
  direction:tx?.kind==='transfer_in'?'in':'out',purpose:tx?.purpose??'goal',milestone_id:stage?.id??tx?.milestone_id??list[0]?.id??'',
  amount:tx?.amount??(stage?stage.target:''),date:tx?.date??stage?.deadline??ctx.today,title:tx?.title??stage?.title??'',
  to:tx?.counterparty_id??ctx.state.savings.goals.find(g=>g.id!==gid)?.id??''};
 if(tx&&!tx.purpose)draft.purpose='other';
 ctx.ui.goalModal={kind:'operation',goal_id:gid,title:tx?'Изменить операцию':`Операция · ${goal.title}`,draft};
}

/* Вся операция, включая обе стороны перевода, сохраняется одним изменением. */
export function goalOperationRows(ctx,draft){
 const goal=ctx.state.savings.goals.find(g=>g.id===draft.goal_id),amount=ctx.fmt.parseMoney(draft.amount);
 if(!goal||!(amount>0)||!Number.isFinite(amount))throw new Error('Укажите положительную сумму операции');
 if(!isValid(draft.date))throw new Error('Укажите корректную дату операции');
 const existing=ctx.state.savings.goal_transactions?.find(t=>t.id===draft.id),list=ownStages(ctx,goal.id);
 const transfer=draft.kind==='transfer';
 const purpose=!transfer&&draft.kind==='spend'?draft.purpose:'other';
 if(purpose==='goal'&&list.length&&!list.some(m=>m.id===draft.milestone_id))throw new Error('Выберите этап этой копилки');
 const row={...existing,id:existing?.id??uid('tx'),goal_id:goal.id,date:draft.date,amount,
  kind:transfer?(draft.direction==='in'?'transfer_in':'transfer_out'):draft.kind,title:String(draft.title||''),
  purpose,milestone_id:purpose==='goal'&&list.length?draft.milestone_id:null,counterparty_id:null,
  source:existing?.source??'manual',user_edited:true,occurrence_key:existing?.occurrence_key??null};
 if(!['spend','deposit','transfer_in','transfer_out'].includes(row.kind))throw new Error('Неизвестный вид операции');
 const oldPair=existing?.occurrence_key?.startsWith('transfer:')?(ctx.state.savings.goal_transactions??[]).filter(t=>t.occurrence_key===existing.occurrence_key):[];
 const remove=new Set([existing?.id,...oldPair.map(t=>t.id)].filter(Boolean)),rows=[row];
 if(transfer){
  const other=ctx.state.savings.goals.find(g=>g.id===draft.to&&g.id!==goal.id);
  if(!other)throw new Error('Выберите другую копилку для перевода');
  const base=ctx.sim.savingsFx.toBase(amount,goal.currency_code,draft.date),converted=base===null?null:ctx.sim.savingsFx.fromBase(base,other.currency_code,draft.date);
  if(converted===null)throw new Error('Нет курса валюты для перевода');
  const key=oldPair.length?existing.occurrence_key:`transfer:${uid('pair')}`,oldOther=oldPair.find(t=>t.id!==existing.id);
  row.counterparty_id=other.id;row.occurrence_key=key;row.purpose='other';
  rows.push({id:oldOther?.id??uid('tx'),goal_id:other.id,date:row.date,amount:converted,kind:row.kind==='transfer_out'?'transfer_in':'transfer_out',title:row.title,
   counterparty_id:goal.id,occurrence_key:key,source:'manual',user_edited:true,purpose:'other',milestone_id:null});
 }
 return {rows,remove,existing};
}

export function renderGoalDialog(ctx){
 const modal=ctx.ui.goalModal;if(!modal)return '';
 const d=modal.draft,goal=ctx.state.savings.goals.find(g=>g.id===modal.goal_id);if(!goal)return '';
 let fields='';
 if(modal.kind==='operation'){
  const list=ownStages(ctx,goal.id),transfer=d.kind==='transfer',spend=d.kind==='spend';
  fields=`<div class="goal-modal-grid"><label>Операция<select data-goal-modal-field="kind"><option value="spend"${spend?' selected':''}>Трата</option><option value="deposit"${d.kind==='deposit'?' selected':''}>Пополнение</option><option value="transfer"${transfer?' selected':''}>Перевод в другую цель</option></select></label>
    ${val('amount',`Сумма, ${goal.currency_code}`,d.amount)}${val('title','Название',d.title)}${val('date','Дата',d.date,'date')}
    ${transfer?`<label>Куда<select data-goal-modal-field="to">${ctx.state.savings.goals.filter(g=>g.id!==goal.id).map(g=>`<option value="${esc(g.id)}"${g.id===d.to?' selected':''}>${esc(g.title)}</option>`).join('')}</select></label>`:''}</div>
    ${spend?`<fieldset class="goal-purpose-choices"><legend>На что потратили?</legend><label><input type="radio" name="goal-op-purpose" data-goal-modal-field="purpose" value="goal"${d.purpose==='goal'?' checked':''}>На эту цель</label><label><input type="radio" name="goal-op-purpose" data-goal-modal-field="purpose" value="other"${d.purpose==='other'?' checked':''}>На другое</label></fieldset>
    ${d.purpose==='goal'&&list.length?`<label class="goal-modal-stage">Этап<select data-goal-modal-field="milestone_id">${list.map(m=>`<option value="${esc(m.id)}"${m.id===d.milestone_id?' selected':''}>${esc(m.title||'Этап')}</option>`).join('')}</select></label>`:''}
    <p class="small-note">${d.purpose==='goal'?'Покупка засчитывается в выбранный этап. Потраченное не нужно копить повторно.':'Деньги уйдут из копилки. Потраченное потребуется восполнить.'}</p>`:''}
    <div data-goal-operation-preview class="goal-operation-preview" aria-live="polite"></div>`;
 }else if(modal.kind==='stage')fields=`<div class="goal-modal-grid">${val('title','Название этапа',d.title)}${val('amount',`Сколько накопить, ${goal.currency_code}`,d.amount)}${val('date','Срок (необязательно)',d.date,'date')}</div>`;
 else fields=`<div class="goal-modal-grid">${val('title','Название повторения',d.title)}${val('amount',`Сумма, ${goal.currency_code}`,d.amount)}${val('date','Дата первого этапа',d.date,'date')}<label>Повторять<select data-goal-modal-field="period_unit"><option value="year" selected>Каждый год</option><option value="month">Каждый месяц</option></select></label></div><p class="small-note">Этапы появятся сразу при создании нового года плана. Автоматические траты включаются отдельно во вкладке «Повторения».</p>`;
 return `<dialog class="goal-operation-dialog" aria-label="${esc(modal.title)}"><form data-goal-modal-form><div class="row between"><h2>${esc(modal.title)}</h2><button type="button" class="ghost small" data-goal-modal-close aria-label="Закрыть окно">✕</button></div>${fields}<p class="goal-modal-error info-box" role="alert"${modal.error?'':' hidden'}>${esc(modal.error||'')}</p><div class="row goal-modal-actions"><button type="submit" class="primary" data-goal-modal-save>Сохранить</button><button type="button" class="ghost" data-goal-modal-close>Отмена</button></div></form></dialog>`;
}

export function saveGoalModal(ctx){
 if(!ctx.canEdit)throw new Error('Изменять копилку может только редактор');
 const modal=ctx.ui.goalModal;if(!modal)return;
 const d=modal.draft,gid=modal.goal_id;
 if(modal.kind==='operation'){
  const result=goalOperationRows(ctx,d);ctx.ui.goalModal=null;setGoalView(ctx,gid,'movements');ctx.ui.lastGoalTransaction=result.rows[0].id;ctx.ui.scrollTarget={row:result.rows[0].id};
  ctx.store.update('savings',s=>{
   s.goal_transactions=(s.goal_transactions??[]).filter(t=>!result.remove.has(t.id));s.goal_transactions.push(...result.rows);
   if(result.existing?.source!=='manual'&&result.existing?.milestone_id){const m=s.goal_milestones.find(m=>m.id===result.existing.milestone_id);if(m)m.user_edited=true;}
  });return;
 }
 const amount=ctx.fmt.parseMoney(d.amount);if(!(amount>0)||!String(d.title).trim())throw new Error('Укажите название и положительную сумму');
 if(d.date&&!isValid(d.date))throw new Error('Проверьте дату');
 if(modal.kind==='stage'){
  const row={id:uid('ms'),goal_id:gid,title:d.title,target:amount,deadline:d.date||null,sort_order:ownStages(ctx,gid).length+1,source:'manual',user_edited:false};
  ctx.ui.goalModal=null;setGoalView(ctx,gid,'stages');ctx.ui.open.add(`goal-stage:${row.id}`);ctx.ui.scrollTarget={row:row.id};
  ctx.store.update('savings',s=>{
   const first=!(s.goal_milestones??[]).some(m=>m.goal_id===gid);(s.goal_milestones??=[]).push(row);
   if(first)for(const t of s.goal_transactions??[])if(t.goal_id===gid&&t.purpose==='goal'&&!t.milestone_id)t.milestone_id=row.id;
  });return;
 }
 if(!isValid(d.date))throw new Error('Укажите дату первого этапа');
 const id=uid('cycle'),msid=`cyc:${id}:${d.date}`,oldId=d.milestone_id;
 ctx.ui.goalModal=null;setGoalView(ctx,gid,'repeats');
 ctx.store.update('savings',s=>{
  (s.goal_cycles??=[]).push({id,goal_id:gid,title:d.title,amount,every_n:1,period_unit:d.period_unit||'year',start_date:d.date,repeats:null,auto_spend:false,enabled:true});
  const existing=(s.goal_milestones??[]).find(m=>m.id===oldId);
  if(existing)Object.assign(existing,{id:msid,title:d.title,target:amount,deadline:d.date,source:'cycle',source_ref:id,occurrence_key:d.date,user_edited:false});
  else{(s.goal_milestones??=[]).push({id:msid,goal_id:gid,title:d.title,target:amount,deadline:d.date,source:'cycle',source_ref:id,occurrence_key:d.date,user_edited:false,sort_order:0});const g=s.goals.find(g=>g.id===gid);g.target_amount=0;g.deadline=null;}
  for(const t of s.goal_transactions??[])if(t.goal_id===gid&&(oldId?t.milestone_id===oldId:t.purpose==='goal'&&!t.milestone_id)){t.milestone_id=msid;t.user_edited=true;}
 });
}

export function handleGoalCardAction(ev,ctx){
 const target=ev.target,tab=target.closest('[data-goal-card-tab]'),menu=target.closest('[data-goal-menu-toggle]'),stage=target.closest('[data-goal-stage-toggle]');
 if(tab){setGoalView(ctx,tab.dataset.goalId,tab.dataset.goalCardTab);return true;}
 if(menu){const key=`goal-menu:${menu.dataset.goalMenuToggle}`,open=ctx.ui.open.has(key);for(const k of [...ctx.ui.open])if(k.startsWith('goal-menu:'))ctx.ui.open.delete(k);if(!open)ctx.ui.open.add(key);return true;}
 if(stage){const key=`goal-stage:${stage.dataset.goalStageToggle}`;ctx.ui.open.has(key)?ctx.ui.open.delete(key):ctx.ui.open.add(key);return true;}
 if(target.closest('[data-goal-modal-close]')){ctx.ui.goalModal=null;return true;}
 const op=target.closest('[data-goal-op-open]'),edit=target.closest('[data-goal-op-edit]'),spend=target.closest('[data-ms-spend]'),add=target.closest('[data-goal-stage-add]'),repeat=target.closest('[data-make-cycle]');
 if(!op&&!edit&&!spend&&!add&&!repeat)return null;
 if(!ctx.canEdit)return false;
 if(op)openOperation(ctx,op.dataset.goalOpOpen);
 if(edit){const tx=ctx.state.savings.goal_transactions.find(t=>t.id===edit.dataset.goalOpEdit);if(tx)openOperation(ctx,tx.goal_id,tx);}
 if(spend){const m=ctx.state.savings.goal_milestones.find(m=>m.id===spend.dataset.msSpend);if(m)openOperation(ctx,m.goal_id,null,m);}
 if(add){const goal=ctx.state.savings.goals.find(g=>g.id===add.dataset.goalStageAdd);ctx.ui.goalModal={kind:'stage',goal_id:goal.id,title:'Новый этап',draft:{title:'Новый этап',amount:ownStages(ctx,goal.id).length?'':goal.target_amount||'',date:''}};}
 if(repeat){const [kind,...rest]=repeat.dataset.makeCycle.split(':'),id=rest.join(':'),m=kind==='ms'?ctx.state.savings.goal_milestones.find(m=>m.id===id):null,g=ctx.state.savings.goals.find(g=>g.id===(m?.goal_id??id));if(g)ctx.ui.goalModal={kind:'repeat',goal_id:g.id,title:'Повторение этапа',draft:{milestone_id:m?.id??null,title:m?.title??g.title,amount:m?.target??g.target_amount,date:m?.deadline??g.deadline??`${ctx.year}-12-31`,period_unit:'year'}};}
 return true;
}

function updatePreview(root,ctx){
 const host=root.querySelector('[data-goal-operation-preview]'),modal=ctx.ui.goalModal;if(!host||modal?.kind!=='operation')return;
 try{const result=goalOperationRows(ctx,modal.draft),next={...ctx.state,savings:{...ctx.state.savings,goal_transactions:[...ctx.state.savings.goal_transactions.filter(t=>!result.remove.has(t.id)),...result.rows]}},sim=simulate(next,ctx.cfg,{today:ctx.today}),goal=ctx.state.savings.goals.find(g=>g.id===modal.goal_id),date=modal.draft.date;
  let body=`<span>На счету после операции: <b>${esc(ctx.fmt.money(goalBalanceAt(sim,goal,next.savings.goal_transactions,date),goal.currency_code))}</b></span>`;
  const index=sim.milestonesOf(goal).findIndex(m=>m.id===(modal.draft.milestone_id||'_main'));
  if(index>=0){const current=goalMilestoneAt(sim,goal,index,date);body+=`<span>Осталось накопить по этапу: <b>${esc(ctx.fmt.money(current.need,goal.currency_code))}</b></span>`;}
  host.innerHTML=body;
 }catch{host.innerHTML='';}
}
export function syncGoalDialog(root,ctx){const dialog=root.querySelector('.goal-operation-dialog');if(!dialog)return;if(!dialog.open)dialog.showModal();updatePreview(root,ctx);}
export function attachGoalDialogs(root,getCtx,render){
 const commit=()=>{const ctx=getCtx();try{saveGoalModal(ctx);render();}catch(e){if(ctx.ui.goalModal)ctx.ui.goalModal.error=e.message;render();}};
 root.addEventListener('click',ev=>{
  if(ev.target.closest('[data-goal-modal-close]')){ev.preventDefault();ev.stopImmediatePropagation();getCtx().ui.goalModal=null;render();return;}
  if(ev.target.closest('[data-goal-modal-save]')){ev.preventDefault();ev.stopImmediatePropagation();commit();return;}
  if(!ev.target.closest('[data-goal-menu-toggle],.goal-more-menu')){
   const ctx=getCtx();for(const key of [...ctx.ui.open])if(key.startsWith('goal-menu:'))ctx.ui.open.delete(key);
   root.querySelectorAll('.goal-more-menu').forEach(m=>m.remove());root.querySelectorAll('[data-goal-menu-toggle]').forEach(b=>b.setAttribute('aria-expanded','false'));
  }
 });
 root.addEventListener('keydown',ev=>{
  const tab=ev.target.closest('[data-goal-card-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(ev.key))return;
  const buttons=[...tab.parentElement.querySelectorAll('[data-goal-card-tab]')],index=buttons.indexOf(tab),next=ev.key==='Home'?0:ev.key==='End'?buttons.length-1:(index+(ev.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
  ev.preventDefault();const code=buttons[next].dataset.goalCardTab,id=tab.dataset.goalId;setGoalView(getCtx(),id,code);render();[...root.querySelectorAll('[data-goal-card-tab]')].find(b=>b.dataset.goalId===id&&b.dataset.goalCardTab===code)?.focus();
 });
 root.addEventListener('input',ev=>{const el=ev.target.closest('[data-goal-modal-field]'),modal=getCtx().ui.goalModal;if(!el||!modal)return;modal.draft[el.dataset.goalModalField]=el.value;});
 root.addEventListener('change',ev=>{const el=ev.target.closest('[data-goal-modal-field]'),ctx=getCtx(),modal=ctx.ui.goalModal;if(!el||!modal)return;modal.draft[el.dataset.goalModalField]=el.value;if(['kind','purpose'].includes(el.dataset.goalModalField))render();else updatePreview(root,ctx);});
 root.addEventListener('submit',ev=>{if(!ev.target.matches('[data-goal-modal-form]'))return;ev.preventDefault();commit();});
 root.addEventListener('cancel',ev=>{if(!ev.target.matches('.goal-operation-dialog'))return;ev.preventDefault();getCtx().ui.goalModal=null;render();},true);
}
