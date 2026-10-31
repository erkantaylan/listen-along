// UI utilities, view management, and helper functions
import { elements, state, viewActivators, dashboardInterval, lobbiesInterval, setDashboardInterval, setLobbiesInterval } from './state.js';

export function showView(viewName) {
  if (elements.loginView) elements.loginView.classList.remove('active');
  elements.landingView.classList.remove('active');
  elements.lobbyView.classList.remove('active');
  if (elements.dashboardView) elements.dashboardView.classList.remove('active');
  if (elements.pendingView) elements.pendingView.classList.remove('active');
  if (elements.profileView) elements.profileView.classList.remove('active');

  if (dashboardInterval) { clearInterval(dashboardInterval); setDashboardInterval(null); }
  if (lobbiesInterval) { clearInterval(lobbiesInterval); setLobbiesInterval(null); }

  switch (viewName) {
    case 'login':
      if (elements.loginView) elements.loginView.classList.add('active');
      break;
    case 'landing':
      elements.landingView.classList.add('active');
      break;
    case 'lobby':
      elements.lobbyView.classList.add('active');
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
export function notifyViewChange() {
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

// In-app navigation: add a history entry and let the router (app.js, which
// listens to popstate) make the UI match it, as Back/Forward do.
export function navigateTo(path) {
  if (window.location.pathname + window.location.search !== path) window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

// Bootstrap toast in #toast-container. type: info | success | error.
const TOAST_THEMES = { success: 'theme-success', error: 'theme-danger', info: 'theme-secondary' };
// options.action = { label, onClick }: a text button in the toast (e.g. Undo);
// options.duration in ms (default 3000).
export function showToast(message, type = 'info', { action = null, duration = 3000 } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast show ${TOAST_THEMES[type] || TOAST_THEMES.info} app-toast app-toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = message;
  toast.appendChild(body);
  let timer = null;
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
export function syncRangeFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const fill = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--bs-range-fill', String(Math.min(1, Math.max(0, fill))));
}

// Keep every range's fill in step with user input; called once at start-up.
export function setupRangeFill() {
  document.addEventListener('input', (e) => {
    if (e.target.matches?.('.form-range-input')) syncRangeFill(e.target);
  });
  document.querySelectorAll('.form-range-input').forEach(syncRangeFill);
}

export function t(key, fallback, replacements = {}) {
  if (window.i18n && window.i18n.t) {
    const translation = window.i18n.t(key, replacements);
    return translation === key ? fallback : translation;
  }
  return fallback;
}

export function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatAge(timestamp) {
  const age = Date.now() - timestamp;
  const mins = Math.floor(age / 60000);
  const hours = Math.floor(age / 3600000);
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

export function formatFileSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Turkish-safe case-insensitive lowercase (handles İ/ı/I/i correctly)
export function toLower(text) {
  return text.toLocaleLowerCase('tr');
}

// Escapes text for HTML element content AND quoted attribute values.
// Not enough on its own inside a JS string in an inline handler (onclick=...);
// the browser HTML-decodes the attribute before running it. There, use
// escapeHtml(JSON.stringify(value)) and don't wrap it in extra quotes.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

export function sanitizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
  } catch (e) { return ''; }
  return '';
}

export function getCoverUrl(songId, thumbnailUrl) {
  // The server only caches a cover for songs that have a thumbnail (YouTube
  // ones); library songs without one (local uploads, migrated cache files)
  // would just 404 on /api/covers, so callers show their placeholder instead.
  if (!thumbnailUrl) return '';
  if (!songId) return sanitizeUrl(thumbnailUrl);
  return `/api/covers/${songId}?fallback=${encodeURIComponent(thumbnailUrl)}`;
}

export function getInitials(name) {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(t('toast.linkCopied', 'Link copied to clipboard!'), 'success');
  }).catch(() => {
    showToast(t('toast.copyFailed', 'Could not copy link'), 'error');
  });
}

// Keep Tab / Shift+Tab inside a modal. Call from the dialog's keydown handler.
export function trapFocus(container, e) {
  if (e.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null && !(el.type === 'radio' && !el.checked && container.querySelector(`input[type="radio"][name="${el.name}"]:checked`)));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

export function switchTab(tabName) {
  elements.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });
  elements.queueTab.classList.toggle('active', tabName === 'queue');
}

export function setupLanguageSelector(updateQueue, updateListeners) {
  const selector = document.getElementById('language-selector');
  if (!selector || !window.i18n) return;
  selector.value = window.i18n.getLanguage();
  selector.addEventListener('change', async (e) => {
    await window.i18n.setLanguage(e.target.value);
    updateQueue();
    updateListeners();
  });
}

const SOURCE_URL = 'https://github.com/erkantaylan/listen-along';
const GITHUB_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>';

// Version + GitHub link in every [data-app-meta] slot (the page navbars and
// the playlist's bottom line). Both open a new tab so the player keeps playing.
// The version stays hidden unless /api/version answers with one.
export function setupAppMeta() {
  const changelog = t('appMeta.changelog', 'Changelog');
  const source = t('appMeta.source', 'Source on GitHub');
  document.querySelectorAll('[data-app-meta]').forEach((slot) => {
    slot.innerHTML = `
      <a class="app-meta-version" href="/changelog" target="_blank" rel="noopener" title="${escapeHtml(changelog)}" data-i18n-title="appMeta.changelog" hidden></a>
      <a class="btn-text theme-secondary btn-icon btn-sm" href="${SOURCE_URL}" target="_blank" rel="noopener" aria-label="${escapeHtml(source)}" title="${escapeHtml(source)}" data-i18n-aria-label="appMeta.source" data-i18n-title="appMeta.source">${GITHUB_ICON}</a>`;
  });
  fetch('/api/version')
    .then(res => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || typeof data.version !== 'string' || !data.version) return;
      document.querySelectorAll('.app-meta-version').forEach((link) => {
        link.textContent = `v${data.version}`;
        link.hidden = false;
      });
    })
    .catch(() => {});
}
