/* ---------------------------------------------------------------------
   dom.js — сборка разметки: поля, кнопки, карточки, таблицы.

   Поля умеют править данные сами: см. edit.js. Здесь только разметка,
   никакой логики расчёта.
--------------------------------------------------------------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch]);
}

export const byId = id => document.getElementById(id);

const attr = (name, value) => (value === undefined || value === null || value === false ? '' : ` ${name}="${esc(value)}"`);
const json = value => (value === undefined ? '' : ` data-key='${esc(JSON.stringify(value)).replace(/'/g, '&#39;')}'`);
const jsonAttr = (name, value) => (value === undefined ? '' : ` ${name}='${esc(JSON.stringify(value)).replace(/'/g, '&#39;')}'`);

/* Поле ввода, привязанное к строке таблицы */
export function input({ edit, key, value, type = 'text', defaults, removeWhen, empty, disabled, style, placeholder, cls = '' }) {
  const kind = type === 'date' || type === 'monthday' ? 'date' : 'text';
  const mode = type === 'money' || type === 'number' || type === 'int' ? ' inputmode="decimal"' : '';
  return `<input class="${esc(cls)}${type === 'money' || type === 'number' || type === 'int' ? ' num' : ''}" type="${kind}"${mode}`
    + attr('data-edit', edit) + json(key) + jsonAttr('data-defaults', defaults)
    + attr('data-type', type) + attr('data-remove-when', removeWhen) + attr('data-empty', empty)
    + attr('value', value ?? '') + attr('placeholder', placeholder) + attr('style', style)
    + (disabled ? ' disabled' : '') + '>';
}

export function checkbox({ edit, key, value, defaults, disabled, title }) {
  return `<input type="checkbox" data-type="bool"` + attr('data-edit', edit) + json(key)
    + jsonAttr('data-defaults', defaults) + attr('title', title)
    + (value ? ' checked' : '') + (disabled ? ' disabled' : '')
    + ' style="width:auto;min-height:0;">';
}

export function select({ edit, key, value, options, defaults, disabled, style, type }) {
  const body = options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<select` + attr('data-edit', edit) + json(key) + jsonAttr('data-defaults', defaults)
    + attr('data-type', type) + attr('style', style) + (disabled ? ' disabled' : '') + `>${body}</select>`;
}

export function addButton({ domain, table, row, label = '+ добавить', cls = 'small', disabled }) {
  return `<button class="${esc(cls)}" data-add="${esc(domain)}|${esc(table)}"` + jsonAttr('data-row', row)
    + (disabled ? ' disabled' : '') + `>${esc(label)}</button>`;
}

export function delButton({ domain, table, key, confirm, label = '✕', cls = 'ghost small', disabled }) {
  return `<button class="${esc(cls)}" data-del="${esc(domain)}|${esc(table)}"` + json(key)
    + attr('data-confirm', confirm) + (disabled ? ' disabled' : '') + ` title="Удалить">${esc(label)}</button>`;
}

export function button({ action, value, label, cls = 'small', disabled, title }) {
  return `<button class="${esc(cls)}"` + attr(`data-${action}`, value ?? '') + attr('title', title)
    + (disabled ? ' disabled' : '') + `>${esc(label)}</button>`;
}

export function pill(text, cls = '') {
  return `<span class="pill${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
}

export function field(label, control, hint) {
  return `<div class="field"><label>${esc(label)}</label>${control}${hint ? `<div class="small-note">${esc(hint)}</div>` : ''}</div>`;
}

export function card({ title, body, actions = '', note = '', id }) {
  return `<div class="card"${attr('id', id)}>
    ${title ? `<div class="card-title row between"><h2>${esc(title)}</h2><div class="row wrap" style="gap:8px;">${actions}</div></div>` : ''}
    ${note ? `<div class="small-note">${note}</div>` : ''}
    ${body}
  </div>`;
}

/* Сворачивающийся раздел: заголовок кликается, быстрые кнопки видны всегда.
   Ключ open хранится в ui.open — переключение делает общий обработчик приложения. */
export function section({ key, title, actions = '', note = '', body, open, level = 'h2' }) {
  return `<div class="card">
    <div class="card-title" style="margin-bottom:${open ? '18px' : '0'};">
      <button class="section-head" data-toggle="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}">
        <span class="chev${open ? ' open' : ''}">▸</span><${level}>${esc(title)}</${level}></button>
      ${actions ? `<div class="row wrap" style="gap:8px;">${actions}</div>` : ''}
    </div>
    ${open ? `${note ? `<div class="small-note" style="margin-top:0;">${note}</div>` : ''}${body}` : ''}
  </div>`;
}

export function table({ head, rows, foot, scroll = true, cls = '' }) {
  const body = `<table>
    ${head ? `<thead><tr>${head.map(h => (typeof h === 'string' ? `<th>${esc(h)}</th>` : `<th class="${esc(h.cls ?? '')}">${esc(h.title)}</th>`)).join('')}</tr></thead>` : ''}
    <tbody>${rows.join('')}</tbody>
    ${foot ? `<tfoot>${foot}</tfoot>` : ''}
  </table>`;
  return scroll ? `<div class="table-scroll${cls ? ' ' + esc(cls) : ''}">${body}</div>` : body;
}

export const num = html => `<td class="num">${html}</td>`;
export const cell = html => `<td>${html}</td>`;
export const row = cells => `<tr>${cells.join('')}</tr>`;
