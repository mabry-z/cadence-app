import * as db from './data.js';
import * as auth from './auth.js';
import { buildBudget, cardTotals, snapshotCategories, signedAmount, setRounding } from './budget.js';
import { merchantIndex, suggestMerchants, isSuggested, merchantKey } from './merchants.js';
import {
  today, toISO, fromISO, addDays, rangeLabel, expectedPayday, nextPayday, describeSchedule,
} from './paydays.js';
import { showToast, errorMessage } from './ui/dom.js';
import { initOverview, renderOverview } from './ui/overview.js';
import { initBills, renderBills } from './ui/bills.js';
import { renderSummary } from './ui/summary.js';
import { initInsights, renderInsights, invalidateInsights } from './ui/insights.js';
import { initExpenseSheet, openExpenseSheet } from './ui/expense-sheet.js';
import { initSettingsSheet, openSettingsSheet } from './ui/settings-sheet.js';
import { initPaydaySheet, openPaydaySheet } from './ui/payday-sheet.js';
import { initSignIn, showSignIn, hideGate, inviteFromLink, clearInviteLink } from './ui/sign-in.js';
import { initHousehold, renderHousehold, openPasswordSheet } from './ui/household.js';
import { initAppearance } from './ui/appearance.js';
import { initStoresSheet } from './ui/stores-sheet.js';
import { initCardSheet, openCardSheet, cardListHtml } from './ui/card-sheet.js';
import { startOnboarding, startJoin, codeKind, refreshOnboardingCards } from './ui/onboarding.js';
import { scheduleForm } from './ui/schedule-form.js';
import { openSheet, closeSheet, wireSheet, showFormError } from './ui/dom.js';

// Start asking about the next paycheck this many days before its expected
// date — the bank usually deposits a day or two early.
const PAYDAY_ASK_DAYS_EARLY = 3;
const NOT_YET_KEY = 'cadence.paydayNotYet';

const state = {
  info: null,            // household_info(): name, members, pay_schedule, round_whole, …
  email: '',
  period: null,          // the period being viewed: a pay_periods row, or { start_date, next_start } not made yet
  payPeriods: [],        // every pay_periods row, oldest first
  periodRow: null,       // pay_periods row for the viewed period
  carryIn: 0,            // Extra carried into the viewed period
  categories: [],        // every category, including archived ones and Extra
  periodCategories: [],  // this period's snapshot: [{ id, name, color, sort_order, amount, emptied }]
  extraCategory: null,
  fixedCosts: [],
  expenses: [],
  cards: [],             // every card, archived ones too
  budget: null,
  merchants: new Map(),  // every store entered, for suggestions (see merchants.js)
  authorColors: new Map(), // user_id → dot colour for "who added this"
  hiddenMerchants: new Set(), // stores hidden from suggestions (merchantKey()s)
  activeScreen: 'overview',
};

const periodLabelEl = document.getElementById('periodLabel');
const welcomeEl = document.getElementById('welcomeCard');

const schedule = () => state.info.pay_schedule;

// Savings purchases are shown but never counted.
const budgetExpenses = expenses => expenses.filter(e => !e.from_savings);

const cardById = id => state.cards.find(c => c.id === id) ?? null;
const activeCards = () => state.cards.filter(c => c.is_active);

// ---------- Periods and their real dates ----------

const rowAt = startISO => state.payPeriods.find(r => r.start_date === startISO);
const startedRows = () => state.payPeriods.filter(r => r.starts_on);

// The period after `period`: the existing row, or one worked out from the schedule.
function periodAfter(period) {
  return rowAt(period.next_start)
    ?? { start_date: period.next_start, next_start: toISO(nextPayday(schedule(), fromISO(period.next_start))) };
}

function periodBefore(period) {
  const i = state.payPeriods.findIndex(r => r.start_date === period.start_date);
  return i > 0 ? state.payPeriods[i - 1] : null;
}

// The latest period whose pay has arrived (confirmed start on or before today).
function currentPeriod() {
  const todayISO = toISO(today());
  return startedRows().filter(r => r.starts_on <= todayISO).at(-1) ?? state.payPeriods[0] ?? null;
}

const samePeriod = (a, b) => !!a && !!b && a.start_date === b.start_date;

// Confirmed start, or when its pay is expected.
function startOf(period) {
  const row = rowAt(period.start_date);
  return row?.starts_on ? fromISO(row.starts_on) : expectedPayday(fromISO(period.start_date)).date;
}

const endOf = period => addDays(startOf(periodAfter(period)), -1);

function periodRangeLabel(period) {
  return rangeLabel(startOf(period), endOf(period));
}

// ---------- Loading ----------

let loadToken = 0;
let lastLoadedAt = 0;

// quiet: background refresh — don't dim the screen.
async function loadAll({ quiet = false } = {}) {
  const token = ++loadToken;
  const period = { ...state.period };
  renderPeriodLabel();
  if (!quiet) document.body.classList.add('is-loading');
  invalidateInsights();

  try {
    const periodRow = await db.ensurePeriod(period.start_date, period.next_start);
    const [payPeriods, carryIn, categories, periodCats, fixedCosts, expenses, cards] = await Promise.all([
      db.loadPayPeriods(),
      db.loadCarryIn(periodRow.id),
      db.loadCategories(),
      db.loadPeriodCategories(periodRow.id),
      db.loadFixedCosts(periodRow.id),
      db.loadExpenses(periodRow.id),
      db.loadCards(),
    ]);
    if (token !== loadToken) return; // the user moved to another period meanwhile

    state.payPeriods = payPeriods;
    state.period = rowAt(periodRow.start_date) ?? periodRow;
    state.periodRow = state.period;
    state.carryIn = carryIn;
    state.categories = categories;
    state.extraCategory = categories.find(c => c.is_remainder);
    state.periodCategories = snapshotCategories(periodCats, new Map(categories.map(c => [c.id, c])));
    state.fixedCosts = fixedCosts;
    state.expenses = expenses;
    state.cards = cards;
    lastLoadedAt = Date.now();
    render();
  } catch (err) {
    if (token === loadToken) showToast(`Couldn't load this period: ${errorMessage(err)}`);
  } finally {
    if (token === loadToken) document.body.classList.remove('is-loading');
  }
}

// ---------- Rendering ----------

function renderPeriodLabel() {
  periodLabelEl.textContent = periodRangeLabel(state.period);
  periodLabelEl.classList.toggle('off-current', !samePeriod(state.period, currentPeriod()));
  document.getElementById('prevPeriod').disabled = !periodBefore(state.period);
}

// First period, nothing spent yet: a short welcome instead of a blank page.
function renderWelcome() {
  const first = state.payPeriods.length <= 1 && !state.expenses.length;
  welcomeEl.hidden = !first;
  if (!first) return;
  const next = expectedPayday(fromISO(state.period.next_start)).date;
  welcomeEl.innerHTML = `<div class="welcome-title">You’re all set</div>
    <div class="welcome-text">Tap + to add your first purchase. Your next paycheck is expected ${next.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}. We’ll ask when it lands.</div>`;
}

function render() {
  renderPeriodLabel();
  state.budget = buildBudget({
    starting: state.periodRow.starting,
    carryIn: state.carryIn,
    fixedCosts: state.fixedCosts,
    periodCategories: state.periodCategories,
    extraCategory: state.extraCategory,
    expenses: budgetExpenses(state.expenses),
  });
  renderWelcome();
  renderOverview(state.budget, state.expenses, state.authorColors, id => cardById(id)?.name ?? '');
  renderBills(state.fixedCosts);
  renderSummary(state.budget, cardTotals(state.expenses, state.cards), {
    fixedCosts: state.fixedCosts,
    start: startOf(state.period),
    end: endOf(state.period),
    savings: state.expenses.filter(e => e.from_savings).reduce((n, e) => n + signedAmount(e), 0),
  });
  renderSettingsLists();
  if (state.activeScreen === 'insights') renderInsights();
}

// Settings → Pay schedule / Cards / Money.
function renderSettingsLists() {
  document.getElementById('scheduleSummary').textContent = describeSchedule(schedule());
  document.getElementById('cardList').innerHTML = cardListHtml(state.cards);
  const round = document.getElementById('roundingSwitch');
  round.classList.toggle('off', !state.info.round_whole);
  round.setAttribute('aria-checked', String(state.info.round_whole));
}

// The category a store went to most often, or null for a new store.
function suggestCategory(merchant) {
  const m = state.merchants.get(merchantKey(merchant));
  if (!m) return null;
  let best = null;
  let bestCount = 0;
  for (const [id, count] of m.byCategory) if (count > bestCount) { best = id; bestCount = count; }
  return best;
}

// Store names for suggestions; refreshed after saves and on return.
async function loadMerchants() {
  try {
    state.merchants = merchantIndex(await db.loadMerchantHistory(), e => e.category_id);
  } catch {
    // Suggestions are a nicety; keep the list we had.
  }
  try {
    state.hiddenMerchants = new Set(await db.loadHiddenMerchants());
  } catch {
    // Same.
  }
}

// Hide or unhide a store's suggestions. Changes straight away; put back if
// the save fails.
async function setMerchantHidden(key, hidden) {
  const set = state.hiddenMerchants;
  if (hidden) set.add(key); else set.delete(key);
  try {
    await (hidden ? db.hideMerchant(key) : db.unhideMerchant(key));
  } catch (err) {
    if (hidden) set.delete(key); else set.add(key);
    showToast(`Couldn't ${hidden ? 'hide' : 'unhide'} that store: ${errorMessage(err)}`);
  }
}

// For Settings → Store suggestions, each list A–Z.
function storeLists() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const stores = [...state.merchants.values()];
  return {
    suggested: stores.filter(m => isSuggested(m, state.hiddenMerchants)).sort(byName),
    hidden: [...state.hiddenMerchants]
      .map(key => state.merchants.get(key) ?? { key, name: key, count: 0, lastUsed: null })
      .sort(byName),
  };
}

// ---------- Payday ----------

function readNotYet() {
  try { return localStorage.getItem(NOT_YET_KEY); } catch { return null; }
}

function writeNotYet(value) {
  try { localStorage.setItem(NOT_YET_KEY, value); } catch { /* private mode: ask again next load */ }
}

// "Not yet" holds for the rest of the day.
const notYetKey = period => `${period.start_date}@${toISO(today())}`;

// The next paycheck to confirm, if it's due (or nearly due) and not put off today.
function pendingPayday() {
  const last = startedRows().at(-1);
  if (!last) return null;
  const period = periodAfter(last);
  const expected = expectedPayday(fromISO(period.start_date));
  const now = today();
  const minDate = addDays(fromISO(last.starts_on), 1);
  if (now < addDays(expected.date, -PAYDAY_ASK_DAYS_EARLY) || now < minDate) return null;
  if (readNotYet() === notYetKey(period)) return null;

  const suggested = now < expected.date ? now : expected.date;
  return { period, expected, minDate, maxDate: now, defaultDate: suggested < minDate ? minDate : suggested };
}

function askAboutPayday() {
  const prompt = pendingPayday();
  if (prompt) openPaydaySheet(prompt);
}

// ---------- Refresh on return ----------
// Phones pause the page in the background, so reload whenever the app comes
// back into view — that's when the other person's changes show up.

const REFRESH_MIN_GAP_MS = 5000;

// Coming back resumes the paused page, so new code would only arrive on a
// full reload. GitHub Pages stamps every file with the deploy time; when the
// stamp changes, reload to pick up the update. (The local server sends no
// stamp, so this never fires there.)
async function fetchDeployStamp() {
  try {
    const res = await fetch('./', { method: 'HEAD', cache: 'no-store' });
    return res.headers.get('last-modified') || res.headers.get('etag');
  } catch {
    return null; // offline
  }
}
let deployStamp = null;
fetchDeployStamp().then(stamp => { deployStamp = stamp; });

async function refreshOnReturn() {
  if (!state.budget || Date.now() - lastLoadedAt < REFRESH_MIN_GAP_MS) return;
  if (document.querySelector('.sheet-backdrop.open')) return; // don't disturb a sheet in progress
  lastLoadedAt = Date.now();

  const stamp = await fetchDeployStamp();
  if (stamp && deployStamp && stamp !== deployStamp) {
    window.location.reload();
    return;
  }

  // Someone may have started a new period (or the date moved on); follow
  // along if we were looking at the current one.
  const wasCurrent = samePeriod(state.period, currentPeriod());
  try {
    state.info = await db.loadHouseholdInfo() ?? state.info;
    setRounding(state.info.round_whole);
    state.payPeriods = await db.loadPayPeriods();
  } catch {
    return; // offline; try again next time
  }
  if (wasCurrent) state.period = currentPeriod();
  await loadAll({ quiet: true });
  loadMerchants();
  askAboutPayday();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnReturn();
});
window.addEventListener('focus', refreshOnReturn);
window.addEventListener('pageshow', e => { if (e.persisted) refreshOnReturn(); });

// ---------- Navigation ----------

function goToPeriod(period) {
  if (!period) return;
  state.period = period;
  loadAll();
}

document.getElementById('prevPeriod').addEventListener('click', () => goToPeriod(periodBefore(state.period)));
document.getElementById('nextPeriod').addEventListener('click', () => goToPeriod(periodAfter(state.period)));
periodLabelEl.addEventListener('click', () => goToPeriod(currentPeriod()));
periodLabelEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToPeriod(currentPeriod()); }
});

// The header shows the tab's name. Insights spans many periods, so it has no period bar.
const SCREEN_TITLES = { overview: 'Cadence', bills: 'Bills', insights: 'Insights', summary: 'Summary' };
const headerEl = document.getElementById('appHeader');
const screenTitleEl = document.getElementById('screenTitle');

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activeScreen = tab.dataset.screen;
    screenTitleEl.textContent = SCREEN_TITLES[state.activeScreen];
    headerEl.classList.toggle('no-period', state.activeScreen === 'insights');
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === `screen-${state.activeScreen}`);
    });
    if (state.activeScreen === 'insights' && state.budget) renderInsights();
    showFab();
  });
});

// The + button tucks away while scrolling down (so it doesn't cover the last
// rows) and comes back on scrolling up or near the top.
const fabEl = document.getElementById('openExpense');
const showFab = () => fabEl.classList.remove('tucked');
let lastScrollY = 0;
document.addEventListener('scroll', e => {
  const t = e.target;
  if (t !== document && t !== document.body && t !== document.documentElement) return; // lists, sheets
  const y = Math.max(window.scrollY, document.body.scrollTop, document.documentElement.scrollTop);
  if (y < 40 || y < lastScrollY - 4) showFab();
  else if (y > lastScrollY + 4) fabEl.classList.add('tucked');
  if (Math.abs(y - lastScrollY) > 4) lastScrollY = y;
}, { capture: true, passive: true });

// ---------- Screens & sheets ----------

initOverview({
  onEditExpense: expense => openExpenseSheet(expense),
  onEmpty: async (categoryIds, emptied) => {
    try {
      await db.setCategoryEmptied(state.periodRow.id, categoryIds, emptied);
      await loadAll();
    } catch (err) {
      showToast(`Couldn't move the money: ${errorMessage(err)}`);
    }
  },
});

initBills({
  onTogglePaid: async (id, isPaid) => {
    const bill = state.fixedCosts.find(f => f.id === id);
    if (!bill) return;
    bill.is_paid = isPaid; // optimistic
    renderBills(state.fixedCosts);
    try {
      await db.setFixedPaid(id, isPaid);
    } catch (err) {
      bill.is_paid = !isPaid;
      renderBills(state.fixedCosts);
      showToast(`Couldn't update ${bill.name}: ${errorMessage(err)}`);
    }
  },
});

initInsights({
  get: () => ({
    payPeriods: state.payPeriods,
    categories: state.categories,
    extraCategory: state.extraCategory,
    currentStartISO: currentPeriod().start_date,
    carryStart: state.info.carry_start ?? state.payPeriods[0]?.start_date ?? null,
    periodLabel: row => periodRangeLabel(row),
  }),
});

initExpenseSheet({
  // Extra first: it's what most expenses go to, so new expenses default to it.
  getCategoryChoices: () => [
    ...state.budget.cards.filter(c => c.isExtra),
    ...state.budget.cards.filter(c => !c.isExtra),
  ].map(c => ({ id: c.id, name: c.name })),
  categoryIdOf: expense => state.budget.bucketOf(expense),
  getCards: activeCards,
  cardById,
  suggestMerchants: (typed, categoryId) =>
    suggestMerchants(state.merchants, typed, categoryId, state.hiddenMerchants),
  onHideMerchant: key => setMerchantHidden(key, true),
  suggestCategory,
  onSave: async ({ id, ...fields }) => {
    if (id != null) await db.updateExpense(id, fields);
    else await db.addExpense({ ...fields, period_id: state.periodRow.id });
    await loadAll();
    loadMerchants();
  },
  onDelete: async id => {
    await db.deleteExpense(id);
    await loadAll();
    loadMerchants();
  },
});

initSettingsSheet({
  getSnapshot: () => {
    const expenseCountByCategory = new Map();
    for (const e of state.expenses) {
      const id = state.budget.bucketOf(e);
      expenseCountByCategory.set(id, (expenseCountByCategory.get(id) ?? 0) + 1);
    }
    const todayStartISO = currentPeriod().start_date;
    const isPast = state.period.start_date < todayStartISO;
    return {
      period: state.periodRow,
      label: periodRangeLabel(state.period),
      isPast,
      todayStartISO,
      startsOn: state.periodRow.starts_on ?? null,
      starting: state.periodRow.starting,
      carryIn: state.carryIn,
      extraName: state.extraCategory.name,
      categories: state.budget.cards.filter(c => !c.isExtra),
      bills: isPast ? state.fixedCosts : billTemplates,
      expenseCountByCategory,
    };
  },
  onSave: async (startsOn, args) => {
    if (startsOn) await db.startPeriod(state.periodRow.id, startsOn);
    await db.saveSettings(args);
    billTemplates = await db.loadBillTemplates();
    await loadAll();
  },
});

// Recurring bills, for Settings on a current or future period.
let billTemplates = [];

async function openSettings() {
  try {
    billTemplates = await db.loadBillTemplates();
  } catch (err) {
    showToast(`Couldn't load your bills: ${errorMessage(err)}`);
    return;
  }
  openSettingsSheet();
}

initPaydaySheet({
  onStart: async (period, startsOnISO) => {
    const row = await db.ensurePeriod(period.start_date, period.next_start);
    await db.startPeriod(row.id, startsOnISO);
    state.payPeriods = await db.loadPayPeriods();
    state.period = currentPeriod();
    await loadAll();
    setTimeout(askAboutPayday, 400); // another paycheck may be waiting if the app sat unopened
  },
  onNotYet: period => writeNotYet(notYetKey(period)),
});

document.getElementById('openExpense').addEventListener('click', () => {
  if (state.budget) openExpenseSheet();
});
document.getElementById('openSettings').addEventListener('click', () => {
  if (state.budget) openSettings();
});

initAppearance();

initStoresSheet({
  getStores: storeLists,
  onHide: key => setMerchantHidden(key, true),
  onUnhide: key => setMerchantHidden(key, false),
});

// ---------- Settings: cards, pay schedule, rounding ----------

initCardSheet({
  onSave: async card => {
    // New cards go last (state.cards is still empty during setup, so ask).
    await db.saveCard(card.id ? card : { ...card, sort_order: (await db.loadCards()).length + 1 });
    await afterCardsChange();
  },
  onArchive: async id => {
    await db.setCardActive(id, false);
    await afterCardsChange();
  },
});

async function afterCardsChange() {
  state.cards = await db.loadCards();
  if (state.budget) render();
  await refreshOnboardingCards();
}

document.getElementById('cardList').addEventListener('click', e => {
  const row = e.target.closest('[data-card]');
  if (row) openCardSheet(cardById(Number(row.dataset.card)));
});
document.getElementById('addCard').addEventListener('click', () => openCardSheet(null));

const scheduleBackdrop = document.getElementById('scheduleBackdrop');
const scheduleError = document.getElementById('scheduleError');
let scheduleFields = null;
wireSheet(scheduleBackdrop);

document.getElementById('openSchedule').addEventListener('click', () => {
  scheduleFields = scheduleForm(document.getElementById('scheduleFields'), schedule());
  const current = currentPeriod();
  document.getElementById('scheduleNote').textContent =
    `${periodRangeLabel(current)} keeps its start date; it ends the day before your next payday on the new schedule, and later periods follow it.`;
  showFormError(scheduleError, '');
  openSheet(scheduleBackdrop);
});

document.getElementById('scheduleForm').addEventListener('submit', async e => {
  e.preventDefault();
  const button = document.getElementById('scheduleSubmit');
  button.disabled = true;
  try {
    const next = scheduleFields.read();
    const current = currentPeriod();
    const nextStart = nextPayday(next, fromISO(current.start_date));
    await db.setPaySchedule(next, current.id, toISO(nextStart));
    state.info = await db.loadHouseholdInfo();
    state.payPeriods = await db.loadPayPeriods();
    state.period = currentPeriod();
    closeSheet(scheduleBackdrop);
    await loadAll();
    showToast(`Pay schedule saved: ${describeSchedule(next)}.`, { ok: true });
  } catch (err) {
    showFormError(scheduleError, typeof err === 'string' ? err : errorMessage(err));
  } finally {
    button.disabled = false;
  }
});

document.getElementById('roundingSwitch').addEventListener('click', async () => {
  const on = !state.info.round_whole;
  try {
    await db.updateHousehold({ roundWhole: on });
    state.info.round_whole = on;
    setRounding(on);
    render();
  } catch (err) {
    showToast(`Couldn't change rounding: ${errorMessage(err)}`);
  }
});

// ---------- Household & account ----------

initHousehold({
  onChangePassword: async password => {
    await auth.changePassword(password);
    showToast('Password changed.', { ok: true });
  },
  onSignOut: signOut,
  onDeleteAccount: async () => {
    await db.deleteMyAccount();
    await auth.signOut().catch(() => {});
    window.location.reload();
  },
  onCreateJoinCode: () => db.createJoinCode(),
  onCreateHouseholdCode: () => db.createHouseholdCode(),
  householdName: () => state.info?.name ?? 'our household',
});

initSignIn({
  onSignIn: async (email, password) => {
    const session = await auth.signIn(email, password);
    await enterApp(session);
  },
  onSignUp: async (email, password, code) => {
    const session = await auth.signUp(email, password, code);
    if (session) await enterApp(session);
    return session;
  },
  checkInvite: code => db.checkInvite(code),
  onForgot: email => auth.sendPasswordReset(email),
});

// ---------- Signing in and out ----------

async function signOut() {
  try {
    await auth.signOut();
  } catch (err) {
    showToast(`Couldn't sign out: ${errorMessage(err)}`);
  }
}

// However the session ended, start over from a clean page.
auth.onSignedOut(() => window.location.reload());
auth.onPasswordRecovery(() => openPasswordSheet({ recovery: true }));

// ---------- Start ----------

// No household yet: set one up, or join one, with the code they signed up
// with (or from an invite link) when it's still usable.
async function setUp(session) {
  const code = inviteFromLink() ?? session.user.user_metadata?.invite_code ?? null;
  clearInviteLink();
  hideGate();
  const kind = await codeKind(code);
  if (kind === 'join') await startJoin({ code });
  else await startOnboarding({ info: null, code: kind === 'household' ? code : null });
}

async function enterApp(session) {
  state.email = session.user.email;
  let info = null;
  try {
    info = await db.loadHouseholdInfo();
  } catch (err) {
    showToast(`Couldn't load your household: ${errorMessage(err)}`);
    return;
  }
  if (!info) {
    await setUp(session);
    info = await db.loadHouseholdInfo();
  } else if (!info.setup_done && info.role === 'owner') {
    hideGate();
    await startOnboarding({ info, code: null });
    info = await db.loadHouseholdInfo();
  }
  clearInviteLink();
  if (!info) return;

  state.info = info;
  setRounding(info.round_whole);
  renderHousehold(info, state.email);
  state.authorColors = new Map((info.members ?? []).map(m => [m.user_id, m.color]));
  hideGate();

  try {
    state.payPeriods = await db.loadPayPeriods();
  } catch (err) {
    showToast(`Couldn't load pay periods: ${errorMessage(err)}`);
  }
  if (!state.payPeriods.length) {
    showToast('Your household’s owner hasn’t finished setting up yet. Check back soon.');
    return;
  }
  state.period = currentPeriod();
  await loadAll();
  loadMerchants();
  askAboutPayday();
}

(async function start() {
  let session = null;
  try {
    session = await auth.getSession();
  } catch (err) {
    showToast(`Couldn't check your sign-in: ${errorMessage(err)}`);
  }
  if (session) await enterApp(session);
  else showSignIn();
})();
