// Pure budget math and money helpers — no DOM, no Supabase.
//
// Every amount is in cents. Rows arrive from data.js with an `amount` field
// (cents); money() formats it as whole dollars or dollars and cents,
// depending on the household's "Round to whole dollars" setting.

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- Money ----------

let wholeDollars = true;

// The household's setting; called whenever household info loads.
export function setRounding(on) {
  wholeDollars = on !== false;
}

export const roundsToWholeDollars = () => wholeDollars;

// 4250 → "$43" (rounding on) or "$42.50"; negatives get a real minus sign.
export function money(cents) {
  const c = Math.round(Number(cents) || 0);
  const abs = Math.abs(c);
  const text = wholeDollars
    ? Math.round(abs / 100).toLocaleString('en-US')
    : (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (c < 0 ? '−$' : '$') + text;
}

// What the person typed, in cents: "42", "42.5", "$1,234.56". Rounded to
// whole dollars when that's on ($42.50 → $43, $42.49 → $42). null for
// anything else.
export function parseMoney(text) {
  const s = String(text ?? '').replace(/[$,\s]/g, '');
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) return null;
  const cents = Number(m[1] || 0) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return wholeDollars ? Math.round(cents / 100) * 100 : cents;
}

// Cents as text for an input box: "450" or "42.75".
export function moneyInput(cents) {
  if (cents == null || cents === '') return '';
  const c = Math.round(Number(cents));
  if (wholeDollars) return String(Math.round(c / 100));
  return c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
}

export function sum(list, pick) {
  return list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
}

export function signedAmount(expense) {
  const amount = Number(expense.amount);
  return expense.transaction_type === 'refund' ? -amount : amount;
}

// ---------- Budget ----------

// An emptied category keeps only what was spent (never below 0, never above
// its budget); the rest of its money belongs to Extra for that period.
export function effectiveBudget(amount, spent, emptied) {
  return emptied ? Math.max(0, Math.min(amount, spent)) : amount;
}

export function barFor(spent, budget, isExtra) {
  if (budget <= 0) {
    return spent > 0 ? { pct: 100, cls: 'fill-over' } : { pct: 0, cls: isExtra ? 'fill-accent' : 'fill-ok' };
  }
  const ratio = spent / budget;
  const cls = ratio > 1 ? 'fill-over'
    : isExtra ? 'fill-accent'
    : ratio >= 0.85 ? 'fill-warn'
    : 'fill-ok';
  return { pct: Math.round(Math.min(Math.max(ratio, 0), 1) * 100), cls };
}

// A period's category snapshot as buildBudget wants it: each non-Extra
// category with that period's amount, in display order.
// periodCategories: period_categories rows; categoriesById: Map of categories.
export function snapshotCategories(periodCategories, categoriesById) {
  return periodCategories
    .filter(pc => categoriesById.has(pc.category_id) && !categoriesById.get(pc.category_id).is_remainder)
    .map(pc => ({ ...categoriesById.get(pc.category_id), amount: pc.amount, emptied: pc.emptied }))
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}

// One entry per card on the Overview, Extra last. Expenses whose category
// isn't part of this period land in Extra so nothing goes missing.
//
// Extra is never stored: starting − fixed costs − every other category's
// (effective) budget + whatever Extra carried in from the previous period.
export function buildBudget({ starting, carryIn, fixedCosts, periodCategories, extraCategory, expenses }) {
  const fixedTotal = sum(fixedCosts, f => f.amount);
  const inPeriod = new Set(periodCategories.map(c => c.id));
  const bucketOf = e => (inPeriod.has(e.category_id) ? e.category_id : extraCategory.id);
  const withSpending = c => {
    const list = expenses.filter(e => bucketOf(e) === c.id);
    return { ...c, expenses: list, spent: sum(list, signedAmount) };
  };

  const categoryCards = periodCategories.map(withSpending).map(c => {
    const budget = effectiveBudget(c.amount, c.spent, c.emptied);
    return {
      ...c,
      isExtra: false,
      budget,
      moved: c.amount - budget,            // sent to Extra by emptying
      leftover: Math.max(0, c.amount - c.spent), // what emptying would move
    };
  });
  const moved = sum(categoryCards, c => c.moved);
  const extra = starting + carryIn - fixedTotal - sum(categoryCards, c => c.budget);
  const extraCard = { ...withSpending(extraCategory), isExtra: true, budget: extra, carryIn };

  const cards = [...categoryCards, extraCard].map(c => ({ ...c, bar: barFor(c.spent, c.budget, c.isExtra) }));
  const toSpend = starting + carryIn - fixedTotal; // everything left after bills, Extra included
  const spent = sum(cards, c => c.spent);
  return {
    cards, bucketOf, starting, carryIn, fixedTotal, extra, moved,
    toSpend, spent, left: toSpend - spent,
  };
}

// Spending per card: [{ card (row or null for "no card"), total }], in the
// household's card order; archived cards only when they were used.
export function cardTotals(expenses, cards) {
  const totals = new Map();
  for (const e of expenses) totals.set(e.card_id ?? null, (totals.get(e.card_id ?? null) ?? 0) + signedAmount(e));
  const rows = cards
    .filter(c => c.is_active || totals.has(c.id))
    .map(c => ({ card: c, total: totals.get(c.id) ?? 0 }));
  if (totals.has(null)) rows.push({ card: null, total: totals.get(null) });
  return rows;
}

// ---------- Insights ----------
// Everything is counted by pay period, never calendar month, and only real
// spending counts (never money moved to Extra or carried over).

// Existing pay_periods rows in the range, oldest first, ending with the
// current period. range: '3' | '6' (months back) | 'ytd'.
export function periodsInRange(rows, range, currentStartISO) {
  const upToNow = rows.filter(r => r.start_date <= currentStartISO);
  if (range === 'ytd') return upToNow.filter(r => r.start_date.slice(0, 4) === currentStartISO.slice(0, 4));
  const [y, m, d] = currentStartISO.split('-').map(Number);
  const back = new Date(y, m - 1 - Number(range), d);
  const pad = n => String(n).padStart(2, '0');
  const cutoff = `${back.getFullYear()}-${pad(back.getMonth() + 1)}-${pad(back.getDate())}`;
  return upToNow.filter(r => r.start_date > cutoff);
}

export function groupByPeriod(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// What was left in a period's Extra, not counting what it carried in.
export function extraLeftover(budget) {
  const extra = budget.cards.find(c => c.isExtra);
  return extra.budget - budget.carryIn - extra.spent;
}

export const NEAR_BUDGET = 1000; // within $10 (and not over) = "on budget"

// 'under' | 'near' | 'over', judged against the category's original amount
// (a category moved to Extra still counts as under if it spent less).
export function budgetStatus(spent, amount) {
  if (spent > amount) return 'over';
  if (spent <= 0 || spent < amount - NEAR_BUDGET) return 'under';
  return 'near';
}

// One plain sentence about the finished periods in the scorecard.
// rows: [{ name, cells: [{ status, spent, amount, current } | null] }]
export function overBudgetPattern(rows) {
  let worst = null;
  let anyFinished = false;
  for (const row of rows) {
    const done = row.cells.filter(c => c && !c.current);
    if (done.length) anyFinished = true;
    const overs = done.filter(c => c.status === 'over');
    if (!overs.length) continue;
    const average = Math.round(sum(overs, c => c.spent - c.amount) / overs.length);
    const share = overs.length / done.length;
    if (!worst || share > worst.share || (share === worst.share && average > worst.average)) {
      worst = { name: row.name, overs: overs.length, done: done.length, share, average };
    }
  }
  if (!anyFinished) return '';
  if (!worst) return 'Every category stayed on budget.';
  const periods = worst.done === 1 ? 'period' : 'periods';
  return `${worst.name} went over in ${worst.overs} of ${worst.done} ${periods}, by ${money(worst.average)} on average.`;
}
