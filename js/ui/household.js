// Settings → Household and Account: who's in it, invite codes, change
// password, sign out, delete account.
import { esc, errorMessage, showFormError, showToast, openSheet, closeSheet, wireSheet } from './dom.js';

const infoEl = document.getElementById('householdInfo');
const inviteBox = document.getElementById('inviteBox');
const adminBox = document.getElementById('adminBox');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const openPasswordBtn = document.getElementById('openPassword');
const signOutBtn = document.getElementById('signOutBtn');
const deleteBtn = document.getElementById('deleteAccountBtn');
const deleteHint = document.getElementById('deleteAccountHint');

const passwordBackdrop = document.getElementById('passwordBackdrop');
const passwordForm = document.getElementById('passwordForm');
const passwordTitle = document.getElementById('passwordTitle');
const usernameInput = document.getElementById('passwordUsername');
const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');
const passwordError = document.getElementById('passwordError');
const passwordSubmit = document.getElementById('passwordSubmit');

const MIN_PASSWORD = 8;
const ROLE_LABELS = { owner: 'Owner', member: 'Member' };

let signedInEmail = '';

// "K7Q 4MX"
export const spacedCode = code => `${code.slice(0, 3)} ${code.slice(3)}`;

// A link that opens Cadence's sign-up with the code filled in.
export const inviteLink = code => `${window.location.origin}${window.location.pathname}?invite=${code}`;

// Shares the code with the phone's share sheet, or copies it.
export async function shareInvite(code, householdName) {
  const text = `Join ${householdName} on Cadence. Your invite code is ${spacedCode(code)}.`;
  const url = inviteLink(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Cadence invite', text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    showToast('Invite copied. Paste it into a message.', { ok: true });
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Couldn’t share. Copy the code instead.');
  }
}

export async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    showToast(`Copied ${spacedCode(code)}.`, { ok: true });
  } catch {
    showToast(`Your code is ${spacedCode(code)}.`, { ok: true });
  }
}

function codeCardHtml({ code, expires_at }, note) {
  const days = Math.max(1, Math.round((new Date(expires_at) - Date.now()) / 86400000));
  return `<div class="code-card">
    <div class="invite-code">${esc(spacedCode(code))}</div>
    <div class="hint">${esc(note)} Works once, for ${days} more day${days === 1 ? '' : 's'}.</div>
    <div class="toggle-row" style="margin-top:12px;">
      <button type="button" class="chip" data-share="${esc(code)}">Share</button>
      <button type="button" class="chip" data-copy="${esc(code)}">Copy code</button>
    </div>
  </div>`;
}

// ctx: { onChangePassword(password), onSignOut(), onDeleteAccount(),
//        onCreateJoinCode() → {code, expires_at}, onCreateHouseholdCode() → {code, expires_at},
//        householdName() }
export function initHousehold(ctx) {
  wireSheet(passwordBackdrop);

  openPasswordBtn.addEventListener('click', () => {
    closeSheet(settingsBackdrop);
    openPasswordSheet();
  });

  passwordForm.addEventListener('submit', async e => {
    e.preventDefault();
    const password = newPasswordInput.value;
    if (password.length < MIN_PASSWORD) {
      return showFormError(passwordError, `Use at least ${MIN_PASSWORD} characters.`);
    }
    if (password !== confirmPasswordInput.value) {
      return showFormError(passwordError, 'The two passwords don’t match.');
    }
    showFormError(passwordError, '');
    passwordSubmit.disabled = true;
    try {
      await ctx.onChangePassword(password);
      closeSheet(passwordBackdrop);
    } catch (err) {
      showFormError(passwordError, errorMessage(err));
    } finally {
      passwordSubmit.disabled = false;
    }
  });

  inviteBox.addEventListener('click', async e => {
    if (e.target.closest('[data-invite]')) {
      try {
        inviteBox.innerHTML = codeCardHtml(await ctx.onCreateJoinCode(), 'Send this to your partner. They enter it when they create their account.');
      } catch (err) {
        showToast(`Couldn’t make a code: ${errorMessage(err)}`);
      }
    }
    const share = e.target.closest('[data-share]');
    if (share) shareInvite(share.dataset.share, ctx.householdName());
    const copy = e.target.closest('[data-copy]');
    if (copy) copyCode(copy.dataset.copy);
  });

  adminBox.addEventListener('click', async e => {
    if (e.target.closest('[data-new-household]')) {
      try {
        const code = await ctx.onCreateHouseholdCode();
        adminBox.querySelector('[data-codes]').insertAdjacentHTML('beforeend',
          codeCardHtml(code, 'For someone starting their own budget.'));
      } catch (err) {
        showToast(`Couldn’t make a code: ${errorMessage(err)}`);
      }
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) copyCode(copy.dataset.copy);
    const share = e.target.closest('[data-share]');
    if (share) shareInvite(share.dataset.share, 'their own household');
  });

  // Two taps instead of confirm(): some browsers block pop-up dialogs.
  let armedTimer = null;
  signOutBtn.addEventListener('click', () => {
    if (armedTimer) {
      clearTimeout(armedTimer);
      armedTimer = null;
      signOutBtn.disabled = true;
      signOutBtn.textContent = 'Signing out…';
      // On success the page reloads to the sign-in screen; otherwise let them retry.
      Promise.resolve(ctx.onSignOut()).finally(() => {
        signOutBtn.disabled = false;
        signOutBtn.textContent = 'Sign out';
      });
      return;
    }
    signOutBtn.textContent = 'Tap again to sign out';
    armedTimer = setTimeout(() => {
      armedTimer = null;
      signOutBtn.textContent = 'Sign out';
    }, 4000);
  });

  let deleteTimer = null;
  deleteBtn.addEventListener('click', async () => {
    if (!deleteTimer) {
      deleteBtn.textContent = 'Tap again to delete your account for good';
      deleteTimer = setTimeout(() => {
        deleteTimer = null;
        deleteBtn.textContent = 'Delete my account';
      }, 5000);
      return;
    }
    clearTimeout(deleteTimer);
    deleteTimer = null;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      await ctx.onDeleteAccount();
    } catch (err) {
      showToast(`Couldn’t delete your account: ${errorMessage(err)}`);
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete my account';
    }
  });
}

// recovery: opened from a "reset your password" email.
export function openPasswordSheet({ recovery = false } = {}) {
  passwordForm.reset();
  passwordTitle.textContent = recovery ? 'Choose a new password' : 'Change password';
  usernameInput.value = signedInEmail; // lets password managers update the right entry
  showFormError(passwordError, '');
  openSheet(passwordBackdrop);
}

// info: household_info() result, or null.
export function renderHousehold(info, email) {
  signedInEmail = email;
  if (!info) {
    infoEl.innerHTML = `<div class="empty">Couldn’t load your household. Signed in as ${esc(email)}.</div>`;
    inviteBox.innerHTML = adminBox.innerHTML = '';
    return;
  }
  const members = (info.members ?? []).map(m => `
    <div class="member-row">
      <span class="member"><span class="author-dot" style="background:${esc(m.color)};"></span><span>${esc(m.display_name || m.email)}${m.is_me ? ' (you)' : ''}<span class="sub">${esc(m.email)}</span></span></span>
      <span class="role">${ROLE_LABELS[m.role] ?? esc(m.role)}</span>
    </div>`).join('');
  infoEl.innerHTML = `<div class="household-name">${esc(info.name)}</div>${members}`;
  inviteBox.innerHTML = '<button type="button" class="secondary-btn" data-invite>Invite someone</button>';
  adminBox.innerHTML = info.is_admin
    ? `<div class="admin-note">You’re Cadence’s admin. A new-household code lets a friend start their own, separate budget.</div>
       <div data-codes></div>
       <button type="button" class="secondary-btn" data-new-household>Invite a new household</button>`
    : '';
  const alone = (info.members ?? []).length <= 1;
  deleteHint.textContent = alone
    ? 'Removes your login and this household’s whole budget. This can’t be undone.'
    : 'Removes your login. The household and its budget stay with the others.';
}
