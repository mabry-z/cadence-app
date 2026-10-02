// Sign-in with Supabase Auth. supabase-js keeps the session in localStorage
// and refreshes it on its own, so people stay signed in until they sign out.
import { supabase } from './supabase.js';

const FRIENDLY = {
  'Invalid login credentials': 'That email and password don’t match.',
  'Email not confirmed': 'Confirm your email first: open the link we sent you.',
  'User already registered': 'There’s already an account with this email. Sign in instead.',
};

function authError(error) {
  return new Error(FRIENDLY[error.message] ?? error.message);
}

// Where links in Cadence's emails (confirm, reset password) come back to.
const appUrl = () => window.location.origin + window.location.pathname;

// The saved session, or null when signed out.
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw authError(error);
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
  return data.session;
}

// Invite-only: the database refuses an account without a usable code (see
// hook_before_user_created). Returns the session, or null when the email
// has to be confirmed first.
export async function signUp(email, password, inviteCode) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { invite_code: inviteCode }, emailRedirectTo: appUrl() },
  });
  if (error) throw authError(error);
  return data.session;
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw authError(error);
}

// This device only; the other person's phone stays signed in.
export async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw authError(error);
}

export async function changePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw authError(error);
}

// Signed out here, or the session ended (e.g. the password changed elsewhere).
export function onSignedOut(callback) {
  supabase.auth.onAuthStateChange(event => {
    // Supabase warns against awaiting its own calls inside this callback.
    if (event === 'SIGNED_OUT') setTimeout(callback, 0);
  });
}

// Opened from a "reset your password" email: signed in, and should pick a
// new password now.
export function onPasswordRecovery(callback) {
  supabase.auth.onAuthStateChange(event => {
    if (event === 'PASSWORD_RECOVERY') setTimeout(callback, 0);
  });
}
