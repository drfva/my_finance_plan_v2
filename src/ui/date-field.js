export function nullableDate(control,{disabled,hasValue}){
  return `<span class="date-field">${control}<button type="button" class="ghost date-clear" data-clear-date aria-label="Сбросить дату" title="Сбросить дату"${disabled||!hasValue?' disabled':''}>✕</button></span>`;
}
export function attachDateFields(root,commit){
  const pendingClear = new WeakSet();
  root.addEventListener('click',ev=>{
    const button=ev.target.closest('[data-clear-date]');if(!button||button.disabled)return;
    const input=button.closest('.date-field')?.querySelector('input');if(!input||input.disabled)return;
    input.value='';commit(input);
  });
  // Safari может отправить input без change. Ждём выхода из поля:
  // открытие календаря и промежуточная пустая дата ничего не записывают.
  root.addEventListener('input',ev=>{
    const input=ev.target;
    if (!input.matches('.date-field input')) return;
    if(input.value===''&&!input.validity.badInput&&!input.disabled) pendingClear.add(input);
    else pendingClear.delete(input);
  });
  root.addEventListener('focusout',ev=>{
    const input=ev.target;
    if (!pendingClear.has(input)) return;
    pendingClear.delete(input);
    if (input.isConnected !== false && input.value===''&&!input.validity.badInput&&!input.disabled) commit(input);
  });
}
