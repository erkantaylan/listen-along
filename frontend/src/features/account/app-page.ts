// /app: download the Android app, install it, connect it with a token. The text
// is static (index.html + locales); this fills in the release from
// /api/app/latest. Whatever goes wrong there, the releases link stays.
import { auth, viewActivators } from '../../shared/state.ts';
import { navigateTo, showToast, t } from '../../shared/ui.ts';
import { byId } from '../../shared/dom.ts';
import type { AppLatestResponse, AppRelease } from '../../shared/types.ts';

const tf = (key: string, fallback: string, vars: Record<string, string>) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;
const isPending = () => !!(auth.user && auth.user.status === 'pending');

function formatDate(value: string | null): string {
  const d = new Date(value as string);
  return value && !isNaN(d.getTime()) ? d.toLocaleDateString(language(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString(language(), { maximumFractionDigits: 1 })} MB`;
}

function showRelease(info: AppRelease): void {
  byId<HTMLAnchorElement>('app-download-link').href = info.apk.url;
  byId('app-release-meta').textContent = [
    `v${info.version}`,
    info.apk.size ? formatMb(info.apk.size) : '',
    formatDate(info.publishedAt),
  ].filter(Boolean).join(' · ');
  byId('app-release-sha').hidden = !info.sha256;
  byId('app-release-sha-value').textContent = info.sha256 || '';
  byId('app-release').hidden = false;
  byId('app-release-status').hidden = true;
}

function showStatus(text: string): void {
  byId('app-release').hidden = true;
  const status = byId('app-release-status');
  status.hidden = false;
  status.textContent = text;
}

function showUnavailable(reason: string): void {
  showStatus(reason === 'none'
    ? t('appPage.noRelease', 'No release has been published yet.')
    : t('appPage.unavailable', 'Could not check the latest version. Find it on the releases page below.'));
}

let loaded: AppRelease | null = null; // the last good answer, so reopening the page shows it at once

async function loadRelease(): Promise<void> {
  if (loaded) showRelease(loaded);
  else showStatus(t('appPage.checking', 'Checking the latest version…'));
  try {
    const res = await fetch('/api/app/latest', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json() as AppLatestResponse;
    if (info.available) { loaded = info; showRelease(info); }
    else if (!loaded) showUnavailable(info.reason);
  } catch {
    if (!loaded) showUnavailable('unavailable');
  }
}

function openPage(): void {
  byId('app-pending-note').hidden = !isPending();
  byId('app-tokens-link').hidden = isPending();
  byId('app-connect-server').textContent = tf(
    'appPage.connect4', 'Under “Server”, check that “Address” is {origin}.', { origin: window.location.origin },
  );
  loadRelease();
}

let isSetUp = false;
export function setupAppPage(): void {
  if (isSetUp) return;
  isSetUp = true;
  viewActivators.app = openPage;
  byId('app-back-btn').addEventListener('click', () => {
    // A pending account has no router running here.
    if (isPending()) window.location.assign('/');
    else navigateTo('/');
  });
  byId('app-release-sha-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('app-release-sha-value').textContent);
      showToast(t('appPage.copied', 'Copied'), 'success');
    } catch {
      showToast(t('appPage.copyFailed', 'Could not copy'), 'error');
    }
  });
  // Links to other views stay in the app, so playback carries on.
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const link = target.closest && target.closest('a[data-spa-link]');
    if (!link || isPending() || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateTo(link.getAttribute('href') as string);
  });
}
