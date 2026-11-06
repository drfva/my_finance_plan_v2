/* Покупка для цели уменьшает её денежный остаток и неоплаченную стоимость
   конкретного этапа. Денежный трекер сохраняет прежние правила резервов.
   При изменении оплаченной стоимости переигрываем денежные движения, но
   оставляем уже записанные снимки прошлого неизменными. */
export function purposeTracker(options, makeTracker, lists) {
  const events=[], paid=new Map(), affected=new Set(), log=[];
  let inner=makeTracker(options);
  const dates=inner.milestoneDates();
  function stageBalances(gid){const phase=inner.phase(gid),reserves=inner.reserves(gid);return lists.get(gid).map((m,i)=>i===phase.idx?Math.max(0,phase.saved):Math.max(0,reserves.find(c=>c.idx===i)?.left??0));}
  for(const g of options.goals){paid.set(g.id,lists.get(g.id).map(()=>0));log.push(...inner.ledger(g.id).map(e=>({...e,stageBalances:stageBalances(g.id)})));}
  const phase=(gid,date)=>{
    const value=inner.phase(gid,date),amounts=paid.get(gid)??[];
    return amounts.some(x=>x>0)?{...value,paid:[...amounts]}:value;
  };
  function rebuild(){
    const targets=new Map();
    for(const [gid,list] of lists)list.forEach((m,i)=>targets.set(`${gid}|${m.id}`,Math.max(0,m.target-paid.get(gid)[i])));
    inner=makeTracker({...options,
      goals:options.goals.map(g=>({...g,target_amount:targets.get(`${g.id}|_main`)??g.target_amount})),
      milestones:options.milestones.map(m=>({...m,target:targets.get(`${m.goal_id}|${m.id}`)??m.target})),
    });
    for(const e of events)inner[e.method](...e.args);
  }
  function append(gid,date){
    const raw=inner.ledger(gid).at(-1);if(!raw)return;
    const before=[...(dates[gid]??[])];
    const goal=options.goals.find(g=>g.id===gid);
    if(!affected.has(gid)||goal?.completed&&goal.completion_snapshot&&date>=goal.completion_snapshot.date){dates[gid]=inner.milestoneDates()[gid];}
    else{
      const current=inner.phase(gid,date),list=lists.get(gid);
      dates[gid]=list.map((m,i)=>current.idx>i||paid.get(gid)[i]>=m.target&&m.target>0?before[i]||date:null);
    }
    const after=dates[gid],funded=inner.milestoneFunded()[gid]??[];
    log.push({...raw,phase:{...phase(gid,date)},stageBalances:stageBalances(gid),closed:after.flatMap((d,i)=>d&&!before[i]?[i]:[]),
      reopened:before.flatMap((d,i)=>d&&!after[i]?[i]:[]),
      drained:after.flatMap((d,i)=>d&&(funded[i]??0)<=.0001?[i]:[])});
  }
  function record(method,args,gid,date){
    const count=inner.ledger(gid).length;
    events.push({method,args});inner[method](...args);if(inner.ledger(gid).length>count)append(gid,date);
  }
  function apply(tx){
    const gid=tx.goal_id,list=lists.get(gid);if(!list)return;
    const index=list.findIndex(m=>m.id===(tx.milestone_id||'_main'));
    if(tx.kind==='spend'&&tx.purpose==='goal'&&index>=0&&Number(tx.amount)>0){
      const values=paid.get(gid);values[index]=Math.min(list[index].target,values[index]+Math.abs(Number(tx.amount)));
      affected.add(gid);events.push({method:'apply',args:[tx]});rebuild();append(gid,tx.date);
    }else record('apply',[tx],gid,tx.date);
  }
  return {
    milestones:gid=>inner.milestones(gid),phase,
    paid:gid=>[...(paid.get(gid)??[])],
    ledger:gid=>log.filter(e=>e.goal_id===gid),balance:gid=>inner.balance(gid),reserves:gid=>inner.reserves(gid),
    deposit(gid,amount,date,note){if(amount)record('deposit',[gid,amount,date,note],gid,date);},
    withdraw(gid,amount,date,note){if(amount)record('withdraw',[gid,amount,date,note],gid,date);},apply,
    snapshot(date='9999-12-31'){const snapshot=inner.snapshot(date);for(const gid of lists.keys())snapshot.phase[gid]={...phase(gid,date)};return snapshot;},
    milestoneDates:()=>Object.fromEntries(Object.entries(dates).map(([gid,ds])=>[gid,[...ds]])),
    milestoneFunded(){const result=inner.milestoneFunded();for(const gid of affected)result[gid]=dates[gid].map((d,i)=>d?result[gid][i]??0:null);return result;},
  };
}
