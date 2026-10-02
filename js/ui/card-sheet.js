// Add or edit a card/account: name, badge letters, type and colour.
// Used by setup and Settings → Cards & accounts.
import { CARD_COLORS, CARD_KINDS } from '../config.js';
import { esc, errorMessage, showFormError, openSheet, closeSheet, wireSheet, selectChip } from './dom.js';

const backdrop = document.getElementById('cardBackdrop');
const form = document.getElementById('cardForm');
const titleEl = document.getElementById('cardTitle');
const nameInput = document.getElementById('cardName');
const badgeInput = document.getElementById('cardBadge');
const kindChips = document.getElementById('cardKindChips');
const colorsEl = document.getElementById('cardColors');
const previewBadge = document.getElementById('cardPreviewBadge');
const previewName = document.getElementById('cardPreviewName');
const errorEl = document.getElementById('cardError');
const submitBtn = document.getElementById('cardSubmit');
const archiveBtn = document.getElementById('cardArchive');
const archiveHint = document.getElementById('cardArchiveHint');

let ctx;
let editing = null;
let badgeTouched = false;

// "Everyday Debit" → "ED", "Cash" → "CA".
export function badgeFor(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

const selectedColor = () => colorsEl.querySelector('.selected')?.dataset.value ?? CARD_COLORS[0];

function updatePreview() {
  if (!badgeTouched) badgeInput.value = badgeFor(nameInput.value);
  previewBadge.textContent = badgeInput.value.trim() || '••';
  previewBadge.style.background = selectedColor();
  previewName.textContent = nameInput.value.trim() || 'New card';
}

// ctx: { onSave(fields), onArchive(id) }
export function initCardSheet(context) {
  ctx = context;
  wireSheet(backdrop);

  kindChips.innerHTML = CARD_KINDS.map(k => `<button type="button" class="chip" data-value="${k.value}">${k.label}</button>`).join('');
  colorsEl.innerHTML = CARD_COLORS.map(c =>
    `<button type="button" class="swatch" data-value="${c}" style="background:${c};" aria-label="Colour ${c}"></button>`).join('');

  kindChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) selectChip(kindChips, chip);
  });
  colorsEl.addEventListener('click', e => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    colorsEl.querySelectorAll('.swatch').forEach(s => s.classList.toggle('selected', s === swatch));
    updatePreview();
  });
  nameInput.addEventListener('input', updatePreview);
  badgeInput.addEventListener('input', () => {
    badgeTouched = true;
    badgeInput.value = badgeInput.value.toUpperCase();
    updatePreview();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const badge = badgeInput.value.trim() || badgeFor(name);
    if (!name) return showFormError(errorEl, 'Give the card a name.');
    showFormError(errorEl, '');
    submitBtn.disabled = true;
    try {
      await ctx.onSave({
        id: editing?.id ?? null,
        name,
        badge,
        kind: kindChips.querySelector('.selected')?.dataset.value ?? 'other',
        color: selectedColor(),
      });
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't save: ${errorMessage(err)}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  archiveBtn.addEventListener('click', async () => {
    if (!editing) return;
    if (!archiveBtn.dataset.armed) {
      archiveBtn.dataset.armed = 'true';
      archiveBtn.textContent = `Tap again to archive ${editing.name}`;
      return;
    }
    archiveBtn.disabled = true;
    try {
      await ctx.onArchive(editing.id);
      closeSheet(backdrop);
    } catch (err) {
      showFormError(errorEl, `Couldn't archive: ${errorMessage(err)}`);
    } finally {
      archiveBtn.disabled = false;
    }
  });
}

// card: a cards row to edit, or null to add one.
export function openCardSheet(card = null) {
  editing = card;
  badgeTouched = !!card;
  titleEl.textContent = card ? 'Edit card' : 'Add card';
  nameInput.value = card?.name ?? '';
  badgeInput.value = card?.badge ?? '';
  const kind = card?.kind ?? 'debit';
  selectChip(kindChips, kindChips.querySelector(`[data-value="${kind}"]`));
  const color = card?.color ?? CARD_COLORS[0];
  colorsEl.querySelectorAll('.swatch').forEach(s => s.classList.toggle('selected', s.dataset.value === color));
  archiveBtn.hidden = archiveHint.hidden = !card;
  archiveBtn.textContent = 'Archive this card';
  delete archiveBtn.dataset.armed;
  showFormError(errorEl, '');
  updatePreview();
  openSheet(backdrop);
}

// A tappable list of cards (setup and Settings).
export function cardListHtml(cards) {
  const active = cards.filter(c => c.is_active);
  if (!active.length) return '<div class="empty">No cards yet.</div>';
  return active.map(c => `
    <button type="button" class="list-row" data-card="${c.id}">
      <span class="card-badge" style="background:${esc(c.color)};">${esc(c.badge)}</span>
      <span class="grow">${esc(c.name)}<span class="sub">${esc(CARD_KINDS.find(k => k.value === c.kind)?.label ?? '')}</span></span>
      <span class="chev">›</span>
    </button>`).join('');
}
