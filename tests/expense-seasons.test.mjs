import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAmountSeasons, expenseAmountOn } from '../src/engine/expense-seasons.js';
import { monthlyAmountOn, categoryShare, planExpenses, expenseAppliesInMonth } from '../src/engine/expenses.js';

test('сезоны сумм: реальные даты, Новый год, граничное пересечение и 29 февраля', () => {
  assert.equal(validateAmountSeasons([{from:'12-01',to:'03-20',amount:100},{from:'03-21',to:'11-30',amount:200}]),null);
  assert.match(validateAmountSeasons([{from:'12-01',to:'03-20',amount:100},{from:'03-20',to:'04-01',amount:200}]),/пересекаться/);
  assert.match(validateAmountSeasons([{from:'11-31',to:'12-31',amount:100}]),/существующие/);
  assert.equal(validateAmountSeasons([{from:'02-29',to:'02-29',amount:0}]),null);
  assert.match(validateAmountSeasons([{from:'02-01',to:'02-28',amount:-1}]),/неотрицательным/);
  assert.match(validateAmountSeasons([null]),/некорректен/);
});

test('сезоны сумм: основная сумма вне интервалов, старое ограничение периода сохранено', () => {
  const row = {amount:18000,amount_seasons:[{from:'09-20',to:'11-30',amount:22000},{from:'12-01',to:'01-15',amount:25000}]};
  assert.equal(expenseAmountOn(row,'2027-09-19'),18000);
  assert.equal(expenseAmountOn(row,'2027-09-20'),22000);
  assert.equal(expenseAmountOn(row,'2027-11-30'),22000);
  assert.equal(expenseAmountOn(row,'2028-01-15'),25000);
  assert.equal(expenseAmountOn(row,'2028-01-16'),18000);
  assert.equal(expenseAmountOn({...row,season_from:'09-01',season_to:'12-31'},'2028-01-05'),0);
  assert.equal(expenseAppliesInMonth({...row,amount:0,amount_seasons:[{from:'09-01',to:'09-30',amount:10}]},'2027-10'),false);
});

test('сезоны сумм: статьи, доля категории и выплаты пересчитываются без кэша', () => {
  const categories = [{id:'life',mode:'fixed_month',split_mode:'even'},{id:'joy',mode:'percent_income',monthly_amount:2000}];
  const items = [{id:'food',category_id:'life',amount:6000,amount_seasons:[{from:'06-01',to:'08-31',amount:18000}]}];
  assert.equal(monthlyAmountOn(categories[0],items,'2027-07-01'),18000);
  assert.equal(categoryShare(categories[1],categories,items,'2027-07-01'),10);
  const periods = [{id:'a',pay_date:'2027-07-05',window_start:'2027-07-01',window_end:'2027-07-15',slot_order:1},{id:'b',pay_date:'2027-07-20',window_start:'2027-07-16',window_end:'2027-07-31',slot_order:2}];
  const run = () => planExpenses({categories,items,periods,incomeById:new Map([['a',10000],['b',10000]])});
  assert.deepEqual(run().byPeriod.get('a').categories.map(c=>c.planned),[9000,1000]);
  items[0].amount_seasons[0].amount=8000;
  assert.deepEqual(run().byPeriod.get('a').categories.map(c=>c.planned),[4000,2000]);
});
