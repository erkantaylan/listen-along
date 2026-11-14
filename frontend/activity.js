// The download activity log: the Activity tab of the chat and people panel
// (#social-activity; social.js switches the tabs). Every download job of
// everyone, live: who asked for what, where it is now, and how it ended.
// Watching only, no actions. Approved accounts only: the server sends a
// pending account neither the list nor the events, and social.js leaves the
// tab hidden for it.
//
// Data: GET /api/activity/downloads, then socket activity:job (a row is new or
// changed) and activity:progress (a running row's progress line). The rules
// are in activity-rules.js; the wording and badges are jobs.js's.
import { jobStatusText, thumbHtml, BADGES } from './jobs.js';
import { MAX_ROWS, mergeJob, applyLoad, applyProgress, progressOf, failureKey, activeCount, isActive, rowTitle, rowTime } from './activity-rules.js';
import { formatLastSeen, escapeText } from './chat-format.js';
import { navigateTo, t } from './ui.js';

const A = {
  jobs: [],
  workers: { online: 0, idle: 0, busy: 0 },
  loaded: false,
  failed: false,
  loadSeq: 0,   // the latest load(); an older one's answer is dropped
  buffer: null, // rows that arrived while a load is on its way
  visible: false,
  rows: new Map(), // job id -> its <li>
  reloadTimer: null,
};

const $ = (id) => document.getElementById(id);
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// English fallbacks of the failure sentences (activity.fail.* in the locales).
const FAILURE_TEXT = {
  unavailable: 'The video is unavailable',
  private: 'The video is private',
  signIn: 'The video needs a sign-in',
  ageRestricted: 'The video is age-restricted',
  region: "The video is not available in the downloader's country",
  drm: 'The video is DRM-protected',
  botCheck: 'YouTube is blocking the downloader (bot check)',
  refused: 'YouTube refused the download',
  noFormat: 'The video has no usable audio format',
  ytdlp: "The downloader's yt-dlp could not download it",
  network: 'Network error on the downloader',
  noResults: 'No search results',
  badAudio: 'The downloaded audio could not be used',
  noTags: 'The title and artist could not be worked out',
  duplicate: 'It is already in the library',
  songDeleted: 'The song to replace was deleted from the library',
  workerLost: 'The downloader went away too many times',
  nothing: 'Nothing was downloaded',
  server: 'The server refused the upload',
  generic: 'Download failed',
};

// The row as jobStatusText words it: the server sends a failed job's code and a
// running job's stage and percent, never the downloader's own text, so the
// sentences are made here.
function worded(job) {
  if (job.status === 'failed') {
    const key = failureKey(job.error_code);
    return { ...job, error_message: t(`activity.fail.${key}`, FAILURE_TEXT[key]) };
  }
  const p = progressOf(job);
  if (!p) return job;
  const progress = p.key === 'searching' ? t('activity.searching', 'Searching')
    : p.percent === null ? t('activity.uploading', 'Uploading')
      : tf('activity.uploadingPercent', 'Uploading {percent}%', { percent: p.percent });
  return { ...job, progress };
}

function titleOf(job) {
  return rowTitle(job) || (job.kind === 'playlist' ? t('activity.aPlaylist', 'YouTube playlist') : t('activity.aVideo', 'YouTube video'));
}

// "Asked by Ada · for Road trip · 5m ago". The playlist is there only when the
// server put it on the row, which it does only for someone who can see it.
function metaHtml(job) {
  const parts = [escapeText(job.requested_by ? tf('activity.askedBy', 'Asked by {name}', { name: job.requested_by }) : t('activity.askedBySomeone', 'Asked by someone'))];
  if (job.replace) parts.push(escapeText(t('activity.replacing', 'replacing a song')));
  if (job.playlist_id) {
    const link = `<a class="activity-playlist" href="/playlist/${encodeURIComponent(job.playlist_id)}" data-activity-playlist="${escapeText(job.playlist_id)}">${escapeText(job.playlist_name || job.playlist_id)}</a>`;
    parts.push(tf('activity.forPlaylist', 'for {playlist}', { playlist: link }));
  }
  const when = formatLastSeen(rowTime(job));
  if (when) parts.push(`<time datetime="${escapeText(new Date(rowTime(job)).toISOString())}">${escapeText(when)}</time>`);
  return parts.join(' · ');
}

function createRow(job) {
  const li = document.createElement('li');
  li.className = 'list-group-item activity-row';
  li.dataset.job = job.id;
  li.innerHTML = `${thumbHtml(job, 'activity-thumb')}<div class="min-w-0 flex-grow-1">`
    + '<div class="d-flex align-items-center gap-2 min-w-0"><span class="fw-medium text-truncate activity-title"></span><span class="badge badge-subtle ms-auto flex-shrink-0 activity-badge"></span></div>'
    + '<div class="fs-sm fg-2 activity-status"></div><div class="fs-xs fg-3 activity-meta"></div></div>';
  return li;
}

// Only what changed is written, so a progress tick touches one text node:
// no flicker, the thumbnail does not reload and a text selection survives.
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function updateRow(li, job) {
  li.classList.toggle('is-active', isActive(job));
  const title = titleOf(job);
  const titleEl = li.querySelector('.activity-title');
  setText(titleEl, title);
  if (titleEl.title !== title) titleEl.title = title;
  const [theme, label] = BADGES[job.status] || ['theme-secondary', job.status];
  const badge = li.querySelector('.activity-badge');
  const badgeClass = `badge badge-subtle ms-auto flex-shrink-0 activity-badge ${theme}`;
  if (badge.className !== badgeClass) badge.className = badgeClass;
  setText(badge, label);
  const status = jobStatusText(worded(job), A.workers);
  const statusEl = li.querySelector('.activity-status');
  setText(statusEl, status);
  if (statusEl.title !== status) statusEl.title = status;
  const meta = metaHtml(job);
  if (li._meta !== meta) { li._meta = meta; li.querySelector('.activity-meta').innerHTML = meta; }
}

// What is in progress: a count on the rail button, a dot on the tab (which
// says the number in its label, like the chat button does for unread).
function renderCount() {
  const n = activeCount(A.jobs);
  for (const el of document.querySelectorAll('[data-activity-count]')) {
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = n === 0;
  }
  for (const el of document.querySelectorAll('[data-activity-dot]')) el.hidden = n === 0;
  const base = t('social.activityLong', 'Download activity');
  const label = !n ? base : `${base} (${n === 1 ? t('activity.oneActive', '1 in progress') : tf('activity.nActive', '{count} in progress', { count: n })})`;
  const tab = document.querySelector('[data-social-tab="activity"]');
  if (tab) { tab.title = label; tab.setAttribute('aria-label', label); }
}

function render() {
  renderCount();
  const list = $('activity-list');
  const empty = $('activity-empty');
  if (!list || !empty) return;
  empty.hidden = A.jobs.length > 0;
  if (!A.jobs.length) {
    empty.textContent = !A.loaded ? t('activity.loading', 'Loading…')
      : A.failed ? t('activity.loadFailed', 'Could not load the downloads.')
        : t('activity.empty', 'No downloads yet. Songs that people ask for show up here while they are downloaded.');
  }
  const keep = new Set(A.jobs.map((j) => j.id));
  for (const [id, li] of A.rows) if (!keep.has(id)) { li.remove(); A.rows.delete(id); }
  // Rows keep their element; one is moved only when it is out of place.
  let at = list.firstElementChild;
  for (const job of A.jobs) {
    let li = A.rows.get(job.id);
    if (!li) { li = createRow(job); A.rows.set(job.id, li); }
    updateRow(li, job);
    if (li === at) at = at.nextElementSibling;
    else list.insertBefore(li, at);
  }
}

async function load() {
  // Loads can overlap (a reconnect, then a playlist change) and answer out of
  // order: only the latest one's list is used. Rows that change meanwhile are
  // kept until it has applied, since they are newer than any list on its way.
  const seq = ++A.loadSeq;
  if (!A.buffer) A.buffer = [];
  let data = null;
  try {
    const res = await fetch('/api/activity/downloads', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch { /* keep what is shown */ }
  if (seq !== A.loadSeq) return;
  if (data) {
    A.jobs = applyLoad(data.jobs, A.buffer, MAX_ROWS);
    if (data.workers) A.workers = data.workers;
  }
  A.failed = !data && !A.loaded;
  A.buffer = null;
  A.loaded = true;
  render();
}

// A playlist changed somewhere (it may have gone private, or been renamed):
// what each row may name is the server's call, so ask again.
function reloadSoon() {
  if (!A.loaded || A.reloadTimer) return;
  A.reloadTimer = setTimeout(() => { A.reloadTimer = null; load(); }, 500);
}

/** The tab came on screen or left it (social.js). */
export function setActivityVisible(visible) {
  if (A.visible === visible) return;
  A.visible = visible;
  if (visible) render(); // relative times have aged
}

/** Start the log on the panel's socket. Call only for an approved account. */
export function setupActivity(socket) {
  socket.on('connect', load); // also after a reconnect: events were missed
  if (socket.connected) load();
  socket.on('activity:job', ({ job } = {}) => {
    if (!job) return;
    if (A.buffer) A.buffer.push(job);
    if (!A.loaded) return;
    A.jobs = mergeJob(A.jobs, job, MAX_ROWS);
    render();
  });
  socket.on('activity:progress', (p) => {
    const next = applyProgress(A.jobs, p);
    if (next === A.jobs) return;
    A.jobs = next;
    const li = A.rows.get(p.id);
    const job = next.find((j) => j.id === p.id);
    if (li && job) updateRow(li, job);
  });
  // "Waiting — none is online" depends on who is connected.
  socket.on('workers:update', (stats) => {
    if (!stats) return;
    A.workers = stats;
    if (A.jobs.some((j) => j.status === 'queued')) render();
  });
  socket.on('playlists:changed', reloadSoon);
  $('activity-list')?.addEventListener('click', (e) => {
    const link = e.target.closest('[data-activity-playlist]');
    // /dashboard is not the app: there the link is a plain one.
    if (!link || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || window.location.pathname.startsWith('/dashboard')) return;
    e.preventDefault();
    navigateTo(`/playlist/${encodeURIComponent(link.dataset.activityPlaylist)}`);
  });
  setInterval(() => { if (A.visible) render(); }, 60_000);
  render();
}
