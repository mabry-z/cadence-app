// First launch: name the household, pay schedule, cards, categories,
// bills, invite a partner, put Cadence on the home screen. A partner with a
// join code gets the short version: join, then home screen.
//
// Everything is saved as each step is finished, so a closed app picks up
// where it left off (household_info().setup_done marks the end).
import * as db from '../data.js';
import { CATEGORY_SUGGESTIONS, CARD_PRESETS } from '../config.js';
import { money, parseMoney, moneyInput, setRounding, roundsToWholeDollars, sum } from '../budget.js';
import {
  today, toISO, fromISO, paydayOnOrBefore, nextPayday, expectedPayday, billSplitNote,
} from '../paydays.js';
import { esc, errorMessage, showFormError } from './dom.js';
import { scheduleForm } from './schedule-form.js';
import { makeRow, readRows } from './rows.js';
import { cardListHtml, openCardSheet } from './card-sheet.js';
import { nextColor } from './settings-sheet.js';
import { spacedCode, shareInvite, copyCode } from './household.js';

const root = document.getElementById('onboarding');
const STEPS = 7;

let state; // { step, info, code, done(), cards, schedule }
let form = null; // the step's schedule form, when it has one

// Android offers its own install prompt; keep it for the home screen step.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
});

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);
const isPhone = () => isIOS() || isAndroid();

// ---------- Shell ----------

function dots(step) {
  return `<div class="ob-dots" aria-label="Step ${step} of ${STEPS}">`
    + Array.from({ length: STEPS }, (_, i) => `<i${i + 1 === step ? ' class="on"' : ''}></i>`).join('') + '</div>';
}

function page({ step = null, back = true, title, lead, body, foot }) {
  return `<div class="ob-page">
    <div class="ob-top">
      ${back ? '<button type="button" class="ob-back" data-action="back" aria-label="Back">‹</button>' : '<span class="ob-spacer"></span>'}
      ${step ? dots(step) : '<span></span>'}
      <span class="ob-spacer"></span>
    </div>
    <h1 class="ob-title">${title}</h1>
    ${lead ? `<p class="ob-lead">${lead}</p>` : ''}
    <div class="ob-body">${body}</div>
    <div class="form-error" id="obError" hidden></div>
    <div class="ob-foot">${foot}</div>
  </div>`;
}

const primary = (label, action = 'next') => `<button type="button" class="save-btn" data-action="${action}">${label}</button>`;
const secondary = (label, action) => `<button type="button" class="link-btn" data-action="${action}">${label}</button>`;

function showError(message) {
  showFormError(root.querySelector('#obError'), message);
}

// Runs a step's save with its buttons disabled; errors show on the page.
async function busy(action) {
  const buttons = root.querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    showError('');
    await action();
  } catch (err) {
    showError(typeof err === 'string' ? err : errorMessage(err));
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

// ---------- Steps ----------

const STEP_VIEWS = {
  household() {
    const needCode = !state.code;
    return page({
      step: 1, back: false,
      title: 'Name your household',
      lead: 'This is the budget you’ll share. You can invite a partner at the end, or keep it to yourself.',
      body: `
        <div class="field"><label for="obName">Household name</label>
          <input type="text" id="obName" maxlength="60" placeholder="e.g. The Rivera Household"></div>
        <div class="field"><label for="obMe">Your first name</label>
          <input type="text" id="obMe" maxlength="40" placeholder="e.g. Sam">
          <div class="hint">Shown next to the purchases you add, so you can tell who bought what.</div></div>
        ${needCode ? `<div class="field"><label for="obCode">Invite code</label>
          <input type="text" id="obCode" maxlength="8" autocapitalize="characters" autocomplete="off" placeholder="6 letters and numbers">
          <div class="hint">The code you were given to start a household.</div></div>` : ''}`,
      foot: primary('Continue') + secondary('Joining someone else’s budget? Enter an invite code', 'join'),
    });
  },

  pay() {
    return page({
      step: 2, back: false,
      title: 'When do you get paid?',
      lead: 'Cadence budgets one paycheck at a time.',
      body: `<div id="obSchedule"></div>
        <div class="field" style="margin-top:16px;"><label for="obPay">Take-home pay per paycheck</label>
          <div class="amount-field"><span>$</span><input type="text" id="obPay" inputmode="decimal" placeholder="2,400"
            value="${state.info?.starting_cents ? moneyInput(state.info.starting_cents) : ''}"></div>
          <div class="hint">What lands in your account. You can change it any period.</div></div>
        <div class="list-card switch-card">
          <div class="grow"><div class="switch-title">Round to whole dollars</div><div class="hint">$42.50 becomes $43, $42.49 becomes $42.</div></div>
          <button type="button" class="switch" id="obRound" role="switch" aria-checked="${roundsToWholeDollars()}" aria-label="Round to whole dollars"></button>
        </div>`,
      foot: primary('Continue'),
    });
  },

  cards() {
    const names = new Set(state.cards.filter(c => c.is_active).map(c => c.name.toLowerCase()));
    const presets = CARD_PRESETS.filter(p => !names.has(p.name.toLowerCase()));
    return page({
      step: 3,
      title: 'How do you pay?',
      lead: 'Add the cards and accounts you spend from. Cadence shows how much went on each one.',
      body: `<div class="list-card" id="obCards">${cardListHtml(state.cards)}</div>
        <button type="button" class="add-row-btn" data-action="add-card" style="margin-top:10px;">+ Add a card or account</button>
        ${presets.length ? `<div class="field" style="margin-top:18px;"><label>Quick add</label><div class="chips">
          ${presets.map(p => `<button type="button" class="chip ghost-chip" data-preset="${esc(p.name)}">+ ${esc(p.name)}</button>`).join('')}
        </div></div>` : ''}
        <div class="hint">Rename, recolour or archive them any time in Settings.</div>`,
      foot: primary('Continue'),
    });
  },

  categories() {
    const taken = new Set(state.categoryRows.map(c => c.name.toLowerCase()));
    const ideas = CATEGORY_SUGGESTIONS.filter(n => !taken.has(n.toLowerCase())).slice(0, 4);
    return page({
      step: 4,
      title: 'Plan your spending',
      lead: 'How much of each paycheck goes to everyday spending? Change these any time.',
      body: `<div id="obCats"></div>
        <button type="button" class="add-row-btn" data-action="add-cat">+ Add category</button>
        ${ideas.length ? `<div class="chips" style="margin-top:12px;">${ideas.map(n =>
          `<button type="button" class="chip ghost-chip" data-idea="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
        <div class="list-card extra-preview">
          <div class="cat-top"><span class="cat-name-row"><span class="cat-dot" style="background:var(--ok);"></span><span class="cat-name">Extra</span></span>
            <span class="cat-nums"><b id="obExtra"></b> before bills</span></div>
          <div class="hint">Whatever’s left after bills and these categories. Leftover Extra carries into your next paycheck.</div>
        </div>`,
      foot: primary('Continue'),
    });
  },

  bills() {
    const note = billSplitNote(state.schedule);
    return page({
      step: 5,
      title: 'Add your recurring bills',
      lead: 'Each bill comes out of the paycheck its due date falls in. Tick them off as they’re paid.',
      body: `<div class="row-head"><span>Bill</span><span>Amount</span><span>Due</span></div>
        <div id="obBills"></div>
        <button type="button" class="add-row-btn" data-action="add-bill">+ Add a bill</button>
        ${note ? `<div class="ob-note">${esc(note)}</div>` : ''}`,
      foot: primary('Continue') + `<button type="button" class="secondary-btn" data-action="skip">Skip for now</button>`,
    });
  },

  invite() {
    return page({
      step: 6,
      title: 'Budget together',
      lead: 'Send this code to your partner. Once they’ve made an account with it, you’ll both see the same budget.',
      body: `<div class="list-card code-card">
          <div class="field-label">Invite code</div>
          <div class="invite-code big" id="obInviteCode">…</div>
          <div class="hint">Works once, for 7 days.</div>
          <button type="button" class="save-btn" data-action="share">Share invite link</button>
          <button type="button" class="secondary-btn" data-action="copy">Copy code</button>
        </div>
        <div class="hint" style="text-align:center; margin-top:14px;">You can make a new code any time in Settings → Household.</div>`,
      foot: primary('Continue') + secondary('It’s just me for now', 'next'),
    });
  },

  install() {
    const ios = isIOS();
    const share = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>';
    const add = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
    const menu = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v.01"/><path d="M12 12v.01"/><path d="M12 19v.01"/></svg>';
    const stepRow = (n, text, icon = '') => `<div class="install-step"><span class="install-num">${n}</span><span class="grow">${text}${icon ? `<span class="install-icon">${icon}</span>` : ''}</span></div>`;
    const body = ios
      ? `<div class="list-card">
          ${stepRow(1, 'In Safari, tap the Share button at the bottom of the screen', `${share} Share`)}
          ${stepRow(2, 'Scroll down and tap <b>Add to Home Screen</b>', `${add} Add to Home Screen`)}
          ${stepRow(3, 'Tap <b>Add</b>, then open Cadence from your home screen', '<span class="brand-mark home-icon">C</span>')}
        </div>
        <div class="ob-note">On iPhone, the home screen app keeps its own sign-in, so you’ll sign in once more there. Everything you set up is already saved.</div>`
      : `${installPrompt ? `<div class="list-card install-card">
            <span class="brand-mark home-icon big">C</span>
            <div class="switch-title">Install Cadence</div>
            <div class="hint">Adds it to your home screen and app drawer.</div>
            <button type="button" class="save-btn" data-action="install">Install</button>
          </div>
          <div class="section-label">No Install button?</div>` : ''}
        <div class="list-card">
          ${stepRow(1, 'In Chrome, tap the menu (the three dots at the top right)', menu)}
          ${stepRow(2, 'Tap <b>Add to Home screen</b>, then <b>Install</b>')}
        </div>`;
    return page({
      step: state.joined ? null : 7,
      back: !state.joined,
      title: 'Put Cadence on your home screen',
      lead: 'It opens full screen like any other app, and stays signed in.',
      body,
      foot: primary('Done', 'finish') + secondary(ios ? 'Keep using it in Safari' : 'Keep using it in the browser', 'finish'),
    });
  },

  join() {
    return page({
      back: !!state.canGoBack,
      title: 'Join a household',
      lead: 'Enter the code your partner sent you. You’ll see their budget straight away.',
      body: `<div class="field"><label for="obJoinCode">Invite code</label>
          <input type="text" id="obJoinCode" class="code-input" maxlength="8" autocapitalize="characters" autocomplete="off" placeholder="K7Q 4MX" value="${esc(state.code ?? '')}"></div>
        <div id="obJoinWho"></div>
        <div class="field"><label for="obJoinMe">Your first name</label>
          <input type="text" id="obJoinMe" maxlength="40" placeholder="e.g. Alex"></div>`,
      foot: primary('Join household', 'join-now') + secondary('Start my own household instead', 'own'),
    });
  },
};

const ORDER = ['household', 'pay', 'cards', 'categories', 'bills', 'invite', 'install'];

// ---------- Drawing a step ----------

async function show(step) {
  state.step = step;
  if (step === 'install' && (isStandalone() || !isPhone())) return finish();
  if (step === 'cards') state.cards = await db.loadCards().catch(() => []);
  if (step === 'categories') {
    const cats = await db.loadCategories();
    const active = cats.filter(c => c.is_active && !c.is_remainder);
    state.categoryRows = active.length ? active
      : CATEGORY_SUGGESTIONS.slice(0, 3).map(name => ({ id: null, name, amount: null }));
  }
  if (step === 'bills') state.bills = await db.loadBillTemplates();

  root.innerHTML = STEP_VIEWS[step]();
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  form = null;

  if (step === 'household') root.querySelector('#obName').focus();
  if (step === 'pay') {
    form = scheduleForm(root.querySelector('#obSchedule'), state.schedule);
    const round = root.querySelector('#obRound');
    round.classList.toggle('off', !roundsToWholeDollars());
  }
  if (step === 'categories') {
    const list = root.querySelector('#obCats');
    for (const c of state.categoryRows) {
      list.append(makeRow({ name: c.name, amount: c.amount, amountClass: 'cat-amt', data: { color: c.color ?? nextColor(list), ...(c.id ? { id: c.id } : {}) } }));
    }
    updateExtra();
  }
  if (step === 'bills') {
    const list = root.querySelector('#obBills');
    const rows = state.bills.length ? state.bills : [{ id: null, name: '', amount: null, due_day: 1 }];
    for (const b of rows) {
      list.append(makeRow({ name: b.name, amount: b.amount, amountClass: 'fixed-amt', dueDay: b.due_day, data: b.id ? { template: b.id } : {}, placeholder: 'e.g. Rent' }));
    }
  }
  if (step === 'invite') {
    if (!state.info.setup_done) {
      await db.updateHousehold({ setupDone: true }); // from here on, opening the app goes straight in
      state.info.setup_done = true;
    }
    try {
      state.invite = await db.createJoinCode();
      root.querySelector('#obInviteCode').textContent = spacedCode(state.invite.code);
    } catch (err) {
      showError(`Couldn’t make a code: ${errorMessage(err)}`);
    }
  }
  if (step === 'join') {
    const input = root.querySelector('#obJoinCode');
    input.addEventListener('input', () => checkJoinCode(input));
    if (input.value) checkJoinCode(input);
  }
}

function updateExtra() {
  const el = root.querySelector('#obExtra');
  if (!el) return;
  const cats = [...root.querySelectorAll('#obCats .cat-amt')].map(i => parseMoney(i.value) ?? 0);
  el.textContent = money((state.info?.starting_cents ?? 0) - sum(cats, x => x));
}

let joinCheck = 0;
async function checkJoinCode(input) {
  input.value = input.value.toUpperCase();
  const code = input.value.replace(/[^A-Z0-9]/g, '');
  const who = root.querySelector('#obJoinWho');
  const token = ++joinCheck;
  if (code.length !== 6) { who.innerHTML = ''; return; }
  const invite = await db.checkInvite(code).catch(() => null);
  if (token !== joinCheck) return;
  who.innerHTML = invite?.kind === 'join'
    ? `<div class="list-card join-card"><span class="check checked">✓</span><div><div class="hint">You’re joining</div><div class="switch-title">${esc(invite.household_name)}</div></div></div>`
    : `<div class="hint join-bad">${invite ? 'That code is for starting a new household, not joining one.' : 'That code isn’t valid. Check it, or ask for a new one.'}</div>`;
}

// ---------- Saving each step ----------

// The household's latest period, created from the schedule the first time.
async function ensureFirstPeriod(schedule) {
  const periods = await db.loadPayPeriods();
  if (!periods.length) {
    const start = paydayOnOrBefore(schedule, today());
    const next = nextPayday(schedule, start);
    return db.ensurePeriod(toISO(start), toISO(next), toISO(expectedPayday(start).date));
  }
  const last = periods.at(-1);
  const next = nextPayday(schedule, fromISO(last.start_date));
  await db.setPaySchedule(schedule, last.id, toISO(next));
  return last;
}

async function latestPeriod() {
  return (await db.loadPayPeriods()).at(-1);
}

const SAVES = {
  async household() {
    const name = root.querySelector('#obName').value.trim();
    const me = root.querySelector('#obMe').value.trim();
    const code = state.code ?? root.querySelector('#obCode')?.value.trim();
    if (!name) throw 'Give your household a name.';
    if (!me) throw 'Add your first name.';
    await db.createHousehold(name, me, code);
    state.info = await db.loadHouseholdInfo();
  },

  async pay() {
    const schedule = form.read();
    const round = !root.querySelector('#obRound').classList.contains('off');
    setRounding(round);
    const pay = parseMoney(root.querySelector('#obPay').value);
    if (!pay) throw 'Enter your take-home pay per paycheck.';
    await db.updateHousehold({ roundWhole: round, startingCents: pay });
    await db.setPaySchedule(schedule);
    state.schedule = schedule;
    state.info.starting_cents = pay;
    state.info.round_whole = round;
    await ensureFirstPeriod(schedule);
  },

  async cards() {},

  async categories() {
    const rows = readRows(root.querySelector('#obCats'), 'cat-amt', 'category', { blankIsZero: true });
    if (rows.some(r => r.name.toLowerCase() === 'extra')) throw '"Extra" is added for you; pick another name.';
    const period = await latestPeriod();
    const bills = await db.loadBillTemplates();
    await db.saveSettings({
      p_period_id: period.id,
      p_today_start: period.start_date,
      p_starting: state.info.starting_cents,
      p_categories: rows.map(({ row, name, amount }) => ({
        id: row.dataset.id ? Number(row.dataset.id) : null, name, color: row.dataset.color || null, amount,
      })),
      p_fixed: bills.map(b => ({ template_id: b.id, name: b.name, amount: b.amount, due_day: b.due_day })),
    });
  },

  async bills() {
    const rows = readRows(root.querySelector('#obBills'), 'fixed-amt', 'bill', { blankIsZero: true });
    const period = await latestPeriod();
    const cats = (await db.loadCategories()).filter(c => c.is_active && !c.is_remainder);
    await db.saveSettings({
      p_period_id: period.id,
      p_today_start: period.start_date,
      p_starting: state.info.starting_cents,
      p_categories: cats.map(c => ({ id: c.id, name: c.name, color: c.color, amount: c.amount })),
      p_fixed: rows.map(({ row, name, amount, dueDay }) => ({
        template_id: row.dataset.template ? Number(row.dataset.template) : null, name, amount, due_day: dueDay,
      })),
    });
  },

  async invite() {},
};

function finish() {
  root.hidden = true;
  root.innerHTML = '';
  state.done();
}

// ---------- Events ----------

root.addEventListener('click', e => {
  const target = e.target.closest('[data-action], [data-preset], [data-idea], [data-card], .switch');
  if (!target || !state) return;

  if (target.matches('.switch')) {
    target.classList.toggle('off');
    target.setAttribute('aria-checked', String(!target.classList.contains('off')));
    return;
  }
  if (target.dataset.card) {
    openCardSheet(state.cards.find(c => String(c.id) === target.dataset.card));
    return;
  }
  if (target.dataset.preset) {
    const preset = CARD_PRESETS.find(p => p.name === target.dataset.preset);
    busy(async () => {
      await db.saveCard({ ...preset, sort_order: (await db.loadCards()).length + 1 });
      await refreshOnboardingCards();
    });
    return;
  }
  if (target.dataset.idea) {
    const list = root.querySelector('#obCats');
    list.append(makeRow({ name: target.dataset.idea, amountClass: 'cat-amt', data: { color: nextColor(list) } }));
    target.remove();
    list.lastElementChild.querySelector('.cat-amt').focus();
    return;
  }

  const i = ORDER.indexOf(state.step);
  switch (target.dataset.action) {
    case 'next':
      busy(async () => {
        await SAVES[state.step]?.();
        await show(ORDER[i + 1]);
      });
      break;
    case 'skip':
      show(ORDER[i + 1]);
      break;
    case 'back':
      if (state.step === 'join') show('household');
      else if (i > 0) show(ORDER[i - 1]);
      break;
    case 'add-card':
      openCardSheet(null);
      break;
    case 'add-cat': {
      const list = root.querySelector('#obCats');
      list.append(makeRow({ amountClass: 'cat-amt', data: { color: nextColor(list) } }));
      break;
    }
    case 'add-bill':
      root.querySelector('#obBills').append(makeRow({ amountClass: 'fixed-amt', dueDay: 1, placeholder: 'e.g. Rent' }));
      break;
    case 'share':
      if (state.invite) shareInvite(state.invite.code, state.info.name);
      break;
    case 'copy':
      if (state.invite) copyCode(state.invite.code);
      break;
    case 'join':
      state.canGoBack = true;
      show('join');
      break;
    case 'own':
      state.code = null;
      show('household');
      break;
    case 'join-now':
      busy(async () => {
        const code = root.querySelector('#obJoinCode').value.trim();
        const me = root.querySelector('#obJoinMe').value.trim();
        if (!code) throw 'Enter the invite code.';
        if (!me) throw 'Add your first name.';
        await db.joinHousehold(code, me);
        state.joined = true;
        await show('install');
      });
      break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.finally(() => { installPrompt = null; finish(); });
      }
      break;
    case 'finish':
      finish();
      break;
  }
});

root.addEventListener('input', e => {
  if (e.target.matches('#obCats .cat-amt')) updateExtra();
});
root.addEventListener('click', e => {
  const remove = e.target.closest('.remove-btn');
  if (!remove) return;
  remove.closest('.fixed-row').remove();
  updateExtra();
});

// After the card sheet saves (it's shared with Settings).
export async function refreshOnboardingCards() {
  if (!state || state.step !== 'cards' || root.hidden) return;
  await show('cards');
}

// Starts setup. info: household_info() or null; code: the invite code they
// signed up with (if still unused). Resolves when they reach the app.
export function startOnboarding({ info, code }) {
  return new Promise(resolve => {
    state = {
      info, code, done: resolve, cards: [], schedule: info?.pay_schedule ?? null,
      joined: false, canGoBack: false,
    };
    if (info) setRounding(info.round_whole);
    document.body.classList.add('gated');
    root.hidden = false;
    let first = 'household';
    if (info) first = info.role === 'owner' ? 'pay' : 'install';
    if (info?.role === 'member') state.joined = true;
    show(first);
  });
}

// Which flow a code starts: 'join' | 'household' | null (unusable).
export async function codeKind(code) {
  if (!code) return null;
  const invite = await db.checkInvite(code).catch(() => null);
  return invite?.kind ?? null;
}

export function startJoin({ code }) {
  return new Promise(resolve => {
    state = { info: null, code, done: resolve, cards: [], schedule: null, joined: false, canGoBack: false };
    document.body.classList.add('gated');
    root.hidden = false;
    show('join');
  });
}
