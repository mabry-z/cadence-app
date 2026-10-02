import { money, sum, MONTHS_SHORT } from '../budget.js';
import { fromISO } from '../paydays.js';
import { esc } from './dom.js';

const billsEl = document.getElementById('billsCard');

// "Due Oct 18" under a recurring bill.
function dueNote(f) {
  if (!f.due_date) return '';
  const d = fromISO(f.due_date);
  return `<div class="bill-note">Due ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}</div>`;
}

export function initBills({ onTogglePaid }) {
  billsEl.addEventListener('click', e => {
    const check = e.target.closest('.check');
    if (check) onTogglePaid(Number(check.dataset.id), !check.classList.contains('checked'));
  });
}

export function renderBills(fixedCosts) {
  if (!fixedCosts.length) {
    billsEl.innerHTML = '<div class="empty">No bills due this period. Add recurring bills in Settings.</div>';
    return;
  }

  const paid = fixedCosts.filter(f => f.is_paid);
  const total = sum(fixedCosts, f => f.amount);
  const paidTotal = sum(paid, f => f.amount);
  const pct = total > 0 ? Math.round((paidTotal / total) * 100) : 0;

  // Unpaid first, then paid; by due date within each.
  const ordered = [...fixedCosts].sort((a, b) =>
    (a.is_paid - b.is_paid) || String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')) || a.name.localeCompare(b.name));

  billsEl.innerHTML = `
    <div class="progress-line"><b>${paid.length} of ${fixedCosts.length} paid</b> · ${money(paidTotal)} of ${money(total)}</div>
    <div class="bar-track" style="margin-bottom:14px;"><div class="bar-fill fill-ok" style="width:${pct}%"></div></div>
    ${ordered.map(f => `
      <div class="bill-row${f.is_paid ? ' paid' : ''}">
        <button type="button" class="check${f.is_paid ? ' checked' : ''}" data-id="${f.id}"
          aria-label="Mark ${esc(f.name)} as ${f.is_paid ? 'unpaid' : 'paid'}">${f.is_paid ? '✓' : ''}</button>
        <div class="bill-name"><div class="bill-title">${esc(f.name)}</div>${dueNote(f)}</div>
        <div class="bill-amt">${money(f.amount)}</div>
      </div>`).join('')}`;
}
