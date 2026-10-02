// Dates, federal holidays and pay schedules. Pure — no DOM, no Supabase.
//
// A household's pay_schedule is one of:
//   { kind: 'semimonthly', days: [1, 15] }   twice a month (31 = last day)
//   { kind: 'monthly', day: 1 }
//   { kind: 'biweekly', anchor: '2026-10-02' } every 2 weeks from a payday
//   { kind: 'weekly', anchor: '2026-10-02' }
// Scheduled paydays are the "nominal" dates that identify pay periods. When
// one falls on a weekend or a federal holiday the pay is expected the
// business day before.

import { MONTHS_SHORT } from './budget.js';

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- Local calendar dates ----------

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const daysBetween = (a, b) => Math.round((b - a) / 86400000);

// "Fri, Oct 30"
export function shortDay(date) {
  return `${WEEKDAYS_SHORT[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

// "Sep 15–30, 2026" / "Oct 30 – Nov 12, 2026" / "Dec 31, 2026 – Jan 13, 2027"
export function rangeLabel(start, end) {
  const mon = d => MONTHS_SHORT[d.getMonth()];
  if (start.getFullYear() !== end.getFullYear()) {
    return `${mon(start)} ${start.getDate()}, ${start.getFullYear()} – ${mon(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${mon(start)} ${start.getDate()} – ${mon(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getDate() === end.getDate()) return `${mon(start)} ${start.getDate()}, ${start.getFullYear()}`;
  return `${mon(start)} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
}

// "1st", "22nd", "last day"
export function ordinal(day) {
  if (day >= 31) return 'last day';
  const s = (day % 100 >= 11 && day % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');
  return `${day}${s}`;
}

// ---------- Federal holidays ----------

function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0);
  return new Date(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7));
}

// Fixed-date holidays on a Saturday are observed Friday; on a Sunday, Monday.
function observed(date) {
  if (date.getDay() === 6) return addDays(date, -1);
  if (date.getDay() === 0) return addDays(date, 1);
  return date;
}

const holidayCache = new Map();

function holidaysObservedIn(year) {
  if (!holidayCache.has(year)) {
    const list = [
      ["New Year's Day", observed(new Date(year, 0, 1))],
      ['Martin Luther King Jr. Day', nthWeekday(year, 0, 1, 3)],
      ["Washington's Birthday", nthWeekday(year, 1, 1, 3)],
      ['Memorial Day', lastWeekday(year, 4, 1)],
      ['Juneteenth', observed(new Date(year, 5, 19))],
      ['Independence Day', observed(new Date(year, 6, 4))],
      ['Labor Day', nthWeekday(year, 8, 1, 1)],
      ['Columbus Day', nthWeekday(year, 9, 1, 2)],
      ['Veterans Day', observed(new Date(year, 10, 11))],
      ['Thanksgiving', nthWeekday(year, 10, 4, 4)],
      ['Christmas Day', observed(new Date(year, 11, 25))],
    ];
    holidayCache.set(year, new Map(list.map(([name, date]) => [toISO(date), name])));
  }
  return holidayCache.get(year);
}

// Checks the next year too: New Year's Day on a Saturday is observed Dec 31.
export function federalHoliday(date) {
  const iso = toISO(date);
  return holidaysObservedIn(date.getFullYear()).get(iso)
    ?? holidaysObservedIn(date.getFullYear() + 1).get(iso)
    ?? null;
}

function whyNotPayable(date) {
  if (date.getDay() === 6) return 'a Saturday';
  if (date.getDay() === 0) return 'a Sunday';
  return federalHoliday(date);
}

// When the pay for a scheduled payday is expected: { date, nominal, reason }.
// reason explains why it moved ("a Sunday"), or null.
export function expectedPayday(nominal) {
  const reason = whyNotPayable(nominal);
  let date = nominal;
  while (whyNotPayable(date)) date = addDays(date, -1);
  return { date, nominal, reason };
}

// ---------- Pay schedules ----------

const lastDayOf = (year, month) => new Date(year, month + 1, 0).getDate();
const dayIn = (year, month, day) => new Date(year, month, Math.min(day, lastDayOf(year, month)));

// Scheduled paydays in a month (month-based schedules only), earliest first.
function monthPaydays(schedule, year, month) {
  const days = schedule.kind === 'monthly' ? [schedule.day] : schedule.days;
  const dates = [...new Set(days)].map(d => dayIn(year, month, d));
  return [...new Map(dates.map(d => [toISO(d), d])).values()].sort((a, b) => a - b);
}

function stepDays(schedule) {
  return schedule.kind === 'weekly' ? 7 : 14;
}

// The latest scheduled payday on or before `date`.
export function paydayOnOrBefore(schedule, date) {
  if (schedule.kind === 'weekly' || schedule.kind === 'biweekly') {
    const anchor = fromISO(schedule.anchor);
    const step = stepDays(schedule);
    return addDays(anchor, Math.floor(daysBetween(anchor, date) / step) * step);
  }
  const candidates = [
    ...monthPaydays(schedule, date.getFullYear(), date.getMonth() - 1),
    ...monthPaydays(schedule, date.getFullYear(), date.getMonth()),
  ].filter(d => d <= date);
  return candidates.at(-1);
}

// The first scheduled payday after `date`.
export function nextPayday(schedule, date) {
  if (schedule.kind === 'weekly' || schedule.kind === 'biweekly') {
    return addDays(paydayOnOrBefore(schedule, date), stepDays(schedule));
  }
  const candidates = [
    ...monthPaydays(schedule, date.getFullYear(), date.getMonth()),
    ...monthPaydays(schedule, date.getFullYear(), date.getMonth() + 1),
  ].filter(d => d > date);
  return candidates[0];
}

// Whether a bill due on `dueDay` (31 = last day) falls in [startISO, nextISO).
// Same rule as bill_due_dates() in the database.
export function billDueIn(dueDay, startISO, nextISO) {
  const start = fromISO(startISO);
  const next = fromISO(nextISO);
  for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m < next; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const due = dayIn(m.getFullYear(), m.getMonth(), dueDay);
    if (due >= start && due < next) return true;
  }
  return false;
}

// "Twice a month · 1st & 15th", "Every 2 weeks · Fridays", …
export function describeSchedule(schedule) {
  switch (schedule?.kind) {
    case 'semimonthly': {
      const [a, b] = [...schedule.days].sort((x, y) => x - y);
      return `Twice a month · ${ordinal(a)} & ${ordinal(b)}`;
    }
    case 'monthly': return `Once a month · the ${ordinal(schedule.day)}`;
    case 'biweekly': return `Every 2 weeks · ${WEEKDAYS[fromISO(schedule.anchor).getDay()]}s`;
    case 'weekly': return `Every week · ${WEEKDAYS[fromISO(schedule.anchor).getDay()]}s`;
    default: return 'Not set';
  }
}

// Which paycheck a bill due on `dueDay` comes out of, in words, for
// month-based schedules ("bills due the 1st–14th come out of …").
export function billSplitNote(schedule) {
  if (schedule?.kind !== 'semimonthly') return '';
  const [a, b] = [...schedule.days].sort((x, y) => x - y);
  const until = b >= 31 ? 'second-to-last day' : ordinal(b - 1);
  return `Paid on the ${ordinal(a)} & ${ordinal(b)}, so bills due the ${ordinal(a)} to the ${until} come out of one paycheck and the rest out of the other.`;
}
