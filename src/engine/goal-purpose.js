/* Покупка засчитывается в стоимость выбранного этапа в дату операции.
   Необеспеченная деньгами часть покупки остаётся долгом: оплата сама по себе
   не означает, что этап накоплен. Прошлые движения не пересчитываются. */
export function purposeTracker(options, makeTracker, lists) {
  const paid=new Map(),purchaseDebt=new Map(),affected=new Set(),log=[];
  const inner=makeTracker(options),dates=inner.milestoneDates();
  const goals=new Map(options.goals.map(g=>[g.id,g]));
  function stageBalances(gid,date){const value=inner.phase(gid,date),reserves=inner.reserves(gid);return lists.get(gid).map((m,i)=>i===value.idx?Math.max(0,value.saved):Math.max(0,reserves.find(c=>c.idx===i)?.left??0));}
  for(const g of options.goals){
    paid.set(g.id,lists.get(g.id).map(()=>0));purchaseDebt.set(g.id,lists.get(g.id).map(()=>0));
    log.push(...inner.ledger(g.id).map(e=>({...e,stageBalances:stageBalances(g.id,e.date||'')})));
  }
  const phase=(gid,date)=>{
    const value=inner.phase(gid,date),goal=goals.get(gid),amounts=paid.get(gid)??[],debt=purchaseDebt.get(gid)??[];
    if(goal?.completed&&goal.completion_snapshot&&(date??'9999-12-31')>=goal.completion_snapshot.date)return value;
    return {...value,...(amounts.some(x=>x>0)?{paid:[...amounts]}:{}),...(debt.some(x=>x>0)?{purchaseDebt:[...debt]}:{})};
  };
  function settleDebt(gid){
    const debt=purchaseDebt.get(gid);
    let repaid=Math.max(0,debt.reduce((sum,x)=>sum+x,0)-Math.max(0,-inner.balance(gid)));
    for(let i=0;i<debt.length&&repaid>0;i++){const amount=Math.min(repaid,debt[i]);debt[i]-=amount;repaid-=amount;}
  }
  function append(gid,date){
    const raw=inner.ledger(gid).at(-1);if(!raw)return;
    const before=[...(dates[gid]??[])],goal=goals.get(gid);
    if(!affected.has(gid)||goal?.completed&&goal.completion_snapshot&&date>=goal.completion_snapshot.date)dates[gid]=inner.milestoneDates()[gid];
    else{
      const current=inner.phase(gid,date),debt=purchaseDebt.get(gid);
      dates[gid]=lists.get(gid).map((m,i)=>current.idx>i||paid.get(gid)[i]>=m.target&&m.target>0&&debt[i]<=1e-9?before[i]||date:null);
    }
    const after=dates[gid],funded=inner.milestoneFunded()[gid]??[];
    log.push({...raw,phase:{...phase(gid,date)},stageBalances:stageBalances(gid,date),closed:after.flatMap((d,i)=>d&&!before[i]?[i]:[]),
      reopened:before.flatMap((d,i)=>d&&!after[i]?[i]:[]),drained:after.flatMap((d,i)=>d&&(funded[i]??0)<=.0001?[i]:[])});
  }
  function record(method,args,gid,date){
    const count=inner.ledger(gid).length;inner[method](...args);
    if(inner.ledger(gid).length>count){settleDebt(gid);append(gid,date);}
  }
  function apply(tx){
    const gid=tx.goal_id,list=lists.get(gid);if(!list)return;
    const index=list.findIndex(m=>m.id===(tx.milestone_id||'_main'));
    if(tx.kind==='spend'&&tx.purpose==='goal'&&index>=0&&Number(tx.amount)>0){
      const values=paid.get(gid),credit=Math.min(Math.abs(Number(tx.amount)),Math.max(0,list[index].target-values[index]));
      const unfunded=Math.max(0,credit-Math.max(0,inner.balance(gid)));
      values[index]+=credit;purchaseDebt.get(gid)[index]+=unfunded;affected.add(gid);
      record('purchase',[tx,credit],gid,tx.date);
    }else record('apply',[tx],gid,tx.date);
  }
  return {
    milestones:gid=>inner.milestones(gid),phase,paid:gid=>[...(paid.get(gid)??[])],
    ledger:gid=>log.filter(e=>e.goal_id===gid),balance:gid=>inner.balance(gid),reserves:gid=>inner.reserves(gid),
    deposit(gid,amount,date,note){if(amount)record('deposit',[gid,amount,date,note],gid,date);},
    withdraw(gid,amount,date,note){if(amount)record('withdraw',[gid,amount,date,note],gid,date);},apply,
    snapshot(date='9999-12-31'){const snapshot=inner.snapshot(date);for(const gid of lists.keys())snapshot.phase[gid]={...phase(gid,date)};return snapshot;},
    milestoneDates:()=>Object.fromEntries(Object.entries(dates).map(([gid,ds])=>[gid,[...ds]])),
    milestoneFunded(){const result=inner.milestoneFunded();for(const gid of affected)result[gid]=dates[gid].map((d,i)=>d?result[gid][i]??0:null);return result;},
  };
}
