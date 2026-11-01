// /app: download the Android app, install it, connect it with a token. The text
// is static (index.html + locales); this fills in the release from
// /api/app/latest. Whatever goes wrong there, the releases link stays.
import { auth, viewActivators } from './state.js';
import { navigateTo, showToast, t } from './ui.js';

const $ = (id) => document.getElementById(id);
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;
const isPending = () => !!(auth.user && auth.user.status === 'pending');

function formatDate(value) {
  const d = new Date(value);
  return value && !isNaN(d) ? d.toLocaleDateString(language(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toLocaleString(language(), { maximumFractionDigits: 1 })} MB`;
}

function showRelease(info) {
  $('app-download-link').href = info.apk.url;
  $('app-release-meta').textContent = [
    `v${info.version}`,
    info.apk.size ? formatMb(info.apk.size) : '',
    formatDate(info.publishedAt),
  ].filter(Boolean).join(' · ');
  $('app-release-sha').hidden = !info.sha256;
  $('app-release-sha-value').textContent = info.sha256 || '';
  $('app-release').hidden = false;
  $('app-release-status').hidden = true;
}

function showStatus(text) {
  $('app-release').hidden = true;
  const status = $('app-release-status');
  status.hidden = false;
  status.textContent = text;
}

function showUnavailable(reason) {
  showStatus(reason === 'none'
    ? t('appPage.noRelease', 'No release has been published yet.')
    : t('appPage.unavailable', 'Could not check the latest version. Find it on the releases page below.'));
}

let loaded = null; // the last good answer, so reopening the page shows it at once

async function loadRelease() {
  if (loaded) showRelease(loaded);
  else showStatus(t('appPage.checking', 'Checking the latest version…'));
  try {
    const res = await fetch('/api/app/latest', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    if (info.available) { loaded = info; showRelease(info); }
    else if (!loaded) showUnavailable(info.reason);
  } catch {
    if (!loaded) showUnavailable('unavailable');
  }
}

function openPage() {
  $('app-pending-note').hidden = !isPending();
  $('app-tokens-link').hidden = isPending();
  $('app-connect-server').textContent = tf(
    'appPage.connect4', 'Under “Server”, check that “Address” is {origin}.', { origin: window.location.origin },
  );
  loadRelease();
}

let isSetUp = false;
export function setupAppPage() {
  if (isSetUp) return;
  isSetUp = true;
  viewActivators.app = openPage;
  $('app-back-btn').addEventListener('click', () => {
    // A pending account has no router running here.
    if (isPending()) window.location.assign('/');
    else navigateTo('/');
  });
  $('app-release-sha-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('app-release-sha-value').textContent);
      showToast(t('appPage.copied', 'Copied'), 'success');
    } catch {
      showToast(t('appPage.copyFailed', 'Could not copy'), 'error');
    }
  });
  // Links to other views stay in the app, so playback carries on.
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('a[data-spa-link]');
    if (!link || isPending() || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateTo(link.getAttribute('href'));
  });
}
