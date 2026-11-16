import { card, esc, section } from './dom.js';

export function retainedFact(tracking, month) {
  const start = tracking.settings.started_on.slice(0, 7);
  return month < start || month === start && tracking.settings.fact_mode === 'add';
}

// Keep manual rows intact so a purchase can be moved or deleted reversibly.
export function baseExpenseFacts(ctx, manual, family = false) {
  if (!ctx.tracking?.enabled) return manual;
  const tracking = ctx.tracking;
  const monthKey = family ? 'month' : 'ym';
  const rows = new Map();
  const keyOf = row => JSON.stringify([row[monthKey], row.category_id, row.item_key ?? '']);
  for (const row of manual) {
    if (retainedFact(tracking, row[monthKey])) rows.set(keyOf(row), { ...row });
  }
  for (const purchase of tracking.purchases) {
    const row = { [monthKey]: purchase.occurred_on.slice(0, 7), amount: 0,
      category_id: family ? purchase.item_id || purchase.category_id : purchase.category_id };
    if (!family) Object.assign(row, {
      item_key: purchase.item_id, item_title: purchase.item_title, category_title: purchase.category_title,
    });
    const key = keyOf(row);
    if (!rows.has(key)) rows.set(key, row);
    if (!purchase.included_in_fact) rows.get(key).amount = Number(rows.get(key).amount) + Number(purchase.total);
  }
  return [...rows.values()];
}

export function trackedFacts(ctx, manual, family = false) {
  const facts = baseExpenseFacts(ctx,manual ?? [],family);
  const overrides = ctx.tracking?.fact_overrides ?? [];
  if (!overrides.length) return facts;
  const monthKey = family ? 'month' : 'ym';
  const parents = family ? new Map((ctx.tracking.purchases ?? []).filter(p=>p.item_id).map(p=>[p.item_id,p.category_id])) : null;
  if (parents) for (const c of ctx.state.family.categories) if (c.parent_id) parents.set(c.id,c.parent_id);
  const keys = new Set(overrides.map(f=>JSON.stringify([f.month,f.category_id])));
  return [...facts.filter(f=>!keys.has(JSON.stringify([f[monthKey],parents?.get(f.category_id) || f.category_id]))),
    ...overrides.map(f=>({[monthKey]:f.month,category_id:f.category_id,category_title:f.category_title,amount:f.amount}))];
}

export function manualCategoryFact(ctx, month, category) {
  return ctx.tracking?.fact_overrides?.find(f=>f.month===month && f.category_id===category);
}

export function categoryFactCell(ctx, month, category, amount) {
  const manual = manualCategoryFact(ctx,month,category.id);
  const title = `Факт · ${category.title}`;
  if (!ctx.canEdit) return `<span${manual?' title="Итог задан вручную"':''}>${esc(ctx.fmt.money(amount))}</span>`;
  return `<div class="tracking-fact-cell"><input type="text" inputmode="decimal" class="tracking-fact-amount${manual?' own':''}"
    data-fact-editor data-id="${esc(category.id)}" data-month="${esc(month)}" value="${esc(manual?.amount ?? '')}"
    placeholder="${esc(manual?'':ctx.fmt.money(amount))}" aria-label="${esc(title)}" title="${manual?'Введено вручную. Очистите поле, чтобы вернуть расчёт.':'Введите итог вручную'}">
    <small class="danger-text" data-fact-error role="alert" hidden></small></div>`;
}

export function createExpenseTracking(client) {
  let generation = 0;
  let current = null;
  let requestedPlan = null;
  const runningCommands = new Map();
  return {
    get(plan) { return current?.plan === plan ? current.data : null; },
    async load(plan, forConflict = false) {
      if (!client || !plan || runningCommands.has(plan) && !forConflict) return false;
      requestedPlan = plan;
      const request = ++generation;
      const { data, error } = await client.rpc('expense_tracking_get', { p_plan: plan });
      if (request !== generation) return false;
      if (error && error.code !== 'PGRST202') throw new Error(error.message);
      const next = data ?? { unavailable: true };
      const changed = current?.plan !== plan || current?.data.enabled !== next.enabled
        || current?.data.unavailable !== next.unavailable || current?.data.settings?.revision !== next.settings?.revision
        || JSON.stringify(current?.data.fact_overrides) !== JSON.stringify(next.fact_overrides);
      current = { plan, data: next };
      return changed;
    },
    async command(plan, action, payload) {
      const revision = this.get(plan)?.settings?.revision ?? null;
      const request = requestedPlan && requestedPlan !== plan ? null : ++generation;
      runningCommands.set(plan,(runningCommands.get(plan) ?? 0) + 1);
      try {
        let rpc = 'expense_tracking_command';
        let args = { p_plan:plan, p_action:action, p_payload:payload, p_revision:revision };
        if (action === 'income_account') {
          rpc = 'expense_tracking_set_income_account';
          args = { p_plan:plan, p_period:payload.period, p_account:payload.account || null, p_revision:revision };
        } else if (action === 'category_fact') {
          rpc = 'expense_tracking_set_category_fact';
          args = { p_plan:plan, p_month:payload.month, p_category:payload.category, p_amount:payload.amount, p_previous:payload.previous };
        }
        const { data, error } = await client.rpc(rpc,args);
        if (error) {
          if (error.code === 'PT409' && request === generation) await this.load(plan,true);
          throw Object.assign(new Error(error.message),{code:error.code});
        }
        if (request === generation) current = { plan, data };
      } finally {
        const remaining = runningCommands.get(plan) - 1;
        if (remaining) runningCommands.set(plan,remaining);
        else runningCommands.delete(plan);
      }
    },
  };
}

const opt = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
const label = (title, input) => `<label class="field"><span>${title}</span>${input}</label>`;
const action = (name, title, id = '') => `<button type="button" data-tracking-action="${name}" data-id="${esc(id)}">${title}</button>`;
const textInput = (name, value = '', attributes = '') => `<input name="${name}" value="${esc(value)}" ${attributes}>`;
const accountOptions = (ctx, value) => ctx.tracking.accounts.map(a => opt(a.id, `${a.title} (${ctx.fmt.money(a.balance)})`, value)).join('');
const selectAccount = (ctx, name, selected, empty = '') => `<select name="${name}">${empty ? opt('',empty,selected) : ''}${accountOptions(ctx, selected)}</select>`;

export function incomeDepositField(ctx, row) {
  const first = ctx.tracking?.settings?.income_tracking_from;
  if (!first) return '';
  const period = row.period;
  const receipt = ctx.tracking.income_receipts?.[period.id];
  if (!receipt?.paid_on && period.pay_date < first) return '';
  const posted = Boolean(receipt?.paid_on);
  const account = ctx.tracking.accounts.find(a=>a.id===ctx.tracking.settings.deposit_account);
  const selected = receipt?.account_id ?? '';
  const defaultOption = posted ? '' : opt('',`По умолчанию · ${account?.title ?? ''}`,selected);
  const summary = posted ? `Зачислено ${ctx.fmt.money(receipt.amount)} · ${ctx.fmt.date(receipt.paid_on)}`
    : `Зачисление по дате выплаты · ${ctx.fmt.money(row.income.salary)}`;
  return `<div class="tracking-income-account">${label('Счёт зачисления',
    `<select data-tracking-income-account="${esc(period.id)}"${ctx.canEdit?'':' disabled'}>${defaultOption}${accountOptions(ctx,selected)}</select>`)}
    <div class="small-note">${esc(summary)}</div><p role="alert" class="danger-text" data-tracking-income-error hidden></p></div>`;
}

function categories(ctx) {
  if (ctx.state.account.plan_kind === 'family') {
    const rows = ctx.state.family.categories.filter(c => !c.archived);
    return rows.filter(c => !c.parent_id).map(c => ({
      ...c, items: rows.filter(i => i.parent_id === c.id),
    }));
  }
  const rows = ctx.state.expenses?.expense_categories ?? [];
  return rows.map(c => ({ ...c, items: (ctx.state.expenses?.expense_items ?? []).filter(i => i.category_id === c.id) }));
}

function accountForm(ctx, enabling, account) {
  return `${label('Название счета', textInput('title', account?.title ?? '', 'required maxlength="160"'))}
    ${label('Начальный остаток', textInput('amount', account?.adjusted_opening_amount ?? account?.opening_amount ?? '0', 'required inputmode="decimal"'))}
    ${account ? '<p class="small-note">Разница в начальном остатке будет учтена с сегодняшнего дня.</p>'
      : label('Дата начального остатка', textInput('date', ctx.today, 'type="date" required'))}
    ${enabling ? `<p class="small-note">Факт предыдущих месяцев сохранится. Покупки задним числом смогут его дополнить.</p>
    ${label('Факт текущего месяца', '<select name="fact_mode" required><option value="">Выберите вариант</option><option value="reset">Начать с нуля</option><option value="add">Добавлять к введенному факту</option></select>')}` : ''}`;
}

const allTags = ctx => [...new Set(ctx.tracking.purchases.flatMap(p => p.tags))].sort((a,b)=>a.localeCompare(b,'ru'));
const sameTag = (a,b) => a.toLocaleLowerCase('ru') === b.toLocaleLowerCase('ru');

function tagOptions(ctx, selected, query = '') {
  const filter = query.trim();
  const tags = [...new Set([...allTags(ctx), ...selected])];
  const shown = tags.filter(tag => tag.toLocaleLowerCase('ru').includes(filter.toLocaleLowerCase('ru')));
  const list = shown.map(tag => `<label class="tracking-tag"><input type="checkbox" data-tracking-pick-tag value="${esc(tag)}"${selected.includes(tag)?' checked':''}> ${esc(tag)}</label>`).join('');
  const create = filter && !tags.some(tag=>sameTag(tag,filter))
    ? action('tag-create','+ Создать',filter) : '';
  return list + create || '<p class="small-note">Введите название тега.</p>';
}

function tagPicker(ctx, draft) {
  const selected = draft.tags ?? draft.purchase?.tags ?? [];
  return `<details class="tracking-dropdown"><summary aria-labelledby="tracking-tag-picker-label tracking-tag-picker-value"><span id="tracking-tag-picker-value" data-tracking-selected-tags>${esc(selected.join(', ') || 'Выбрать теги')}</span></summary>
    <div><input type="search" maxlength="60" data-tracking-tag-search aria-label="Поиск по тегам" placeholder="Поиск по тегам">
    <div class="tracking-tag-list" data-tracking-tag-options>${tagOptions(ctx,selected)}</div></div></details>`;
}

function purchaseForm(ctx, draft) {
  const { purchase } = draft;
  const selected = purchase ? JSON.stringify([purchase.category_id,purchase.item_id]) : '';
  const options = categories(ctx).flatMap(c => [opt(JSON.stringify([c.id,'']), c.title, selected),
    ...c.items.map(i => opt(JSON.stringify([c.id,i.id]), `${c.title} / ${i.title}`, selected))]);
  const parts = purchase?.parts ?? [{ account_id: ctx.tracking.settings.debit_account, amount: '' }];
  return `<div class="grid cols-2">
    ${label('Дата',textInput('date',purchase?.occurred_on ?? ctx.today,'type="date" required'))}
    ${label('Сумма покупки',textInput('amount',purchase?.total,'required inputmode="decimal"'))}
    ${label('Категория или статья',`<select name="category" required>${opt('','Выберите категорию','')}${options.join('')}</select>`)}
    <div class="field tracking-tags-field"><label id="tracking-tag-picker-label">Теги</label>${tagPicker(ctx,draft)}</div>
    ${label('Комментарий',textInput('note',purchase?.note,'maxlength="2000"'))}
    </div>
    <h3>Части оплаты</h3>
    <div data-tracking-parts>${parts.map(part=>partRow(ctx,part)).join('')}</div>
    <p class="small-note" data-tracking-parts-empty${parts.length?' hidden':''}>Добавьте счёт, с которого оплатили покупку.</p>
    ${action('part-add','+ часть оплаты')}`;
}

function partRow(ctx, part = {}) {
  return `<div class="tracking-part" data-tracking-part>
    ${label('Счет',selectAccount(ctx,'part_account',part.account_id,'Выберите счет'))}
    ${label('Сумма',textInput('part_amount',part.amount,'inputmode="decimal"'))}
    ${action('part-remove','Убрать')}
  </div>`;
}

function form(ctx) {
  const draft = ctx.ui.trackingForm;
  if (!draft) return '';
  const { kind, purchase } = draft;
  let body;
  if (kind === 'enable' || kind === 'account_add' || kind === 'account_edit') {
    body = accountForm(ctx,kind === 'enable',kind === 'account_edit' ? ctx.tracking.accounts.find(a=>a.id===draft.id) : null);
  }
  if (kind === 'purchase_save') body = purchaseForm(ctx,draft);
  if (kind === 'movement_add') body = `${label('Списать со счета',selectAccount(ctx,'from_account','','Пополнение извне'))}
    ${label('Зачислить на счет',selectAccount(ctx,'to_account',ctx.tracking.settings.deposit_account))}
    ${label('Дата',textInput('date',ctx.today,'type="date" required'))}
    ${label('Сумма',textInput('amount','','required inputmode="decimal"'))}
    ${label('Комментарий',textInput('note','','maxlength="2000"'))}`;
  if (!body) return '';
  const titles = { enable:'Начать учитывать расходы', account_add:'Новый счет', purchase_save:purchase ? 'Изменить трату' : 'Новая трата',
    account_edit:'Редактировать счет', movement_add:'Пополнение или перевод' };
  const fields = `<form data-tracking-form="${kind}" data-id="${esc(draft.id)}" class="tracking-form">
    ${body}<div class="row wrap"><button class="primary" type="submit">Сохранить</button>${action('cancel','Отмена')}</div>
    <p role="alert" class="danger-text" data-tracking-error hidden></p></form>`;
  return kind === 'purchase_save' || kind === 'movement_add' ? trackingDialog(titles[kind],fields)
    : card({ title:titles[kind],body:fields });
}

function trackingDialog(title, body) {
  return `<dialog class="tracking-dialog" aria-labelledby="tracking-dialog-title" data-tracking-dialog>
    <div class="row between"><h2 id="tracking-dialog-title">${esc(title)}</h2>
    <button type="button" class="ghost" data-tracking-action="cancel" aria-label="Закрыть">✕</button></div>
    ${body}</dialog>`;
}

export function syncExpenseTrackingDialog(root, ui) {
  const dialog = root.querySelector('[data-tracking-dialog]');
  if (dialog && !dialog.open) {
    dialog.showModal();
    const journal = dialog.querySelector('.tracking-journal-scroll');
    if (journal) journal.scrollTop = ui.trackingJournalScroll ?? 0;
  }
}

export function expenseTrackingSettings(ctx) {
  const tracking = ctx.tracking;
  if (!tracking || tracking.unavailable || (!tracking.enabled && !ctx.canEdit)) return '';
  const key = 'set:accounts';
  const open = ctx.ui.open.has(key);
  const panel = (body, actions = '') => section({ key, title:'Счета', open, body, actions });
  if (!open) return panel('');
  const editorKind = ctx.ui.trackingForm?.kind;
  if (['enable','account_add','account_edit'].includes(editorKind)) return panel(form(ctx));
  if (!tracking.enabled) return panel(action('enable','Начать учитывать расходы'));
  const titles = new Map(ctx.tracking.accounts.map(a=>[a.id,a.title]));
  const corrections = tracking.corrections ?? [];
  const receipts = Object.values(tracking.income_receipts ?? {}).filter(r=>r.paid_on && Number(r.amount)>0)
    .sort((a,b)=>b.paid_on.localeCompare(a.paid_on));
  const changes = tracking.income_account_changes ?? [];
  const history = tracking.movements.length || corrections.length || receipts.length || changes.length ? `<div class="tracking-account-history">
    ${tracking.movements.length ? `<details><summary>Пополнения и переводы</summary><ul>${tracking.movements.map(m=>`<li>
      ${esc(ctx.fmt.date(m.occurred_on))} · ${esc(m.from_account ? titles.get(m.from_account) + ' → ' : '')}${esc(titles.get(m.to_account))}
       · ${esc(ctx.fmt.money(m.amount))}${m.note ? ' · '+esc(m.note) : ''}</li>`).join('')}</ul></details>` : ''}
    ${corrections.length ? `<details><summary>Корректировки начального остатка</summary><ul>${corrections.map(c=>`<li>
      ${esc(ctx.fmt.date(c.effective_on))} · ${esc(titles.get(c.account_id))} · ${c.delta>0?'+':''}${esc(ctx.fmt.money(c.delta))}</li>`).join('')}</ul></details>` : ''}
    ${receipts.length ? `<details><summary>Зачисления выплат</summary><ul>${receipts.map(r=>`<li>
      ${esc(ctx.fmt.date(r.paid_on))} · ${esc(r.title || 'Выплата')} · ${esc(titles.get(r.account_id))} · ${esc(ctx.fmt.money(r.amount))}</li>`).join('')}</ul></details>` : ''}
    ${changes.length ? `<details><summary>Смена счёта зачисления</summary><ul>${changes.map(c=>`<li>
      ${esc(ctx.fmt.date(c.changed_on))} · ${esc(tracking.income_receipts[c.period_id]?.title || 'Выплата')}
      · ${esc(titles.get(c.from_account))} → ${esc(titles.get(c.to_account))}</li>`).join('')}</ul></details>` : ''}</div>` : '';
  const actions = ctx.canEdit ? action('account_add','+ счёт') + action('movement_add','Пополнение или перевод') : '';
  const movement = editorKind === 'movement_add' ? form(ctx) : '';
  return panel(accountBalances(ctx,true) + history + movement, actions);
}

function defaultAccountIcon(ctx, account) {
  const { deposit_account, debit_account } = ctx.tracking.settings;
  const selected = deposit_account === account.id && debit_account === account.id;
  const status = 'По умолчанию для зачислений и списаний';
  const star = `<svg width="18" height="18" viewBox="0 0 24 24" fill="${selected ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="m12 2.5 2.9 6 6.6 1-4.8 4.6 1.1 6.6-5.8-3.1-5.8 3.1 1.1-6.6-4.8-4.6 6.6-1Z"/></svg>`;
  const name = `Счёт по умолчанию для зачислений и списаний — ${account.title}`;
  const hint = selected ? status : 'Использовать для зачислений и списаний';
  if (!ctx.canEdit) return selected ? `<span class="tracking-default-icon is-default" role="img" title="${status}" aria-label="${status}">${star}</span>` : '';
  return `<button type="button" class="tracking-default-icon${selected?' is-default':''}" data-tracking-action="defaults" data-id="${esc(account.id)}" aria-pressed="${selected}" aria-label="${esc(name)}" title="${hint}">${star}</button>`;
}

function accountBalances(ctx, management = false) {
  const { deposit_account, debit_account } = ctx.tracking.settings;
  return `<div class="tracking-accounts">${ctx.tracking.accounts.map(a=>`<div>
    <div class="tracking-account-head"><span>${esc(a.title)}</span>${management ? defaultAccountIcon(ctx,a) : ''}</div>
    <b class="${a.balance<0?'danger-text':''}">${esc(ctx.fmt.money(a.balance))}</b>
    ${management && deposit_account !== debit_account ? (a.id === deposit_account ? '<div class="small-note">Зачисления по умолчанию</div>' : a.id === debit_account ? '<div class="small-note">Списания по умолчанию</div>' : '') : ''}
    ${management && ctx.canEdit ? action('account_edit','Изменить счёт',a.id) : ''}</div>`).join('')}</div>`;
}

export function expenseFactActions(ctx) {
  if (!ctx.tracking?.enabled) return '';
  return action('journal','Журнал покупок') + (ctx.canEdit ? action('purchase_save','+ трата') : '');
}

function chart(ctx, rows) {
  const totals = new Map();
  for (const row of rows) {
    const { category_id, category_title } = row.purchase;
    const category = totals.get(category_id) ?? { name: category_title, amount: 0 };
    category.amount += row.amount;
    totals.set(category_id, category);
  }
  const total = [...totals.values()].reduce((sum, category) => sum+category.amount, 0);
  if (!total) return '';
  const colors = ['#517fd0','#3c9c8d','#d78843','#9a70bd','#c7617a','#60798e'];
  let start = 0;
  const slices = [...totals.entries()].sort(([,a],[,b]) => b.amount-a.amount).map(([id,{name,amount}],i) => {
    const width = amount / total * 100;
    const color = colors[i % colors.length];
    const offset = -start;
    start += width;
    return { id,name,amount,width,color,offset };
  });
  const wheel = `<div class="tracking-wheel"><svg viewBox="0 0 160 160" aria-hidden="true" focusable="false">
    ${slices.map(s=>`<circle cx="80" cy="80" r="69" pathLength="100" fill="none" stroke="${s.color}" stroke-width="22"
      stroke-dasharray="${s.width} ${100-s.width}" stroke-dashoffset="${s.offset}" transform="rotate(-90 80 80)"
      data-tracking-action="chart-category" data-id="${esc(s.id)}"/>`).join('')}
    </svg><b>${esc(ctx.fmt.money(total))}</b></div>`;
  const legend = slices.map(s=>`<li>${action('chart-category',`<i aria-hidden="true" style="background:${s.color}"></i><span>${esc(s.name)} · ${esc(ctx.fmt.money(s.amount))} · ${esc(ctx.fmt.percent(s.width,1))}</span>`,s.id)}</li>`).join('');
  return `<div class="tracking-chart">${wheel}<ul aria-label="Категории на диаграмме">${legend}</ul></div>`;
}

function journalResults(ctx, monthly, activeTags) {
  const chosen = ctx.ui.trackingFilters ?? {};
  const [category, item] = chosen.category ? JSON.parse(chosen.category) : [];
  const rows = monthly.flatMap(purchase => {
    if ((category && purchase.category_id !== category) || (item && purchase.item_id !== item)) return [];
    if (activeTags.length && !purchase.tags.some(tag => activeTags.includes(tag))) return [];
    const amount = chosen.account ? Number(purchase.parts.find(p => p.account_id === chosen.account)?.amount || 0) : Number(purchase.total);
    return amount ? [{ purchase,amount }] : [];
  });
  const names = new Map(ctx.tracking.accounts.map(a => [a.id,a.title]));
  return `${chart(ctx,rows)}
      <div class="small-note">Диаграмма показывает покупки журнала. У ручного факта нет разбивки по счетам и тегам.</div>
      <div data-tracking-journal-rows tabindex="-1" role="group" aria-label="Покупки по фильтрам">
      ${rows.map(({purchase:p,amount})=>`<details class="tracking-purchase" data-tracking-purchase="${esc(p.id)}"${ctx.ui.trackingOpenPurchases?.has(p.id)?' open':''}><summary>${esc(ctx.fmt.date(p.occurred_on))}
        · ${esc(p.category_title)}${p.item_title ? ' / '+esc(p.item_title) : ''} · <b>${esc(ctx.fmt.money(amount))}</b></summary>
        <ul>${p.parts.map(part=>`<li>${esc(names.get(part.account_id))} · ${esc(ctx.fmt.money(part.amount))}</li>`).join('')}</ul>
        ${p.tags.length ? `<p>${esc(p.tags.join(', '))}</p>` : ''}${p.note ? `<p>${esc(p.note)}</p>` : ''}
        ${ctx.canEdit ? `<div class="row wrap">${action('purchase_save','Изменить',p.id)}${action('purchase_delete','Удалить',p.id)}</div>` : ''}
      </details>`).join('') || '<p>По выбранным условиям покупок нет.</p>'}</div>`;
}

const purchasesForMonth = (ctx, month) => ctx.tracking.purchases.filter(p => p.occurred_on.startsWith(month));

export function expenseTrackingPanel(ctx, month) {
  const tracking = ctx.tracking;
  if (!tracking || tracking.unavailable) return '';
  const editor = ctx.ui.trackingForm?.kind;
  if (!tracking.enabled) return ctx.canEdit
    ? card({ title:'Учёт по счетам', actions:'<button type="button" data-tab="settings">Открыть настройки</button>', body:'' })
    : '';
  const accounts = card({ title:'Остатки по счетам', body:accountBalances(ctx) });
  if (editor === 'purchase_save') return accounts + form(ctx);
  if (!ctx.ui.trackingJournal) return accounts;
  const chosen = ctx.ui.trackingFilters ?? {};
  const monthly = purchasesForMonth(ctx,month);
  const tags = [...new Set(monthly.flatMap(p => p.tags))].sort();
  const activeTags = (chosen.tags ?? []).filter(tag => tags.includes(tag));
  const planCategories = categories(ctx);
  const options = planCategories.flatMap(c=>[
    opt(JSON.stringify([c.id,'']),c.title,chosen.category),
    ...c.items.map(i=>opt(JSON.stringify([c.id,i.id]),`${c.title} / ${i.title}`,chosen.category)),
  ]);
  const knownCategories = new Set(planCategories.map(c=>c.id));
  const historicCategories = new Map(monthly.filter(p=>!knownCategories.has(p.category_id)).map(p=>[p.category_id,p.category_title]));
  for (const [id,title] of historicCategories) options.push(opt(JSON.stringify([id,'']),title,chosen.category));
  const purchases = trackingDialog(`Журнал покупок · ${ctx.fmt.month(month)}`,`<div class="grid cols-3">
      ${label('Счет',`<select data-tracking-filter="account">${opt('','Все счета',chosen.account)}${accountOptions(ctx,chosen.account)}</select>`)}
      ${label('Категория',`<select data-tracking-filter="category">${opt('','Все категории',chosen.category)}${options.join('')}</select>`)}
      <div class="field tracking-tags-field"><label id="tracking-tag-filter-label">Теги</label><details class="tracking-dropdown" data-tracking-tags-filter${ctx.ui.trackingTagsOpen?' open':''}>
        <summary aria-labelledby="tracking-tag-filter-label tracking-tag-filter-value"><span id="tracking-tag-filter-value">${esc(activeTags.join(', ') || 'Все теги')}</span></summary>
        <div class="tracking-tag-list">${tags.map(t=>`<label class="tracking-tag"><input type="checkbox" data-tracking-filter="tags" value="${esc(t)}"${activeTags.includes(t)?' checked':''}> ${esc(t)}</label>`).join('') || 'Тегов пока нет'}</div>
      </details></div>
      </div>
      <div class="tracking-journal-scroll" data-tracking-journal-month="${esc(month)}" tabindex="0" aria-label="Список покупок">
        ${journalResults(ctx,monthly,activeTags)}</div>`);
  return accounts + purchases;
}

export function attachExpenseTracking(root, getCtx, render, api, renderReport = render) {
  let savingDefault = false;
  let factWrites = Promise.resolve();
  let pendingFacts = 0;
  let changedFactPlan = null;
  let redrawingFacts = false;

  function redrawFacts() {
    if (pendingFacts || !changedFactPlan) return;
    const ctx = getCtx();
    if (ctx.state.account?.id !== changedFactPlan) { changedFactPlan = null; return; }
    if (ctx.ui.trackingForm || ctx.ui.trackingJournal || !['facts','dashboard'].includes(ctx.ui.tab)) return;
    const active = root.ownerDocument.activeElement;
    const factFocused = active?.matches('[data-fact-editor]');
    if (!factFocused && active?.matches('input,select,textarea')) return;
    const draft = factFocused && active.value !== active.defaultValue ? active.value : null;
    changedFactPlan = null;
    redrawingFacts = true;
    try { renderReport(); } finally { redrawingFacts = false; }
    if (factFocused) {
      const next = [...root.querySelectorAll('[data-fact-editor]')]
        .find(input=>input.dataset.id===active.dataset.id && input.dataset.month===active.dataset.month);
      if (next) {
        if (draft !== null) next.value = draft;
        next.focus({preventScroll:true});
        if (draft !== null) next.setSelectionRange(active.selectionStart,active.selectionEnd);
      }
    }
  }

  function factError(input, message = '') {
    input.classList.toggle('bad-value',Boolean(message));
    if (message) input.setAttribute('aria-invalid','true');
    else input.removeAttribute('aria-invalid');
    const error = input.nextElementSibling;
    error.hidden = !message;
    error.textContent = message;
  }

  root.addEventListener('focusout', ({target:input}) => {
    if (redrawingFacts) return;
    if (changedFactPlan) queueMicrotask(redrawFacts);
    if (!input.matches('[data-fact-editor]') || input.disabled) return;
    if (input.value === input.defaultValue && !input.hasAttribute('aria-invalid')) return;
    const ctx = getCtx();
    if (!ctx.canEdit) return;
    const value = input.value.trim();
    const amount = value ? ctx.fmt.parseNumber(value) : null;
    if (value && (amount === null || amount < 0)) {
      factError(input,'Введите неотрицательную сумму');
      return;
    }
    const {id:category,month} = input.dataset;
    const previous = input.defaultValue === '' ? null : Number(input.defaultValue);
    factError(input);
    if (amount === previous) { input.value = input.defaultValue; return; }
    const plan = ctx.state.account.id;
    pendingFacts++;
    ctx.ui.trackingFactsSaving = true;
    input.disabled = true;
    factWrites = factWrites.then(async () => {
      try {
        if (getCtx().state.account?.id === plan) {
          await ctx.store.flush();
          if (ctx.store.status() === 'error') throw new Error('Сначала сохраните изменения плана');
        }
        await api.command(plan,'category_fact',{category,month,amount,previous});
        if (root.contains(input)) {
          input.defaultValue = input.value = amount ?? '';
          input.classList.toggle('own',amount !== null);
        }
        changedFactPlan = plan;
      } catch (error) {
        if (!root.contains(input)) return;
        if (error.code === 'PT409') {
          const current = manualCategoryFact(getCtx(),month,category);
          input.defaultValue = current?.amount ?? '';
          input.classList.toggle('own',Boolean(current));
        }
        factError(input,error.message);
      } finally {
        input.disabled = false;
        pendingFacts--;
        ctx.ui.trackingFactsSaving = pendingFacts > 0;
        redrawFacts();
      }
    });
  });
  function refreshJournal(ctx) {
    const results = root.querySelector('[data-tracking-journal-month]');
    const activeTags = [...root.querySelectorAll('[data-tracking-filter="tags"]:checked')].map(input=>input.value);
    root.querySelector('#tracking-tag-filter-value').textContent = activeTags.join(', ') || 'Все теги';
    results.innerHTML = journalResults(ctx,purchasesForMonth(ctx,results.dataset.trackingJournalMonth),activeTags);
  }
  function rememberJournalScroll(ui) {
    const journal = root.querySelector('.tracking-journal-scroll');
    if (journal) ui.trackingJournalScroll = journal.scrollTop;
  }
  const complete = async (ctx, kind, payload) => {
    await ctx.store.flush();
    if (ctx.store.status() === 'error') throw new Error('Сначала сохраните изменения плана');
    await api.command(ctx.state.account.id, kind, payload);
    if (getCtx().state.account.id === ctx.state.account.id) {
      rememberJournalScroll(ctx.ui);
      ctx.ui.trackingForm = null;
      if (kind === 'purchase_save' && ctx.ui.tab === 'facts') {
        const month = payload.date.slice(0,7);
        ctx.ui.year = Number(month.slice(0,4));
        if (ctx.state.account.plan_kind === 'family') ctx.ui.draft.familyFactMonth = month;
        else (ctx.ui.draft.facts ??= {}).month = month;
      }
      render();
    }
  };
  function refreshPicker(formNode, ctx) {
    const draft = ctx.ui.trackingForm;
    const selected = draft.tags ?? draft.purchase?.tags ?? [];
    const search = formNode.querySelector('[data-tracking-tag-search]');
    formNode.querySelector('[data-tracking-tag-options]').innerHTML = tagOptions(ctx,selected,search.value);
    formNode.querySelector('[data-tracking-selected-tags]').textContent = selected.join(', ') || 'Выбрать теги';
  }
  function close(ctx) {
    const draft = ctx.ui.trackingForm;
    if (ctx.ui.trackingForm) ctx.ui.trackingForm = null;
    else ctx.ui.trackingJournal = false;
    render();
    const modalClose = root.querySelector('[data-tracking-dialog] [data-tracking-action="cancel"]');
    const actions = root.querySelectorAll(`[data-tracking-action="${draft?.kind ?? 'journal'}"]`);
    const opener = [...actions].find(button => !button.dataset.id || button.dataset.id === draft?.id);
    (modalClose ?? opener)?.focus();
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-tracking-action]');
    if (!button) {
      if (event.target.closest('[data-tracking-form]')) event.stopImmediatePropagation();
      return;
    }
    event.stopImmediatePropagation();
    const ctx = getCtx();
    const { trackingAction: kind, id } = button.dataset;
    if (kind === 'cancel') { close(ctx); return; }
    if (kind === 'journal') {
      ctx.ui.trackingJournal = true;
      ctx.ui.trackingTagsOpen = false;
      ctx.ui.trackingJournalScroll = 0;
      ctx.ui.trackingOpenPurchases = new Set();
      render();
      return;
    }
    if (kind === 'chart-category') {
      const filters = (ctx.ui.trackingFilters ??= {});
      if (!filters.category || JSON.parse(filters.category)[0] !== id) {
        const select = root.querySelector('[data-tracking-filter="category"]');
        select.value = filters.category = JSON.stringify([id,'']);
        refreshJournal(ctx);
      }
      const rows = root.querySelector('[data-tracking-journal-rows]');
      rows?.focus({preventScroll:true});
      rows?.scrollIntoView({block:'nearest'});
      return;
    }
    if (!ctx.canEdit || savingDefault) return;
    if (kind === 'defaults') {
      if (button.getAttribute('aria-pressed') === 'true') return;
      savingDefault = true;
      const controls = [...root.querySelectorAll('[data-tracking-action="defaults"]')];
      controls.forEach(control => { control.disabled = true; });
      const restoreFocus = () => [...root.querySelectorAll('[data-tracking-action="defaults"]')]
        .find(control => control.dataset.id === id)?.focus({preventScroll:true});
      complete(ctx,kind,{ deposit_account:id, debit_account:id })
        .catch(error => ctx.notice('danger',error.message))
        .finally(() => {
          savingDefault = false;
          controls.forEach(control => { control.disabled = false; });
          restoreFocus();
        });
      return;
    }
    if (kind === 'tag-create') {
      const formNode = button.closest('[data-tracking-form]');
      const draft = ctx.ui.trackingForm;
      const tags = (draft.tags ??= [...(draft.purchase?.tags ?? [])]);
      if (tags.length >= 20) return;
      if (!tags.some(tag=>sameTag(tag,id))) tags.push(id);
      formNode.querySelector('[data-tracking-tag-search]').value = '';
      refreshPicker(formNode,ctx);
      formNode.querySelector('[data-tracking-tag-search]').focus();
      return;
    }
    if (kind === 'part-add' || kind === 'part-remove') {
      const formNode = button.closest('[data-tracking-form]');
      const parts = formNode.querySelector('[data-tracking-parts]');
      if (kind === 'part-remove') {
        button.closest('[data-tracking-part]').remove();
        formNode.querySelector('[data-tracking-action="part-add"]').focus();
      } else if (parts.childElementCount < 30) {
        parts.insertAdjacentHTML('beforeend',partRow(ctx));
        parts.lastElementChild.querySelector('select').focus();
      }
      formNode.querySelector('[data-tracking-parts-empty]').hidden = parts.childElementCount > 0;
      return;
    }
    if (kind === 'purchase_delete') {
      if (window.confirm('Удалить покупку и все части оплаты?')) {
        button.disabled = true;
        complete(ctx,kind,{id}).catch(error => ctx.notice('danger',error.message)).finally(() => { button.disabled = false; });
      }
      return;
    }
    rememberJournalScroll(ctx.ui);
    ctx.ui.trackingForm = {
      kind, id:id || crypto.randomUUID(), purchase:id ? ctx.tracking?.purchases.find(p=>p.id===id) : null,
    };
    render();
    if (kind !== 'purchase_save' && kind !== 'movement_add') {
      root.querySelector(`[data-tracking-form="${kind}"]`)?.scrollIntoView({block:'center'});
    }
  });
  root.addEventListener('toggle', event => {
    const details = event.target;
    if (details.hasAttribute('data-tracking-tags-filter')) getCtx().ui.trackingTagsOpen = details.open;
    if (details.hasAttribute('data-tracking-purchase')) {
      const ids = (getCtx().ui.trackingOpenPurchases ??= new Set());
      if (details.open) ids.add(details.dataset.trackingPurchase);
      else ids.delete(details.dataset.trackingPurchase);
    }
  }, true);
  root.addEventListener('cancel', event => {
    if (!event.target.matches('[data-tracking-dialog]')) return;
    event.preventDefault();
    close(getCtx());
  },true);
  root.addEventListener('input', event => {
    if (!event.target.matches('[data-tracking-tag-search]')) return;
    refreshPicker(event.target.closest('form'),getCtx());
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target.matches('[data-tracking-tag-search]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.target.closest('form').querySelector('[data-tracking-action="tag-create"]')?.click();
  });
  root.addEventListener('change', event => {
    if (event.target.matches('[data-tracking-income-account]')) {
      event.stopImmediatePropagation();
      const select = event.target;
      const ctx = getCtx();
      const period = select.dataset.trackingIncomeAccount;
      const previous = ctx.tracking.income_receipts?.[period]?.account_id ?? '';
      if (ctx.ui.trackingIncomeSaving) { select.value = previous; return; }
      const errorNode = select.closest('.tracking-income-account').querySelector('[data-tracking-income-error]');
      errorNode.hidden = true;
      ctx.ui.trackingIncomeSaving = true;
      select.disabled = true;
      complete(ctx,'income_account',{period,account:select.value}).catch(error => {
        if (!root.contains(select)) return;
        select.value = getCtx().tracking?.income_receipts?.[period]?.account_id ?? previous;
        errorNode.textContent = error.message;
        errorNode.hidden = false;
      }).finally(() => { ctx.ui.trackingIncomeSaving = false; select.disabled = !ctx.canEdit; });
      return;
    }
    if (event.target.matches('[data-tracking-pick-tag]')) {
      const ctx = getCtx(), draft = ctx.ui.trackingForm, tag = event.target.value;
      const selected = (draft.tags ??= [...(draft.purchase?.tags ?? [])]);
      if (event.target.checked && !selected.includes(tag)) {
        if (selected.length < 20) selected.push(tag);
        else event.target.checked = false;
      }
      if (!event.target.checked && selected.includes(tag)) selected.splice(selected.indexOf(tag),1);
      event.target.closest('form').querySelector('[data-tracking-selected-tags]').textContent = selected.join(', ') || 'Выбрать теги';
      return;
    }
    const filter = event.target.dataset.trackingFilter;
    if (!filter) return;
    const ctx = getCtx();
    const { ui } = ctx;
    const filters = (ui.trackingFilters ??= {});
    if (filter === 'tags') {
      const tags = new Set(filters.tags ?? []);
      if (event.target.checked) tags.add(event.target.value);
      else tags.delete(event.target.value);
      filters.tags = [...tags];
    } else filters[filter] = event.target.value;
    refreshJournal(ctx);
  });
  root.addEventListener('submit', async event => {
    const formNode = event.target.closest('[data-tracking-form]');
    if (!formNode) return;
    event.preventDefault();
    const submit = formNode.querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    const errorNode = formNode.querySelector('[data-tracking-error]');
    errorNode.hidden = true;
    const ctx = getCtx();
    const fields = new FormData(formNode);
    const kind = formNode.dataset.trackingForm;
    const money = value => {
      const parsed = ctx.fmt.parseNumber(value);
      if (parsed === null || !Number.isFinite(parsed)) throw new Error('Проверьте суммы');
      return parsed;
    };
    try {
      const payload = { ...Object.fromEntries(fields), id:formNode.dataset.id };
      if (fields.has('amount')) payload.amount = money(fields.get('amount'));
      if (kind === 'purchase_save') {
        const accounts = fields.getAll('part_account');
        if (!accounts.length || accounts.some(id => !id)) throw new Error('Укажите счёт для каждой части оплаты');
        const amounts = fields.getAll('part_amount');
        const parts = accounts.map((account_id,i)=>({account_id,amount:money(amounts[i])}));
        const [category, item] = JSON.parse(fields.get('category'));
        const draft = ctx.ui.trackingForm;
        const earlier = draft.purchase;
        const month = payload.date.slice(0,7);
        const samePurchase = earlier?.occurred_on.slice(0,7) === month && earlier.category_id === category
          && earlier.item_id === item && Number(earlier.total) === payload.amount;
        const family = ctx.state.account.plan_kind === 'family';
        const manual = (family ? ctx.state.family?.expense_facts : ctx.state.facts?.expense_facts) ?? [];
        const categoryHasManual = retainedFact(ctx.tracking,month) && manual.some(row => (
          family ? row.month === month && row.category_id === (item || category)
            : row.ym === month && row.category_id === category && (row.item_key ?? '') === item
        ) && Number(row.amount)>0);
        Object.assign(payload,{
          category_id:category, item_id:item, tags:draft.tags ?? earlier?.tags ?? [],
          included_in_fact:samePurchase ? earlier.included_in_fact : categoryHasManual &&
            window.confirm('За этот месяц есть ручной факт. Нажмите «ОК», если покупка уже учтена в этой сумме. «Отмена» добавит покупку к факту.'),
          parts,
        });
      }
      await complete(ctx,kind,payload);
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally { submit.disabled = false; }
  });
}
