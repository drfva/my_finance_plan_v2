/* Журнал действий хранится только в браузере и отделён по пользователю/плану.
   Храним изменённые поля, чтобы отмена не затирала несвязанные правки. */
export const PLAN_DOMAINS=['settings','income','expenses','debts','savings','gifts','facts'];
export const copy = value => value===undefined?undefined:JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const KEYS={plan_years:['year'],payout_slots:['year','sort_order'],tax_brackets:['scale_id','sort_order'],
  allocation_rules:['stage_code'],fx_rates:['base_code','quote_code','rate_date'],income_history:['year','month'],
  working_day_overrides:['ym'],account_calendar_days:['date'],expense_period_overrides:['period_id','category_id'],
  expense_facts:['ym','category_id','item_key'],credit_payment_overrides:['period_id','card_id'],
  savings_period_overrides:['period_id','goal_id'],gift_event_amounts:['event_id','year'],goal_cycle_skips:['cycle_id','occurrence_key']};
const keyOf=(table,row)=>Object.fromEntries((KEYS[table]??['id']).map(k=>[k,row[k]??'']));
const match=(row,key)=>Object.entries(key).every(([k,v])=>(row[k]??'')===v);
const subset=(row,values)=>row&&Object.keys(values).every(k=>equal(row[k],values[k]));
const LABELS={expense_categories:'Категории',expense_items:'Статьи расходов',periods:'Выплаты',salary_rates:'Оклад',
  goals:'Цели',goal_milestones:'Этапы целей',goal_transactions:'Движения по целям',gift_events:'Подарки',
  vacations:'Отпуск',sick_leaves:'Больничный',installments:'Рассрочки',credit_cards:'Кредитные карты',account:'Название плана'};
const FIELDS={monthly_amount:'Сумма в месяц',amount:'Сумма',target_amount:'Сколько накопить',target:'Сумма этапа',
  pace_amount:'Темп за выплату',income_net:'Доход на руки',title:'Название',deadline:'Срок',percent_value:'Процент',starting_balance:'Начальный остаток',purpose:'Назначение траты',milestone_id:'Этап покупки'};

export function changesBetween(before,after){
  const changes=[];
  for(const domain of PLAN_DOMAINS)for(const table of new Set([...Object.keys(before[domain]??{}),...Object.keys(after[domain]??{})])){
    if(table==='fx_rates')continue;
    const a=before[domain]?.[table],b=after[domain]?.[table];
    if(Array.isArray(a)||Array.isArray(b)){
      const old=a??[],next=b??[],keys=new Map([...old,...next].map(row=>{const key=keyOf(table,row);return[JSON.stringify(key),key];}));
      for(const key of keys.values()){
        const l=old.find(r=>match(r,key)),r=next.find(r=>match(r,key));
        if(!l||!r){changes.push({domain,table,key,before:l?copy(l):null,after:r?copy(r):null,whole:true});continue;}
        const fields=[...new Set([...Object.keys(l),...Object.keys(r)])].filter(k=>!equal(l[k],r[k])&&k!=='account_id');
        if(fields.length)changes.push({domain,table,key,before:Object.fromEntries(fields.filter(k=>Object.hasOwn(l,k)).map(k=>[k,copy(l[k])])),
          after:Object.fromEntries(fields.filter(k=>Object.hasOwn(r,k)).map(k=>[k,copy(r[k])])),fields,name:r.title||l.title||r.id||table});
      }
    }else if(table==='account_settings'){
      for(const key of new Set([...Object.keys(a??{}),...Object.keys(b??{})]))if(!equal(a?.[key],b?.[key]))
        changes.push({domain,table,key,before:a?.[key]??null,after:b?.[key]??null,kv:true});
    }
  }
  if(before.account.title!==after.account.title)changes.push({domain:'settings',table:'account',key:'title',before:before.account.title,after:after.account.title,scalar:true});
  return changes;
}

export function changeLabel(changes){
  const c=changes[0];if(!c)return '';
  const name=c.name||c.before?.title||c.after?.title||LABELS[c.table]||c.table;
  const action=c.whole?(c.before?'Удалено':'Добавлено'):'Изменено';
  return `${action}: ${name}${changes.length>1?` · связанных правок: ${changes.length}`:''}`;
}
export function changeDetails(entry){
  return entry.changes.flatMap(c=>c.fields?c.fields.map(field=>({title:`${c.name||LABELS[c.table]||c.table} · ${FIELDS[field]||field}`,before:c.before[field],after:c.after[field]}))
    :[{title:LABELS[c.table]||c.table,before:c.whole?(c.before?.title|| (c.before?'Запись':null)):c.before,
      after:c.whole?(c.after?.title|| (c.after?'Запись':null)):c.after}]);
}

export function reverseChanges(state,entry){
  const next=copy(state),domains=new Set();
  for(const c of entry.changes){
    if(c.scalar){
      const current=next.account[c.key];if(!equal(current,c.after)&&!equal(current,c.before))throw new Error('Название плана уже изменилось. Отмена остановлена.');
      next.account[c.key]=c.before;domains.add(c.domain);continue;
    }
    const domain=next[c.domain]??={};
    if(c.kv){
      const values=domain[c.table]??={};const current=values[c.key]??null;
      if(!equal(current,c.after)&&!equal(current,c.before))throw new Error('Настройки уже изменились. Отмена остановлена.');
      if(c.before===null)delete values[c.key];else values[c.key]=copy(c.before);
    }else{
      const rows=domain[c.table]??=[];const index=rows.findIndex(row=>match(row,c.key)),row=rows[index];
      if(c.whole){
        // Допускаем уже восстановленную запись: повтор после ошибки сети безопасен.
        if(c.before===null){if(row&&!subset(row,c.after))throw new Error('Добавленная запись уже изменена. Отмена остановлена.');if(index>=0)rows.splice(index,1);}
        else if(c.after===null){if(row&&!subset(row,c.before))throw new Error('На месте удалённой записи уже другие данные.');if(!row)rows.push(copy(c.before));}
      }else{
        if(!row)throw new Error('Запись уже удалена. Отмена остановлена.');
        for(const field of c.fields){
          if(!equal(row[field],c.after[field])&&!equal(row[field],c.before[field]))throw new Error('Эти поля уже изменены. Отмена остановлена.');
          if(Object.hasOwn(c.before,field))row[field]=copy(c.before[field]);else delete row[field];
        }
      }
    }
    domains.add(c.domain);
  }
  return {state:next,domains:[...domains]};
}

export function localPlanData(state,kind,storage){
  if(storage===undefined){try{storage=globalThis.localStorage;}catch{storage=null;}}
  const key=`finance:${kind}:v1:${state.user?.id??'anonymous'}:${state.account.id}`;
  return {
    read(){try{const value=JSON.parse(storage?.getItem(key)||'[]');return Array.isArray(value)?value:[];}catch{return[];}},
    write(value){try{storage?.setItem(key,JSON.stringify(value));return Boolean(storage);}catch{return false;}},
  };
}
