import {test} from 'node:test';
import assert from 'node:assert/strict';
import {input} from '../src/ui/dom.js';
import {attachDateFields} from '../src/ui/date-field.js';
import {applyEdit} from '../src/ui/edit.js';
import {mobileNavigation,attachMobileNavigation} from '../src/ui/mobile-navigation.js';
import {tableLayout,adaptTables} from '../src/ui/responsive-tables.js';

test('мобильные таблицы: ввод карточками, годовые матрицы сохраняют сравнение',()=>{
  assert.equal(tableLayout(['Месяц','Всего','Разовые','Общий доход'],false),'mobile-comparison');
  assert.equal(tableLayout(['Год',...Array.from({length:12},(_,i)=>String(i+1))],true),'mobile-comparison');
  assert.equal(tableLayout(['Категория','План','Факт','Разница'],true),'mobile-cards');
  assert.equal(tableLayout(['Название','С','По','Начислено','В плане','На руки','Откуда','Дата','',''],true),'mobile-cards');
  assert.equal(tableLayout(['Категория','Доля','План','Факт','Разница','Среднее'],false),'mobile-comparison');
});

test('подписи мобильного итога учитывают объединённые ячейки',()=>{
  const cell=(text,colSpan=1,tagName='TD')=>({
    textContent:text,colSpan,tagName,dataset:{},classList:{add(){}},
    setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},
  });
  const head={cells:['Дата','Праздник','Сумма','Статус'].map(text=>cell(text,1,'TH')),setAttribute(){}};
  const total={cells:[cell('Итого за 2027',2),cell('35 000 ₽'),cell('')],setAttribute(){}};
  const table={tHead:{rows:[head]},rows:[head,total],classList:{add(){}},setAttribute(){},querySelector(){return null;}};
  adaptTables({querySelectorAll:()=>[table]});
  assert.equal(total.cells[1].dataset.label,'Сумма');
  assert.equal(total.cells[2].dataset.label,'Статус');
});

test('необязательная дата: явный сброс и Safari input без change записывают null',()=>{
  const listeners={};let writes=0;
  const state={savings:{goals:[{id:'g',deadline:'2027-06-01'}]}};
  const store={state,update(domain,fn){writes++;fn(state[domain]);}};
  const date={value:'2027-06-01',disabled:false,validity:{badInput:false},dataset:{edit:'savings|goals|deadline',key:'{"id":"g"}',type:'date'},matches:()=>true};
  const button={disabled:false,closest:()=>({querySelector:()=>date})};
  attachDateFields({addEventListener(type,fn){listeners[type]=fn;}},el=>applyEdit(store,el,{}));
  listeners.click({target:{closest:()=>button}});
  assert.equal(state.savings.goals[0].deadline,null);
  state.savings.goals[0].deadline='2027-06-01';date.value='';listeners.input({target:date});
  assert.equal(state.savings.goals[0].deadline,'2027-06-01','input при открытии/работе календаря ещё не сохраняет');
  listeners.focusout({target:date});
  assert.equal(state.savings.goals[0].deadline,null);assert.equal(writes,2);
  date.validity.badInput=true;listeners.input({target:date});assert.equal(writes,2);
  button.disabled=true;listeners.click({target:{closest:()=>button}});assert.equal(writes,2);
  date.validity.badInput=false;listeners.input({target:date});listeners.focusout({target:date});
  assert.equal(writes,2,'повторная пустая дата не вызывает запись');
  assert.match(input({type:'date',clearable:true,value:'2027-01-01',disabled:true}),/data-clear-date[^>]*disabled/);
  assert.doesNotMatch(input({type:'date',value:'2027-01-01'}),/data-clear-date/);
});

test('меню телефона: выбор раздела закрывает меню, открытие сохраняет состояние',()=>{
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const listeners={},ui={mobileMenu:false};let renders=0,closed=0;
  globalThis.window={matchMedia:()=>({addEventListener(){}})};
  globalThis.document={body:{classList:{remove(){}}}};
  try{
    attachMobileNavigation({addEventListener(type,fn){listeners[type]=fn;},querySelector:()=>({close(){closed++;}})},ui,()=>renders++);
    listeners.click({target:{closest:s=>s==='[data-mobile-menu-open]'?{}:null}});
    assert.equal(ui.mobileMenu,true);assert.equal(renders,1);
    listeners.click({target:{closest:s=>s==='[data-tab]'?{}:null}});assert.equal(ui.mobileMenu,false);
    listeners.click({target:{closest:s=>s==='[data-mobile-menu-close]'?{}:null}});assert.equal(closed,1);
    assert.match(mobileNavigation('<button>Доходы</button>'),/aria-haspopup="dialog"/);
  }finally{globalThis.window=oldWindow;globalThis.document=oldDocument;}
});
