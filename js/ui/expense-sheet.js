import { parseMoney, moneyInput, money, roundsToWholeDollars } from '../budget.js';
import { esc, errorMessage, showFormError, openSheet, closeSheet, wireSheet, selectChip } from './dom.js';

const backdrop = document.getElementById('expenseBackdrop');
const form = document.getElementById('expenseForm');
const titleEl = document.getElementById('expenseTitle');
const categoryChips = document.getElementById('categoryChips');
const merchantInput = document.getElementById('merchantInput');
const suggestEl = document.getElementById('merchantSuggest');
const typeChips = document.getElementById('typeChips');
const amountInput = document.getElementById('amountInput');
const amountHint = document.getElementById('amountHint');
const cardField = document.getElementById('cardField');
const cardChips = document.getElementById('cardChips');
const errorEl = document.getElementById('expenseError');
const submitBtn = document.getElementById('expenseSubmit');
const deleteBtn = document.getElementById('expenseDelete');
const paidFromChips = document.getElementById('paidFromChips');
const paidFromHint = document.getElementById('paidFromHint');
const categoryField = document.getElementById('categoryField');

let ctx;
let editing = null;

const selectedValue = group => group.querySelector('.chip.selected')?.dataset.value ?? null;

function selectByValue(group, value) {
  const chip = [...group.querySelectorAll('.chip')].find(c => c.dataset.value === String(value));
  selectChip(group, chip ?? group.querySelector('.chip'));
}

// Stores entered before, matching what's typed. Tap the name to fill it in,
// or the ✕ end to hide that store from suggestions.
function renderSuggestions() {
  const stores = ctx.suggestMerchants(merchantInput.value, Number(selectedValue(categoryChips)));
  suggestEl.innerHTML = stores.map(s =>
    `<span class="chip suggest-chip">`
    + `<button type="button" class="suggest-name" data-merchant="${esc(s.name)}">${esc(s.name)}</button>`
    + `<button type="button" class="suggest-hide" data-hide="${esc(s.key)}" aria-label="Stop suggesting ${esc(s.name)}">✕</button>`
    + `</span>`).join('');
  suggestEl.hidden = !stores.length;
}

// "Saved as $43 · rounding to whole dollars is on" when cents were typed.
function updateAmountHint() {
  const typed = amountInput.value.trim();
  const cents = parseMoney(typed);
  if (roundsToWholeDollars() && cents != null && /\.\d*[1-9]/.test(typed)) {
    amountHint.innerHTML = `Saved as <b>${money(cents)}</b> · rounding to whole dollars is on`;
  } else {
    amountHint.textContent = roundsToWholeDollars() ? 'Whole dollars' : '';
  }
}

const fromSavings = () => selectedValue(paidFromChips) === 'savings';

// Savings purchases don't count toward a category, so the choice is dimmed.
function updatePaidFrom() {
  const savings = fromSavings();
  categoryField.classList.toggle('muted', savings);
  paidFromHint.hidden = !savings;
}

// ctx: { getCategoryChoices() → [{id, name}], categoryIdOf(expense),
//        getCards() → active cards, cardById(id),
//        suggestMerchants(typed, categoryId) → [{name, key}], onHideMerchant(key),
//        onSave({id?, category_id, merchant, amount, card_id, transaction_type, from_savings}), onDelete(id) }
export function initExpenseSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  merchantInput.addEventListener('input', renderSuggestions);
  amountInput.addEventListener('input', updateAmountHint);
  suggestEl.addEventListener('click', async e => {
    const hide = e.target.closest('[data-hide]');
    if (hide) {
      hide.closest('.chip').remove(); // straight away; the list redraws once it's saved
      await ctx.onHideMerchant(hide.dataset.hide);
      renderSuggestions();
      return;
    }
    const chip = e.target.closest('[data-merchant]');
    if (!chip) return;
    merchantInput.value = chip.dataset.merchant;
    renderSuggestions();
  });

  for (const group of [categoryChips, typeChips, cardChips, paidFromChips]) {
    group.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) selectChip(group, chip);
    });
  }
  // After the selection above: the category changes which stores come first.
  categoryChips.addEventListener('click', renderSuggestions);
  paidFromChips.addEventListener('click', updatePaidFrom);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const merchant = merchantInput.value.trim();
    const amount = parseMoney(amountInput.value);

    if (!merchant) return showFormError(errorEl, 'Enter a merchant.');
    if (!amount) return showFormError(errorEl, 'Enter an amount of more than $0.');
    showFormError(errorEl, '');

    const card = selectedValue(cardChips);
    submitBtn.disabled = true;
    try {
      await ctx.onSave({
        id: editing?.id,
        category_id: Number(selectedValue(categoryChips)),
        merchant,
        amount,
        card_id: card ? Number(card) : null,
        transaction_type: selectedValue(typeChips),
        from_savings: fromSavings(),
      });
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't save: ${errorMessage(err)}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Two taps instead of confirm(), which some browsers block silently.
  deleteBtn.addEventListener('click', async () => {
    if (!editing) return;
    if (!deleteBtn.dataset.armed) {
      deleteBtn.dataset.armed = 'true';
      deleteBtn.textContent = `Tap again to delete ${editing.merchant || 'this expense'}`;
      return;
    }
    deleteBtn.disabled = true;
    try {
      await ctx.onDelete(editing.id);
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't delete: ${errorMessage(err)}`);
    } finally {
      deleteBtn.disabled = false;
    }
  });
}

function renderCardChips(expense) {
  const cards = ctx.getCards();
  // An archived card still shows on the purchases that used it.
  const old = expense?.card_id && !cards.some(c => c.id === expense.card_id) ? ctx.cardById(expense.card_id) : null;
  const list = old ? [...cards, old] : cards;
  cardField.hidden = !list.length;
  cardChips.innerHTML = list.map(c =>
    `<button type="button" class="chip card-chip" data-value="${c.id}">`
    + `<span class="card-badge" style="background:${esc(c.color)};">${esc(c.badge)}</span>`
    + `<span class="card-label">${esc(c.name)}</span></button>`
  ).join('');
}

// Pass an expense to edit it, or nothing to add a new one.
export function openExpenseSheet(expense = null) {
  editing = expense;
  const choices = ctx.getCategoryChoices();

  categoryChips.innerHTML = choices.map(c =>
    `<button type="button" class="chip" data-value="${c.id}">${esc(c.name)}</button>`
  ).join('');
  renderCardChips(expense);

  if (expense) {
    const catId = ctx.categoryIdOf(expense);
    selectByValue(categoryChips, choices.some(c => c.id === catId) ? catId : choices[0].id); // Extra
    merchantInput.value = expense.merchant || '';
    selectByValue(typeChips, expense.transaction_type || 'expense');
    amountInput.value = moneyInput(expense.amount);
    if (expense.card_id) selectByValue(cardChips, expense.card_id);
    else cardChips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  } else {
    selectChip(categoryChips, categoryChips.querySelector('.chip'));
    merchantInput.value = '';
    selectByValue(typeChips, 'expense');
    amountInput.value = '';
    selectChip(cardChips, cardChips.querySelector('.chip'));
  }
  selectByValue(paidFromChips, expense?.from_savings ? 'savings' : 'budget');

  titleEl.textContent = expense ? 'Edit expense' : 'Add expense';
  submitBtn.textContent = expense ? 'Save changes' : 'Add expense';
  deleteBtn.hidden = !expense;
  deleteBtn.textContent = 'Delete expense';
  delete deleteBtn.dataset.armed;
  updatePaidFrom();
  updateAmountHint();
  showFormError(errorEl, '');
  renderSuggestions();
  openSheet(backdrop);
}
