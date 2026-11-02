/* Данные только для интеграционных тестов; в приложение не подключаются. */
import { uid } from "../../src/ui/edit.js";

export function fillSample(ctx, year) {
  const { store } = ctx;
  store.update('income', d => {
    d.plan_years = [{ year, calendar_code: 'ru', note: '' }];
    d.payout_slots = [
      { year, sort_order: 1, title: 'Аванс', pay_day: 20, month_offset: 0, window_from_day: 1, window_to_day: 15, shift_rule: 'back' },
      { year, sort_order: 2, title: 'Зарплата', pay_day: 5, month_offset: 1, window_from_day: 16, window_to_day: 31, shift_rule: 'back' },
    ];
    d.salary_rates = [{ id: uid('rate'), effective_from: `${year}-01-01`, amount: 230000, is_gross: true, note: '' }];
    d.tax_scales = [{ id: 'ndfl', title: 'НДФЛ', valid_from_year: 2025, cumulative: true }];
    d.tax_brackets = [
      { scale_id: 'ndfl', sort_order: 1, up_to: 2400000, rate: 13 },
      { scale_id: 'ndfl', sort_order: 2, up_to: 5000000, rate: 15 },
      { scale_id: 'ndfl', sort_order: 3, up_to: 20000000, rate: 18 },
      { scale_id: 'ndfl', sort_order: 4, up_to: 50000000, rate: 20 },
      { scale_id: 'ndfl', sort_order: 5, up_to: null, rate: 22 },
    ];
    d.vacations = [{ id: uid('vac'), title: 'Отпуск', start_date: `${year}-08-10`, end_date: `${year}-08-17`, pay_amount: 0, pay_manual: false }];
  });
  store.update('expenses', d => {
    d.expense_categories = [
      { id: 'cat-life', title: 'Жизнь', mode: 'fixed_month', monthly_amount: 60000, percent_value: 0, split_mode: 'even', sort_order: 1 },
      { id: 'cat-home', title: 'Дом', mode: 'fixed_month', monthly_amount: 20000, percent_value: 0, split_mode: 'by_days', sort_order: 2 },
      { id: 'cat-joy', title: 'Радости', mode: 'percent_income', monthly_amount: 15000, percent_value: 7, split_mode: 'even', sort_order: 3 },
    ];
  });
  store.update('savings', d => {
    const gifts = (d.goals ?? []).find(g => g.kind_code === 'gifts');
    d.goals = [
      { id: 'goal-trip', title: 'Путешествия', kind_code: 'bucket', currency_code: 'RUB', priority: 1, target_amount: 0, starting_balance: 0, pace_amount: 0, completed: false },
      ...(gifts ? [{ ...gifts, priority: 2 }] : []),
      { id: 'goal-cushion', title: 'Подушка', kind_code: 'reserve', currency_code: 'RUB', priority: 3, target_amount: 300000, starting_balance: 0, pace_amount: 5000, completed: false },
    ];
    d.goal_milestones = [
      { id: 'trip-1', goal_id: 'goal-trip', title: 'Весна', target: 150000, deadline: `${year}-04-01`, source: 'manual', user_edited: false, sort_order: 1 },
      { id: 'trip-2', goal_id: 'goal-trip', title: 'Лето', target: 200000, deadline: `${year}-07-31`, source: 'manual', user_edited: false, sort_order: 2 },
    ];
    d.goal_transactions = [
      { id: 'trip-s1', goal_id: 'goal-trip', date: `${year}-04-05`, amount: 150000, kind: 'spend', title: 'Поездка весной', source: 'manual', user_edited: false },
      { id: 'trip-s2', goal_id: 'goal-trip', date: `${year}-07-20`, amount: 200000, kind: 'spend', title: 'Поездка летом', source: 'manual', user_edited: false },
    ];
  });
  store.update('gifts', d => {
    const goalId = (store.state.savings?.goals ?? []).find(g => g.kind_code === 'gifts')?.id ?? 'goal-gifts';
    d.gift_events = [
      { id: 'gift-mom', goal_id: goalId, title: 'ДР мамы', day: 15, month: 3, repeat_kind: 'yearly', sort_order: 1 },
      { id: 'gift-ny', goal_id: goalId, title: 'Новый год', day: 25, month: 12, repeat_kind: 'yearly', sort_order: 2 },
    ];
    d.gift_event_amounts = [
      { event_id: 'gift-mom', year, amount: 10000 },
      { event_id: 'gift-ny', year, amount: 25000 },
    ];
  });
  store.update('debts', d => {
    d.credit_cards = [{ id: 'card-1', title: 'Кредитка', credit_limit: 150000, grace_days: 55, currency_code: 'RUB', sort_order: 1 }];
    d.credit_card_ops = [{ id: 'op-1', card_id: 'card-1', op_date: `${year}-02-10`, amount: 60000, kind: 'spend', title: 'Техника', sort_order: 1 }];
  });
}
