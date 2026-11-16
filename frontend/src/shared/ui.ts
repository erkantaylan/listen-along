// UI utilities, view management, and helper functions
import { elements, state, viewActivators, dashboardInterval, playlistsInterval, setDashboardInterval, setPlaylistsInterval } from './state.ts';
import { maybeById } from './dom.ts';

export function showView(viewName: string): void {
  if (elements.loginView) elements.loginView.classList.remove('active');
  elements.landingView.classList.remove('active');
  elements.playlistView.classList.remove('active');
  if (elements.radioView) elements.radioView.classList.remove('active');
  if (elements.artistsView) elements.artistsView.classList.remove('active');
  if (elements.artistView) elements.artistView.classList.remove('active');
  if (elements.searchView) elements.searchView.classList.remove('active');
  if (elements.appView) elements.appView.classList.remove('active');
  if (elements.dashboardView) elements.dashboardView.classList.remove('active');
  if (elements.pendingView) elements.pendingView.classList.remove('active');
  if (elements.profileView) elements.profileView.classList.remove('active');

  if (dashboardInterval) { clearInterval(dashboardInterval); setDashboardInterval(null); }
  if (playlistsInterval) { clearInterval(playlistsInterval); setPlaylistsInterval(null); }

  switch (viewName) {
    case 'login':
      if (elements.loginView) elements.loginView.classList.add('active');
      break;
    case 'landing':
      elements.landingView.classList.add('active');
      break;
    case 'playlist':
      elements.playlistView.classList.add('active');
      break;
    case 'radio':
      if (elements.radioView) elements.radioView.classList.add('active');
      break;
    case 'artists':
      if (elements.artistsView) elements.artistsView.classList.add('active');
      break;
    case 'artist':
      if (elements.artistView) elements.artistView.classList.add('active');
      break;
    case 'search':
      if (elements.searchView) elements.searchView.classList.add('active');
      break;
    case 'app':
      if (elements.appView) elements.appView.classList.add('active');
      break;
    case 'profile':
      if (elements.profileView) elements.profileView.classList.add('active');
      break;
    case 'dashboard':
      if (elements.dashboardView) elements.dashboardView.classList.add('active');
      break;
    case 'pending':
      if (elements.pendingView) elements.pendingView.classList.add('active');
      break;
  }

  // Call view-specific activator if registered
  const activator = viewActivators[viewName];
  if (activator) activator();
  notifyViewChange();
}

// Tells listeners (the player bar) that the visible page changed: a view
// switch, or the library overlay opening/closing.
export function notifyViewChange(): void {
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

// In-app navigation: add a history entry and let the router (app.ts, which
// listens to popstate) make the UI match it, as Back/Forward do.
export function navigateTo(path: string): void {
  if (window.location.pathname + window.location.search !== path) window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

// Bootstrap toast in #toast-container. type: info | success | error.
export type ToastType = 'info' | 'success' | 'error';
const TOAST_THEMES: Record<string, string> = { success: 'theme-success', error: 'theme-danger', info: 'theme-secondary' };
// options.action = { label, onClick }: a text button in the toast (e.g. Undo);
// options.duration in ms (default 3000).
export interface ToastOptions {
  action?: { label: string; onClick: () => void } | null;
  duration?: number;
}
export function showToast(message: string, type: ToastType = 'info', { action = null, duration = 3000 }: ToastOptions = {}): void {
  const toast = document.createElement('div');
  toast.className = `toast show ${TOAST_THEMES[type] || TOAST_THEMES.info} app-toast app-toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = message;
  toast.appendChild(body);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  };
  if (action) {
    body.classList.add('d-flex', 'align-items-center', 'gap-3');
    const text = document.createElement('span');
    text.className = 'flex-grow-1 min-w-0';
    text.textContent = message;
    body.textContent = '';
    body.appendChild(text);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-text theme-primary btn-sm flex-shrink-0 app-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { dismiss(); action.onClick(); });
    body.appendChild(btn);
  }
  elements.toastContainer.appendChild(toast);
  timer = setTimeout(dismiss, duration);
}

// Bootstrap 6 range inputs paint their filled track from --bs-range-fill (0..1).
// User input is handled by the listener below; call this after setting .value
// from code.
export function syncRangeFill(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const fill = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--bs-range-fill', String(Math.min(1, Math.max(0, fill))));
}

// Keep every range's fill in step with user input; called once at start-up.
export function setupRangeFill(): void {
  document.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.matches?.('.form-range-input')) syncRangeFill(target);
  });
  document.querySelectorAll<HTMLInputElement>('.form-range-input').forEach(syncRangeFill);
}

export function t(key: string, fallback: string, replacements: Record<string, string | number> = {}): string {
  if (window.i18n && window.i18n.t) {
    const translation = window.i18n.t(key, replacements);
    return translation === key ? fallback : translation;
  }
  return fallback;
}

export function formatTime(seconds: number | null | undefined): string {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds === 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatAge(timestamp: number): string {
  const age = Date.now() - timestamp;
  const mins = Math.floor(age / 60000);
  const hours = Math.floor(age / 3600000);
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Turkish-safe case-insensitive lowercase (handles İ/ı/I/i correctly)
export function toLower(text: string): string {
  return text.toLocaleLowerCase('tr');
}

// Escapes text for HTML element content AND quoted attribute values.
// Not enough on its own inside a JS string in an inline handler (onclick=...);
// the browser HTML-decodes the attribute before running it. There, use
// escapeHtml(JSON.stringify(value)) and don't wrap it in extra quotes.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
  } catch (e) { return ''; }
  return '';
}

export function getCoverUrl(songId: string | number | null | undefined, thumbnailUrl: string | null | undefined): string {
  // The server only caches a cover for songs that have a thumbnail (YouTube
  // ones); library songs without one (local uploads, migrated cache files)
  // would just 404 on /api/covers, so callers show their placeholder instead.
  if (!thumbnailUrl) return '';
  if (!songId) return sanitizeUrl(thumbnailUrl);
  return `/api/covers/${songId}?fallback=${encodeURIComponent(thumbnailUrl)}`;
}

export function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(() => {
    showToast(t('toast.linkCopied', 'Link copied to clipboard!'), 'success');
  }).catch(() => {
    showToast(t('toast.copyFailed', 'Could not copy link'), 'error');
  });
}

// Keep Tab / Shift+Tab inside a modal. Call from the dialog's keydown handler.
export function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  // Read as inputs: disabled / type / checked / name are undefined on the others, as before.
  const focusable = [...container.querySelectorAll<HTMLInputElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null && !(el.type === 'radio' && !el.checked && container.querySelector(`input[type="radio"][name="${el.name}"]:checked`)));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

export function switchTab(tabName: string | undefined): void {
  elements.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });
  elements.queueTab.classList.toggle('active', tabName === 'queue');
}

// The Language field on the profile page (the only language control).
export function setupLanguageSelector(updateQueue: () => void, updateListeners: () => void): void {
  const selector = maybeById<HTMLSelectElement>('language-selector');
  if (!selector || !window.i18n) return;
  selector.value = window.i18n.getLanguage();
  selector.addEventListener('change', async (e) => {
    await window.i18n.setLanguage((e.target as HTMLSelectElement).value);
    updateQueue();
    updateListeners();
  });
}

// The About row at the bottom of the profile page: its links are plain markup in
// index.html and open a new tab, so the player keeps playing. The version stays
// hidden unless /api/version answers with one.
export function setupAppMeta(): void {
  fetch('/api/version')
    .then((res): Promise<unknown> | null => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || typeof (data as { version?: unknown }).version !== 'string' || !(data as { version: string }).version) return;
      const version = (data as { version: string }).version;
      const el = document.getElementById('profile-about-version');
      if (el) { el.textContent = `v${version}`; el.hidden = false; }
    })
    .catch(() => {});
}
