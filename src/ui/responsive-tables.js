/* Одна разметка и одни поля ввода; без дублирования состояния для телефона. */
export function tableLayout(labels,hasInputs){
  const matrix=labels.length>=3&&/^(месяц|год)$/i.test(labels[0]);
  return !matrix&&(labels.length<=5||hasInputs)?'mobile-cards':'mobile-comparison';
}
export function adaptTables(root){
  for(const table of root.querySelectorAll('main table')){
    const labels=[...(table.tHead?.rows[0]?.cells??[])].map(c=>c.textContent.trim());
    if(!labels.length)continue;
    table.classList.add(tableLayout(labels,Boolean(table.querySelector('input,select'))));
    table.setAttribute('role','table');
    for(const row of table.rows){
      row.setAttribute('role','row');
      const rowLabel=row.cells[0]?.querySelector('input')?.value||row.cells[0]?.textContent.trim()||'';
      let column=0;
      for(const cell of row.cells){
        const label=labels[column]||'';
        column+=cell.colSpan;
        cell.setAttribute('role',cell.tagName==='TH'?'columnheader':'cell');
        if(cell.tagName==='TH')continue;
        if(cell.colSpan>1){cell.classList.add('mobile-table-block');continue;}
        cell.dataset.label=label;
        for(const control of cell.querySelectorAll('input,select'))if(!control.hasAttribute('aria-label'))control.setAttribute('aria-label',[rowLabel,label||'Значение'].filter(Boolean).join(': '));
      }
    }
  }
}
