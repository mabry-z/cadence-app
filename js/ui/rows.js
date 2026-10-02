// Editable name + amount (+ due day) rows: categories and bills in Settings
// and in setup.
import { moneyInput, parseMoney } from '../budget.js';
import { ordinal } from '../paydays.js';

// <option>s for days 1–31; 31 reads "Last day".
export function dayOptions(selected) {
  let html = '';
  for (let d = 1; d <= 31; d++) {
    html += `<option value="${d}"${d === selected ? ' selected' : ''}>${d === 31 ? 'Last day' : ordinal(d)}</option>`;
  }
  return html;
}

// A name + amount + ✕ row. `data` lands on row.dataset (ids, colour).
// dueDay: a number adds a "Due the …" picker (recurring bills).
export function makeRow({ name = '', amount = null, amountClass, data = {}, lockName = false, dueDay, placeholder = 'Name' }) {
  const row = document.createElement('div');
  row.className = 'fixed-row';
  Object.assign(row.dataset, data);
  const due = dueDay != null
    ? `<select class="select due-select" aria-label="Due day">${dayOptions(dueDay)}</select>`
    : '';
  row.innerHTML = `<input type="text" class="row-name" maxlength="40" placeholder="${placeholder}">`
    + `<div class="amount-field"><span>$</span><input type="text" class="${amountClass}" inputmode="decimal" placeholder="0"></div>`
    + due
    + '<button type="button" class="remove-btn" aria-label="Remove">✕</button>';
  if (data.color) {
    row.insertAdjacentHTML('afterbegin', `<span class="cat-dot row-dot" style="background:${data.color};"></span>`);
  }
  row.querySelector('.row-name').value = name;
  row.querySelector('.row-name').disabled = lockName;
  row.querySelector(`.${amountClass}`).value = amount == null ? '' : moneyInput(amount);
  row.querySelector('.remove-btn').hidden = lockName;
  return row;
}

// Reads the rows back; skips rows left completely blank. A blank amount
// counts as $0 when blankIsZero. Throws a message for the person.
export function readRows(container, amountClass, label, { blankIsZero = false } = {}) {
  const rows = [];
  const seen = new Set();
  for (const row of container.querySelectorAll('.fixed-row')) {
    const name = row.querySelector('.row-name').value.trim();
    const rawAmount = row.querySelector(`.${amountClass}`).value.trim();
    if (!name && !rawAmount && !row.dataset.id && !row.dataset.template) continue;
    const amount = rawAmount === '' && blankIsZero ? 0 : parseMoney(rawAmount);
    if (!name) throw `Every ${label} needs a name.`;
    if (amount === null) throw `${name}: enter an amount in dollars.`;
    if (seen.has(name.toLowerCase())) throw `There are two ${label}s named "${name}".`;
    seen.add(name.toLowerCase());
    const due = row.querySelector('.due-select');
    rows.push({ row, name, amount, dueDay: due ? Number(due.value) : null });
  }
  return rows;
}
