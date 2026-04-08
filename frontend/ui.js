// UI utilities, view management, and helper functions
import { elements, state, viewActivators, dashboardInterval, lobbiesInterval, setDashboardInterval, setLobbiesInterval } from './state.js';

export function showView(viewName) {
  if (elements.loginView) elements.loginView.classList.remove('active');
  elements.landingView.classList.remove('active');
  elements.lobbyView.classList.remove('active');
  if (elements.soloView) elements.soloView.classList.remove('active');
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
    case 'solo':
      elements.soloView.classList.add('active');
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
}

export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(1rem)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
  if (!songId) return sanitizeUrl(thumbnailUrl);
  const fallback = thumbnailUrl ? encodeURIComponent(thumbnailUrl) : '';
  return `/api/covers/${songId}${fallback ? `?fallback=${fallback}` : ''}`;
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

export function switchTab(tabName) {
  elements.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });
  elements.queueTab.classList.toggle('active', tabName === 'queue');
  if (elements.socialTab) elements.socialTab.classList.toggle('active', tabName === 'social');
  if (tabName === 'social' && elements.chatInput) {
    setTimeout(() => elements.chatInput.focus(), 100);
  }
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

export function fetchVersion() {
  fetch('/api/version')
    .then(res => res.json())
    .then(data => {
      if (data.version && elements.versionDisplay) {
        elements.versionDisplay.textContent = `v${data.version}`;
      }
    })
    .catch(() => {});
}
