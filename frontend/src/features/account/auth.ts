// Authentication, registration, and profile management
import { state, elements, socket, auth, STORAGE_KEYS, AVATAR_EMOJIS, storageSet } from '../../shared/state.ts';
import { showView, showToast, navigateTo, t } from '../../shared/ui.ts';
import { announceProfile } from '../social/social.ts';
import { resetPlaybackFailures } from '../../player/playback-failures.ts';
import { setupProfileTokens, loadProfileTokens } from './profile-tokens.ts';
import { setupProfileActivity, loadProfileActivity } from './profile-activity.ts';
import { maybeById } from '../../shared/dom.ts';
import type { AccountStatus, AuthMeResponse, AuthProvidersResponse, LogoutResponse, Profile } from '../../shared/types.ts';

// The logged-in account's status (approved / pending / denied / rejected),
// as the server sees it.
export async function registerUser(): Promise<AccountStatus | 'unregistered'> {
  const data = await checkAuth();
  if (!data.authenticated) return 'unregistered';
  return (data.user && data.user.status) || 'approved';
}

export function setupPendingRetry(): void {
  if (elements.pendingRetryBtn) {
    elements.pendingRetryBtn.addEventListener('click', async () => {
      elements.pendingRetryBtn.disabled = true;
      elements.pendingRetryBtn.textContent = 'Checking...';
      const status = await registerUser();
      if (status === 'approved' || status === 'unregistered') { window.location.reload(); }
      else if (status === 'rejected' || status === 'denied') { showRejectedView(); }
      else {
        showToast('Still waiting for approval', 'info');
        elements.pendingRetryBtn.disabled = false;
        elements.pendingRetryBtn.textContent = 'Check Status';
      }
    });
  }
}

export async function checkAuth(): Promise<AuthMeResponse> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json() as AuthMeResponse;
    auth.checked = true;
    auth.authenticated = data.authenticated;
    auth.user = data.user || null;
    return data;
  } catch {
    auth.checked = true;
    auth.authenticated = false;
    return { authenticated: false };
  }
}

// After signing in, come back to the page that was asked for (/library?q=…).
// The server sends a logged-out visitor to /login?next=<that page>; the SPA
// shown in place (no redirect) uses its own address. The server re-checks it.
function loginNextQuery(): string {
  let next = window.location.pathname + window.location.search;
  if (window.location.pathname === '/login') {
    next = new URLSearchParams(window.location.search).get('next') || '';
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) next = '';
  }
  return !next || next === '/' || next.startsWith('/login') ? '' : `?next=${encodeURIComponent(next)}`;
}

// Why a central sign-in came back to /login (?error=<code>, set by the server;
// only these codes are shown, as fixed sentences).
// [i18n key, fallback sentence, theme class]
const LOGIN_ERRORS: Partial<Record<string, readonly [string, string, string]>> = {
  account_disabled: ['login.error.accountDisabled', 'Your account has been disabled. If you think this is a mistake, contact the administrator.', 'theme-danger'],
  registrations_closed: ['login.error.registrationsClosed', 'Registrations are closed: there is no listen-along account for you, and new ones are not being created right now.', 'theme-warning'],
  signin_failed: ['login.error.failed', 'Sign-in did not work. Please try again.', 'theme-danger'],
  signin_unavailable: ['login.error.unavailable', 'The sign-in service cannot be reached right now. Please try again in a moment.', 'theme-warning'],
  link_conflict: ['login.error.linkConflict', 'Your sign-in could not be linked to an account here. Please contact the administrator.', 'theme-danger'],
};

function showLoginError(): void {
  const el = maybeById('login-error');
  if (!el || window.location.pathname !== '/login') return;
  // No ?error: the key "null", as the plain object lookup always did (no entry).
  const entry = LOGIN_ERRORS[String(new URLSearchParams(window.location.search).get('error'))];
  if (!entry) return;
  const [key, fallback, theme] = entry;
  el.textContent = t(key, fallback);
  el.classList.remove('theme-danger', 'theme-warning');
  el.classList.add(theme);
  el.hidden = false;
  const relabel = () => { el.textContent = t(key, fallback); };
  window.addEventListener('languageChanged', relabel);
}

// The browser leaves for the central login's end-session page when the server
// names one (central login), else the page reloads.
export async function signOut(): Promise<string | null> {
  let redirect: string | null = null;
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    // A 503 answers { error } instead; the redirect is checked below either way.
    const data = await res.json().catch(() => ({})) as Partial<LogoutResponse>;
    if (typeof data.redirect === 'string' && /^(https?:\/\/|\/(?![\/\\]))/.test(data.redirect)) redirect = data.redirect;
  } catch { /* signed out locally anyway */ }
  auth.authenticated = false;
  auth.user = null;
  return redirect;
}

// The login page's one button: the central login, or on a development server
// the dev sign-in (/api/auth/providers says which). If that cannot be asked,
// the central login, which is what production always has.
export async function setupLoginView(): Promise<void> {
  showLoginError();
  let target = '/auth/oidc/login';
  try {
    const res = await fetch('/api/auth/providers');
    const providers = await res.json() as AuthProvidersResponse;
    if (!providers.central && providers.dev) {
      target = '/auth/dev/login';
      const note = maybeById('login-dev-note');
      if (note) note.hidden = false;
    }
  } catch { /* the central login */ }
  const btn = maybeById<HTMLButtonElement>('central-login-btn');
  if (btn) {
    btn.hidden = false;
    btn.addEventListener('click', () => { window.location.href = target + loginNextQuery(); });
  }
  setupLoginLogout();
}

function setupLoginLogout(): void {
  const logoutBtn = maybeById<HTMLButtonElement>('login-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const redirect = await signOut();
      resetPlaybackFailures();
      if (redirect && redirect !== '/') { window.location.href = redirect; return; }
      showLoginCard();
      showView('login');
    });
  }
}

export function showRejectedView(): void {
  showView('pending');
  if (elements.pendingIcon) elements.pendingIcon.textContent = '\u274C';
  if (elements.pendingTitle) elements.pendingTitle.textContent = 'Access Denied';
  if (elements.pendingMessage) elements.pendingMessage.textContent = 'Your account has been rejected by the admin. Contact the administrator for more information.';
  if (elements.pendingRetryBtn) elements.pendingRetryBtn.style.display = 'none';
}

export function showLoginCard(): void {
  const loginCard = document.querySelector<HTMLElement>('.login-card:not(.login-pending)');
  const pendingCard = maybeById('login-pending');
  if (loginCard) loginCard.hidden = false;
  if (pendingCard) pendingCard.hidden = true;
}

export function showPendingCard(): void {
  const loginCard = document.querySelector<HTMLElement>('.login-card:not(.login-pending)');
  const pendingCard = maybeById('login-pending');
  if (loginCard) loginCard.hidden = true;
  if (pendingCard) {
    pendingCard.hidden = false;
    const userInfo = maybeById('pending-user-info');
    if (userInfo && auth.user) {
      userInfo.textContent = '';
      if (auth.user.avatarUrl) {
        const img = document.createElement('img');
        img.src = auth.user.avatarUrl;
        img.alt = '';
        userInfo.appendChild(img);
      }
      const span = document.createElement('span');
      span.textContent = auth.user.name || auth.user.email || 'User';
      userInfo.appendChild(span);
    }
  }
}

export function setupProfilePage(): void {
  const backBtn = maybeById<HTMLButtonElement>('profile-back-btn');
  const profileBtn = maybeById<HTMLButtonElement>('landing-profile-btn');
  const logoutBtn = maybeById<HTMLButtonElement>('profile-logout-btn');

  if (profileBtn) profileBtn.addEventListener('click', () => navigateTo('/profile'));
  if (backBtn) backBtn.addEventListener('click', () => navigateTo('/'));
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const redirect = await signOut();
      if (redirect && redirect !== '/') window.location.href = redirect;
      else window.location.reload();
    });
  }

  const emojiBtn = maybeById<HTMLButtonElement>('profile-page-emoji-btn');
  const emojiPicker = maybeById('profile-page-emoji-picker');
  if (emojiBtn && emojiPicker) {
    emojiBtn.textContent = state.emoji;
    emojiPicker.innerHTML = AVATAR_EMOJIS.map(e =>
      `<button class="btn btn-icon emoji-option${e === state.emoji ? ' selected active' : ''}" type="button" aria-label="Avatar ${e}" data-emoji="${e}">${e}</button>`
    ).join('');
    emojiBtn.addEventListener('click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
    emojiPicker.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.emoji-option');
      if (!btn) return;
      // Every .emoji-option is rendered above with data-emoji.
      const emoji = btn.dataset.emoji as string;
      state.emoji = emoji;
      storageSet(STORAGE_KEYS.EMOJI, emoji);
      emojiBtn.textContent = emoji;
      emojiPicker.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected', 'active'));
      btn.classList.add('selected', 'active');
      emojiPicker.hidden = true;
    });
  }

  setupProfileTokens();
  setupProfileActivity();

  const nameInput = maybeById<HTMLInputElement>('profile-page-name-input');
  const saveBtn = maybeById<HTMLButtonElement>('profile-page-save-btn');
  if (saveBtn && nameInput) {
    saveBtn.addEventListener('click', () => saveProfilePage());
    nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveProfilePage(); });
  }
}

async function saveProfilePage(): Promise<void> {
  const nameInput = maybeById<HTMLInputElement>('profile-page-name-input');
  const newName = nameInput ? nameInput.value.trim() : '';
  if (!newName) return;
  state.username = newName;
  storageSet(STORAGE_KEYS.USERNAME, newName);
  storageSet(STORAGE_KEYS.EMOJI, state.emoji);
  try {
    await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ displayName: newName, emoji: state.emoji })
    });
  } catch { /* ignore */ }
  if (socket) {
    // No lobbyId: the server updates the lobby this socket is listed in.
    socket.emit('user:update', { username: state.username, emoji: state.emoji });
  }
  // The people panel and chat pick the new name up from the server; without a
  // database the server only knows what we tell it.
  announceProfile(state.username, state.emoji);
  showToast('Profile saved', 'success');
}

export async function loadProfilePage(): Promise<void> {
  const nameInput = maybeById<HTMLInputElement>('profile-page-name-input');
  const emojiBtn = maybeById<HTMLButtonElement>('profile-page-emoji-btn');
  if (nameInput) nameInput.value = state.username;
  if (emojiBtn) emojiBtn.textContent = state.emoji;
  loadProfileTokens();
  loadProfileActivity();
  try {
    const res = await fetch('/api/profile', { credentials: 'same-origin' });
    if (res.ok) {
      const profile = await res.json() as Profile;
      if (profile.displayName && nameInput) {
        nameInput.value = profile.displayName;
        state.username = profile.displayName;
        storageSet(STORAGE_KEYS.USERNAME, profile.displayName);
      }
      if (profile.emoji) {
        state.emoji = profile.emoji;
        storageSet(STORAGE_KEYS.EMOJI, profile.emoji);
        if (emojiBtn) emojiBtn.textContent = profile.emoji;
      }
    }
  } catch { /* keeps what this browser had */ }
}
