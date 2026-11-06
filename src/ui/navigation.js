/* Запрос прокрутки переживает синхронную перерисовку после изменения данных. */
export function revealAddedRow(ctx, domain, table, row) {
  if (domain === 'income' && table === 'payout_slots') ctx.ui.open.add(`set:year:${row.year}`);
  if (domain === 'expenses' && ['expense_categories', 'expense_items'].includes(table)) {
    const category = table === 'expense_categories';
    const section = `cat:${category ? row.id : row.category_id}`;
    ctx.ui.open.add(section);
    ctx.ui.scrollTarget = category ? { section } : { row: row.id };
    return;
  }
  if (domain !== 'savings' || !['goal_milestones', 'goal_transactions'].includes(table)) return;
  const milestone = table === 'goal_milestones';
  (ctx.ui.goalViews??={})[row.goal_id]=milestone?'stages':'movements';
  if(milestone)ctx.ui.open.add(`goal-stage:${row.id}`);
  ctx.ui.open.add(`${milestone ? 'goal' : 'goal-tx'}:${row.goal_id}`);
  const date = milestone ? row.deadline : row.date;
  if (date && date < ctx.today) ctx.ui.open.add(`${milestone ? 'ms-hist' : 'tx-hist'}:${row.goal_id}`);
  ctx.ui.scrollTarget = { row: row.id };
}

export function scrollToPending(root, ui) {
  const target = ui.scrollTarget;
  if (!target) return;
  const attribute = target.section ? 'data-section' : 'data-scroll-row';
  const element = [...root.querySelectorAll(`[${attribute}]`)]
    .find(el => el.getAttribute(attribute) === (target.section || target.row));
  if (!element) return;
  ui.scrollTarget = null;
  const height = root.querySelector('.topbar')?.getBoundingClientRect().height ?? 0;
  root.style.setProperty('--sticky-header-height', `${height}px`);
  (element.querySelector('input:not(:disabled),select:not(:disabled)') ?? element.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
  element.scrollIntoView({ block: target.section ? 'start' : 'nearest', behavior: 'instant' });
}
