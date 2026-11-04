export function nullableDate(control,{disabled,hasValue}){
  return `<span class="date-field">${control}<button type="button" class="ghost date-clear" data-clear-date aria-label="Сбросить дату" title="Сбросить дату"${disabled||!hasValue?' disabled':''}>✕</button></span>`;
}
export function attachDateFields(root,commit){
  root.addEventListener('click',ev=>{
    const button=ev.target.closest('[data-clear-date]');if(!button||button.disabled)return;
    const input=button.closest('.date-field')?.querySelector('input');if(!input||input.disabled)return;
    input.value='';commit(input);
  });
  // Safari может отправить input при очистке picker без ожидаемого change.
  root.addEventListener('input',ev=>{
    const input=ev.target;
    if(input.matches('.date-field input')&&input.value===''&&!input.validity.badInput&&!input.disabled)commit(input);
  });
}
