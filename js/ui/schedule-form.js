// The "When do you get paid?" fields, shared by setup and Settings → Pay
// schedule. Renders into a container; read() returns a pay_schedule object
// (see paydays.js) or throws a message for the person.
import { toISO, today, fromISO } from '../paydays.js';
import { dayOptions } from './rows.js';
import { selectChip } from './dom.js';

const KINDS = [
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Once a month' },
];
const PRESETS = [
  { value: '1,15', label: '1st & 15th' },
  { value: '15,31', label: '15th & last' },
  { value: 'other', label: 'Other' },
];


const chipsHtml = (list, current, cls = 'chip') =>
  list.map(o => `<button type="button" class="${cls}${o.value === current ? ' selected' : ''}" data-value="${o.value}">${o.label}</button>`).join('');

// schedule: the household's current one, or null for a new household.
export function scheduleForm(container, schedule = null) {
  const kind = schedule?.kind ?? 'semimonthly';
  const days = schedule?.kind === 'semimonthly' ? [...schedule.days].sort((a, b) => a - b) : [1, 15];
  const preset = PRESETS.find(p => p.value === days.join(','))?.value ?? 'other';
  const anchor = schedule?.anchor ?? toISO(today());
  const monthDay = schedule?.kind === 'monthly' ? schedule.day : 1;

  container.innerHTML = `
    <div class="field">
      <label>How often</label>
      <div class="kind-grid" data-group="kind">${chipsHtml(KINDS, kind)}</div>
    </div>
    <div class="field" data-for="semimonthly">
      <label>Paydays</label>
      <div class="toggle-row" data-group="preset">${chipsHtml(PRESETS, preset)}</div>
      <div class="day-pair" data-for="other">
        <select class="select" data-day="a" aria-label="First payday">${dayOptions(days[0])}</select>
        <span>&amp;</span>
        <select class="select" data-day="b" aria-label="Second payday">${dayOptions(days[1])}</select>
      </div>
    </div>
    <div class="field" data-for="monthly">
      <label>Payday</label>
      <select class="select" data-day="month" aria-label="Payday">${dayOptions(monthDay)}</select>
    </div>
    <div class="field" data-for="weeks">
      <label>A recent or upcoming payday</label>
      <input type="date" data-anchor value="${anchor}">
    </div>
    <div class="hint schedule-hint">On a weekend or holiday we’ll expect it the business day before. Cadence asks you to confirm each paycheck when it lands.</div>`;

  const group = name => container.querySelector(`[data-group="${name}"]`);
  const selected = name => group(name).querySelector('.selected')?.dataset.value;

  const update = () => {
    const k = selected('kind');
    container.querySelector('[data-for="semimonthly"]').hidden = k !== 'semimonthly';
    container.querySelector('[data-for="other"]').hidden = selected('preset') !== 'other';
    container.querySelector('[data-for="monthly"]').hidden = k !== 'monthly';
    container.querySelector('[data-for="weeks"]').hidden = k !== 'weekly' && k !== 'biweekly';
  };

  container.onclick = e => { // replaced, not added, each time the form is drawn
    const chip = e.target.closest('[data-group] > .chip');
    if (!chip) return;
    selectChip(chip.parentElement, chip);
    update();
  };
  update();

  return {
    read() {
      const k = selected('kind');
      if (k === 'semimonthly') {
        const p = selected('preset');
        const pair = p === 'other'
          ? ['a', 'b'].map(d => Number(container.querySelector(`[data-day="${d}"]`).value))
          : p.split(',').map(Number);
        pair.sort((a, b) => a - b);
        if (pair[0] === pair[1]) throw 'Pick two different paydays.';
        return { kind: k, days: pair };
      }
      if (k === 'monthly') return { kind: k, day: Number(container.querySelector('[data-day="month"]').value) };
      const value = container.querySelector('[data-anchor]').value;
      if (!value) throw 'Pick one of your paydays.';
      return { kind: k, anchor: toISO(fromISO(value)) };
    },
  };
}
