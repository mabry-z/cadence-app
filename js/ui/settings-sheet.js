// Settings → the period's budget: paycheck, categories, Extra and bills.
// (The other Settings sections are wired in app.js and household.js.)
import { CATEGORY_COLORS } from '../config.js';
import { money, parseMoney, effectiveBudget, moneyInput } from '../budget.js';
import { billDueIn } from '../paydays.js';
import { errorMessage, showFormError, openSheet, closeSheet, wireSheet } from './dom.js';
import { makeRow, readRows } from './rows.js';

const backdrop = document.getElementById('settingsBackdrop');
const form = document.getElementById('settingsForm');
const scopeEl = document.getElementById('settingsScope');
const startingInput = document.getElementById('startingBudget');
const categoryRows = document.getElementById('categoryRows');
const addCategoryBtn = document.getElementById('addCategoryRow');
const extraInput = document.getElementById('extraAmount');
const extraHint = document.getElementById('extraHint');
const fixedLabel = document.getElementById('fixedLabel');
const fixedHint = document.getElementById('fixedHint');
const fixedRows = document.getElementById('fixedCostRows');
const addFixedBtn = document.getElementById('addFixedRow');
const startsOnField = document.getElementById('startsOnField');
const startsOnInput = document.getElementById('startsOnInput');
const errorEl = document.getElementById('settingsError');
const submitBtn = document.getElementById('settingsSubmit');

const EXTRA_HINT = 'Auto-calculated: paycheck − this period’s bills − all other categories';

let ctx;
let snapshot; // what the sheet was opened with; see openSettingsSheet

const amountOf = input => parseMoney(input.value) ?? 0;

// Same formula as the Extra card: emptied categories only count what they've
// spent, and Extra's carry-in from last period is included. Recurring bills
// only count when they're due in this period.
function recomputeExtra() {
  const { period } = snapshot;
  const fixedTotal = [...fixedRows.querySelectorAll('.fixed-row')].reduce((s, row) => {
    const due = row.querySelector('.due-select');
    if (due && !billDueIn(Number(due.value), period.start_date, period.next_start)) return s;
    return s + amountOf(row.querySelector('.fixed-amt'));
  }, 0);
  const categoryTotal = [...categoryRows.querySelectorAll('.fixed-row')].reduce((s, row) => {
    const amount = amountOf(row.querySelector('.cat-amt'));
    return s + effectiveBudget(amount, Number(row.dataset.spent || 0), row.dataset.emptied === 'true');
  }, 0);
  const { carryIn } = snapshot;
  const extra = amountOf(startingInput) + carryIn - fixedTotal - categoryTotal;
  const negative = extra < 0;

  let hint = EXTRA_HINT;
  if (carryIn) hint += ` · includes ${carryIn > 0 ? '+' : '−'}${money(Math.abs(carryIn))} carried from last period`;
  if (snapshot.categories.some(c => c.emptied)) hint += ' · emptied categories count only what they spent';

  extraInput.value = moneyInput(extra < 0 ? -extra : extra);
  if (negative) extraInput.value = `−${extraInput.value}`;
  extraInput.classList.toggle('negative', negative);
  extraHint.classList.toggle('negative', negative);
  extraHint.textContent = negative
    ? `Over-allocated by ${money(-extra)}. Lower a category or bill, or raise the paycheck.`
    : hint;
}

export function nextColor(container) {
  const used = new Set([...container.querySelectorAll('.fixed-row')].map(r => r.dataset.color));
  return CATEGORY_COLORS.find(c => !used.has(c)) ?? CATEGORY_COLORS[container.children.length % CATEGORY_COLORS.length];
}

// ctx: { getSnapshot(), onSave(startsOn, args) }
export function initSettingsSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  startingInput.addEventListener('input', recomputeExtra);
  form.addEventListener('input', e => {
    if (e.target.matches('.cat-amt, .fixed-amt')) recomputeExtra();
  });
  form.addEventListener('change', e => {
    if (e.target.matches('.due-select')) recomputeExtra();
  });

  form.addEventListener('click', e => {
    const btn = e.target.closest('.remove-btn');
    if (!btn) return;
    const row = btn.closest('.fixed-row');
    if (row.parentElement === categoryRows && row.dataset.id) {
      const count = snapshot.expenseCountByCategory.get(Number(row.dataset.id)) ?? 0;
      if (count > 0) {
        const name = row.querySelector('.row-name').value.trim() || 'This category';
        showFormError(errorEl, `${name} has ${count} expense${count === 1 ? '' : 's'} this period. Move or delete them first.`);
        return;
      }
    }
    showFormError(errorEl, '');
    row.remove();
    recomputeExtra();
  });

  addCategoryBtn.addEventListener('click', () => {
    categoryRows.append(makeRow({ amountClass: 'cat-amt', data: { color: nextColor(categoryRows) } }));
  });
  addFixedBtn.addEventListener('click', () => {
    const start = Number(snapshot.period.start_date.slice(8, 10));
    fixedRows.append(makeRow({ amountClass: 'fixed-amt', dueDay: snapshot.isPast ? undefined : start }));
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let categories, fixed;
    const starting = parseMoney(startingInput.value);
    try {
      if (starting === null) throw 'Enter the paycheck amount in dollars.';
      categories = readRows(categoryRows, 'cat-amt', 'category');
      fixed = readRows(fixedRows, 'fixed-amt', 'bill');
      const reserved = snapshot.extraName.toLowerCase();
      const clash = categories.find(c => c.name.toLowerCase() === reserved);
      if (clash) throw `"${clash.name}" is reserved for the auto-calculated Extra category.`;
    } catch (message) {
      return showFormError(errorEl, String(message));
    }
    showFormError(errorEl, '');

    const { period } = snapshot;
    const startsOn = snapshot.startsOn && startsOnInput.value !== snapshot.startsOn ? startsOnInput.value : null;
    if (snapshot.startsOn && !startsOnInput.value) {
      return showFormError(errorEl, 'Pick the date this period started.');
    }
    submitBtn.disabled = true;
    try {
      await ctx.onSave(startsOn, {
        p_period_id: period.id,
        p_today_start: snapshot.todayStartISO,
        p_starting: starting,
        p_categories: categories.map(({ row, name, amount }) => ({
          id: row.dataset.id ? Number(row.dataset.id) : null,
          name,
          color: row.dataset.color || null,
          amount,
        })),
        p_fixed: fixed.map(({ row, name, amount, dueDay }) => ({
          id: row.dataset.id ? Number(row.dataset.id) : null,
          template_id: row.dataset.template ? Number(row.dataset.template) : null,
          name,
          amount,
          due_day: dueDay,
        })),
      });
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, errorMessage(err));
    } finally {
      submitBtn.disabled = false;
    }
  });
}

export function openSettingsSheet() {
  // { period (row), label, isPast, todayStartISO, startsOn (ISO or null), starting, carryIn, extraName,
  //   categories: [{id, name, color, amount, emptied, spent}],
  //   bills: past → this period's fixed_costs [{id, name, amount}]; else bill templates [{id, name, amount, due_day}],
  //   expenseCountByCategory: Map }
  snapshot = ctx.getSnapshot();
  const { isPast, label } = snapshot;

  // Only periods that have started have a date to correct.
  startsOnField.hidden = !snapshot.startsOn;
  startsOnInput.value = snapshot.startsOn ?? '';

  scopeEl.textContent = isPast
    ? `${label} is a past period. Changes here apply only to it; your defaults and other periods stay the same. Categories can't be added, renamed or removed in a past period.`
    : `Changes apply to ${label} and every period after it. Earlier periods keep their own amounts.`;

  startingInput.value = moneyInput(snapshot.starting);

  categoryRows.replaceChildren(...snapshot.categories.map(c => makeRow({
    name: c.name,
    amount: c.amount,
    amountClass: 'cat-amt',
    data: { id: c.id, color: c.color, emptied: c.emptied, spent: c.spent },
    lockName: isPast,
  })));
  addCategoryBtn.hidden = isPast;

  fixedLabel.textContent = isPast ? 'Bills (this period)' : 'Recurring bills';
  fixedHint.textContent = isPast ? '' : 'Each bill comes out of the paycheck its due day falls in.';
  fixedHint.hidden = isPast;
  fixedRows.replaceChildren(...snapshot.bills.map(b => makeRow({
    name: b.name,
    amount: b.amount,
    amountClass: 'fixed-amt',
    data: isPast ? { id: b.id } : { template: b.id },
    dueDay: isPast ? undefined : b.due_day,
  })));

  showFormError(errorEl, '');
  recomputeExtra();
  openSheet(backdrop);
}
