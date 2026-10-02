// The full-screen gate shown instead of the app: sign in, create an account
// (invite code needed), forgot password, and "check your email".
import { errorMessage, showFormError } from './dom.js';

const gate = document.getElementById('authGate');
const panels = ['signInForm', 'signUpForm', 'forgotForm', 'checkEmail'].map(id => document.getElementById(id));
const [signInForm, signUpForm, forgotForm] = panels;
const checkEmailText = document.getElementById('checkEmailText');

const $ = id => document.getElementById(id);

function showPanel(id) {
  document.body.classList.add('gated');
  gate.hidden = false;
  for (const p of panels) p.hidden = p.id !== id;
  const first = $(id).querySelector('input');
  if (first && !first.value) first.focus();
}

// The code from an invite link (?invite=K7Q4MX), if the page was opened from one.
export function inviteFromLink() {
  return new URL(window.location.href).searchParams.get('invite');
}

export function clearInviteLink() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('invite')) return;
  url.searchParams.delete('invite');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

// Runs a form's submit with its button disabled and errors shown in place.
function handle(form, errorEl, action) {
  const button = form.querySelector('[type=submit]');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    showFormError(errorEl, '');
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      showFormError(errorEl, typeof err === 'string' ? err : errorMessage(err));
    } finally {
      button.disabled = false;
    }
  });
}

// ctx: { onSignIn(email, password), onSignUp(email, password, code) → session | null,
//        checkInvite(code) → {kind, household_name} | null, onForgot(email) }
export function initSignIn(ctx) {
  gate.addEventListener('click', e => {
    const link = e.target.closest('[data-gate]');
    if (link) showPanel(link.dataset.gate);
  });

  handle(signInForm, $('signInError'), async () => {
    const email = $('signInEmail').value.trim();
    const password = $('signInPassword').value;
    if (!email || !password) throw 'Enter your email and password.';
    await ctx.onSignIn(email, password);
    $('signInPassword').value = '';
  });

  handle(signUpForm, $('signUpError'), async () => {
    const code = $('signUpCode').value.trim();
    const email = $('signUpEmail').value.trim();
    const password = $('signUpPassword').value;
    if (!code) throw 'Enter your invite code.';
    if (!email) throw 'Enter your email.';
    if (password.length < 8) throw 'Use a password of at least 8 characters.';
    const invite = await ctx.checkInvite(code);
    if (!invite) throw 'That invite code isn’t valid (it may have been used or expired). Ask for a new one.';
    const session = await ctx.onSignUp(email, password, code);
    $('signUpPassword').value = '';
    if (!session) {
      checkEmailText.textContent = `We sent a link to ${email}. Open it on this phone to finish creating your account.`;
      showPanel('checkEmail');
    }
  });

  handle(forgotForm, $('forgotError'), async () => {
    const email = $('forgotEmail').value.trim();
    if (!email) throw 'Enter your email.';
    await ctx.onForgot(email);
    checkEmailText.textContent = `If there’s an account for ${email}, we sent it a link to choose a new password.`;
    showPanel('checkEmail');
  });

  // Typing the code: show who it's for.
  const codeInput = $('signUpCode');
  const codeHint = $('signUpCodeHint');
  const defaultHint = codeHint.textContent;
  let checkTimer;
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
    clearTimeout(checkTimer);
    const code = codeInput.value.replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { codeHint.textContent = defaultHint; return; }
    checkTimer = setTimeout(async () => {
      const invite = await ctx.checkInvite(code).catch(() => null);
      codeHint.textContent = !invite ? 'That code isn’t valid. Check it, or ask for a new one.'
        : invite.kind === 'join' ? `You’ll join ${invite.household_name}.`
        : 'You’ll start your own household.';
    }, 300);
  });
}

// Sign-up first when opened from an invite link.
export function showSignIn() {
  const code = inviteFromLink();
  if (code) {
    $('signUpCode').value = code.toUpperCase();
    $('signUpCode').dispatchEvent(new Event('input'));
    showPanel('signUpForm');
  } else {
    showPanel('signInForm');
  }
}

export function hideGate() {
  gate.hidden = true;
  document.body.classList.remove('gated');
}
