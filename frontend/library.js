// Music library page: every song in the library (searchable, with uploader)
// plus the list of song requests waiting for an upload. Songs are added to the
// current lobby's queue from here.
import { state, socket } from './state.js';
import { showToast, formatDuration, notifyViewChange } from './ui.js';
import { libraryPath, basePath } from './router.js';
import { player } from './player.js';
import { setupDownloads, showDownloads, hideDownloads } from './jobs.js';
import { clearReplacedFailure } from './playback-failures.js';
import { bindSongMenu, songMenuButtonHtml, reportIconHtml, reportLines, reportsFor, onReportsChange, reportedCount, reportsLoaded, handleReportsUpdated, isReportDialogOpen } from './song-reports.js';
import { isContextMenuOpen } from './context-menu.js';
import { openReplaceDialog } from './replace-dialog.js';

// Escapes for both text and attribute contexts (ui.js escapeHtml leaves quotes).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PAGE_SIZE = 20;

const lib = {
  open: false,
  tab: 'library',
  songs: [],
  total: 0,
  page: 0,
  loading: false,
  query: '',
  sort: 'recent',
  requestStatus: 'pending',
  searchTimer: null,
  loadSeq: 0,
};

const $ = (id) => document.getElementById(id);

// --- Playing ----------------------------------------------------------------
// The ▶ button plays the song in the app-wide player (player.js), like any
// other song: the bar shows it, it keeps playing across pages and lock-screen
// controls work. The context is the library page as shown (current search and
// sort), starting at the clicked song, so Next continues down the page and
// stops at its end (pages are fetched from the server one at a time). Playing
// from here replaces the current context (e.g. a lobby queue). Each row's
// button follows the player: the song that is playing shows pause.

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const REPLACE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

// Library songs as player tracks. Queue entries refer to library songs as
// `library:<id>`, so the same song playing from a lobby also counts.
export function libraryTrack(song) {
  return {
    libraryId: song.id,
    url: `library:${song.id}`,
    // The file version makes the url change when the audio is replaced.
    src: `/api/library/${encodeURIComponent(song.id)}/file${song.file_version ? `?v=${encodeURIComponent(song.file_version)}` : ''}`,
    title: song.title,
    artist: song.artist || '',
    youtubeId: song.youtube_id || null,
    thumbnail: song.youtube_id ? `https://i.ytimg.com/vi/${encodeURIComponent(song.youtube_id)}/hqdefault.jpg` : null,
    duration: song.duration_sec || 0,
  };
}

function isCurrentSong(songId) {
  const t = player.track;
  return !!t && (t.libraryId === songId || t.url === `library:${songId}`);
}

function songPlaying(songId) {
  return isCurrentSong(songId) && player.isPlaying;
}

function playButtonHtml(songId) {
  const playing = songPlaying(songId);
  return `<button class="btn-outline theme-secondary btn-icon btn-sm rounded-pill libpage-play${playing ? ' playing' : ''}" data-id="${escapeHtml(songId)}" type="button" aria-label="${playing ? 'Pause' : 'Play'}" title="${playing ? 'Pause' : 'Play'}">${playing ? PAUSE_ICON : PLAY_ICON}</button>`;
}

function updatePlayButtons() {
  document.querySelectorAll('.libpage-play').forEach((btn) => {
    const playing = songPlaying(btn.dataset.id);
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    btn.title = playing ? 'Pause' : 'Play';
  });
  document.querySelectorAll('#libpage-list .libpage-item').forEach((li) => {
    li.classList.toggle('is-playing', isCurrentSong(li.dataset.id));
  });
}

player.on('state', updatePlayButtons);
player.on('track', updatePlayButtons);

function playSong(songId) {
  if (isCurrentSong(songId)) { player.toggle(); return; }
  const index = lib.songs.findIndex((s) => s.id === songId);
  if (index < 0) return;
  player.playFrom({ type: 'library' }, lib.songs.map(libraryTrack), index);
}

// A click on the row plays it (Spotify-like); the song already playing is
// resumed if paused, never restarted or paused (the ▶ button toggles).
function playRow(songId) {
  if (isCurrentSong(songId)) { if (!player.isPlaying) player.play(); return; }
  playSong(songId);
}

function relativeDate(value) {
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function thumbHtml(youtubeId) {
  if (youtubeId) {
    return `<img class="app-thumb libpage-thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/default.jpg" alt="" loading="lazy">`;
  }
  return '<div class="app-thumb libpage-thumb"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
}

// "added by Ayşe", or "uploaded by living-room-pc (Ayşe)" when a downloader
// (`la worker`) did it; plus who asked for it, if anyone.
function uploaderHtml(song) {
  const who = escapeHtml(song.uploaded_by || 'unknown');
  const by = song.uploaded_by_worker ? `uploaded by ${escapeHtml(song.uploaded_by_worker)} (${who})` : `added by ${who}`;
  return song.requested_by ? `${by} · asked by ${escapeHtml(song.requested_by)}` : by;
}

function updateContext() {
  const el = $('libpage-context');
  if (!el) return;
  if (state.lobbyId) {
    el.textContent = `Adding to: ${state.lobbyName || state.lobbyId}`;
    el.classList.remove('muted');
  } else {
    el.textContent = 'Open a playlist to add songs to it';
    el.classList.add('muted');
  }
}

// --- Songs ----------------------------------------------------------------

// Queue entries point at library songs by url: `library:<uuid>`, or the
// YouTube watch URL for songs with a YouTube id (backend library.queueUrlFor).
// Older entries may carry the song's source_url instead.
function youtubeIdFromUrl(url) {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

function queuedKeys() {
  const keys = new Set();
  for (const item of state.queue || []) {
    if (!item || !item.url) continue;
    keys.add(item.url);
    const yt = youtubeIdFromUrl(item.url);
    if (yt) keys.add(`yt:${yt}`);
  }
  return keys;
}

function isQueued(song, keys) {
  return keys.has(`library:${song.id}`)
    || (!!song.youtube_id && keys.has(`yt:${song.youtube_id}`))
    || (!!song.source_url && keys.has(song.source_url));
}

// Add button state: no lobby, already in this lobby's queue, or addable.
function setAddButton(btn, song, keys) {
  const queued = !!state.lobbyId && isQueued(song, keys);
  btn.disabled = !state.lobbyId || queued;
  btn.classList.toggle('added', queued);
  btn.textContent = queued ? 'Added' : 'Add';
  if (!state.lobbyId) btn.title = 'Open a playlist first';
  else if (queued) btn.title = 'Already in the queue';
  else btn.removeAttribute('title');
}

// Called whenever the queue (or the lobby) changes, so the buttons follow
// songs being added elsewhere or removed from the queue.
export function refreshLibraryAddButtons() {
  if (!lib.open) return;
  updateContext();
  const keys = queuedKeys();
  document.querySelectorAll('#libpage-list .libpage-add').forEach((btn) => {
    const song = lib.songs.find((s) => s.id === btn.dataset.id);
    if (song) setAddButton(btn, song, keys);
  });
}

function renderSongs() {
  const list = $('libpage-list');
  if (!list) return;
  const count = $('libpage-count');
  if (count && lib.tab !== 'broken') count.textContent = lib.total ? String(lib.total) : '';
  renderBrokenCount();
  if (!lib.songs.length) {
    const empty = lib.tab === 'broken'
      ? (lib.query ? 'No reported songs match your search' : 'Nothing needs replacement. Right-click a song (or use its ⋮ button) to mark it as broken.')
      : (lib.query ? 'No songs match your search' : 'The library is empty. Songs appear here once they are uploaded.');
    list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${lib.loading ? 'Loading…' : empty}</li>`;
  } else {
    list.innerHTML = lib.songs.map((song) => {
      const sub = [song.artist, song.album].filter(Boolean).map(escapeHtml).join(' · ');
      // Open "needs replacement" reports: the live store, else what the list sent.
      const reports = reportsLoaded() ? reportsFor({ songId: song.id }) : (song.reports || []);
      const reportsHtml = lib.tab === 'broken' && reports.length
        ? `<ul class="list-unstyled fs-xs fg-2 mb-0 mt-1 libpage-reports">${reportLines(reports).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
        : '';
      const meta = [
        song.duration_sec ? formatDuration(song.duration_sec) : '',
        uploaderHtml(song),
        relativeDate(song.created_at),
      ].filter(Boolean).join(' · ');
      return `<li class="list-group-item list-group-item-action libpage-item${isCurrentSong(song.id) ? ' is-playing' : ''}" data-id="${escapeHtml(song.id)}" tabindex="0">
        ${thumbHtml(song.youtube_id)}
        <div class="libpage-info min-w-0">
          <div class="d-flex align-items-center gap-1 min-w-0 libpage-title-row"><div class="text-truncate libpage-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>${reportIconHtml(reports)}</div>
          <div class="fs-sm fg-2 text-truncate libpage-sub">${sub}</div>
          <div class="fs-xs fg-3 libpage-meta">${meta}</div>
          ${reportsHtml}
        </div>
        ${playButtonHtml(song.id)}
        <button class="btn-text theme-secondary btn-icon btn-sm libpage-replace" type="button" data-id="${escapeHtml(song.id)}" aria-label="Replace ${escapeHtml(song.title)} with…" title="Replace with…">${REPLACE_ICON}</button>
        <button class="btn-solid theme-primary btn-sm libpage-add" type="button" data-id="${escapeHtml(song.id)}">Add</button>
        ${songMenuButtonHtml(song.title)}
      </li>`;
    }).join('');
    const keys = queuedKeys();
    list.querySelectorAll('.libpage-add').forEach((btn, i) => setAddButton(btn, lib.songs[i], keys));
  }
  renderPager();
}

function renderBrokenCount() {
  const el = $('libpage-broken-count');
  if (!el) return;
  const n = reportedCount();
  el.textContent = n ? String(n) : '';
  el.hidden = !n;
}

// Marked / unmarked anywhere: badges and the tab count follow.
onReportsChange(() => { if (lib.open) renderSongs(); });

function pageCount() {
  return Math.max(1, Math.ceil(lib.total / PAGE_SIZE));
}

// Page numbers to show: first, last, and two (one on phones) either side of
// the current page, with null for each gap ("…").
function pageItems(current, count) {
  const around = window.matchMedia('(max-width: 480px)').matches ? 1 : 2;
  const keep = new Set([0, count - 1]);
  for (let i = current - around; i <= current + around; i++) if (i >= 0 && i < count) keep.add(i);
  const items = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i - prev > 1) items.push(null);
    items.push(i);
    prev = i;
  }
  return items;
}

// Two pagers share one state: a compact "‹ Page 5 of 30 ›" above the list
// and the full numbered one below it. Both hide when there is one page.
function renderPager() {
  const pager = $('libpage-pager');
  const top = $('libpage-pager-top');
  if (!pager || !top) return;
  const count = pageCount();
  if (lib.total <= PAGE_SIZE) {
    pager.hidden = true; pager.innerHTML = '';
    top.hidden = true; top.innerHTML = '';
    return;
  }
  pager.hidden = false;
  top.hidden = false;
  const p = lib.page;
  const step = (page, label, aria, disabled) =>
    `<button class="btn-outline theme-secondary btn-icon btn-sm libpage-page" type="button" data-page="${page}" aria-label="${aria}" title="${aria}"${disabled ? ' disabled' : ''}>${label}</button>`;
  top.innerHTML = `
    ${step(p - 1, '‹', 'Previous page', p === 0)}
    <span class="fs-sm fg-2 libpage-pager-label" aria-live="polite">Page ${(p + 1).toLocaleString()} of ${count.toLocaleString()}</span>
    ${step(p + 1, '›', 'Next page', p >= count - 1)}`;
  const from = p * PAGE_SIZE + 1;
  const to = Math.min(lib.total, (p + 1) * PAGE_SIZE);
  const item = (page, label, { current = false, disabled = false, aria = '' } = {}) =>
    `<li class="page-item${current ? ' active' : ''}${disabled ? ' disabled' : ''}"><button class="page-link libpage-page" type="button" data-page="${page}"${disabled ? ' disabled' : ''}${current ? ' aria-current="page"' : ''}${aria ? ` aria-label="${aria}"` : ''}>${label}</button></li>`;
  pager.innerHTML = `
    <ul class="pagination pagination-sm mb-0 libpage-pages">
      ${item(p - 1, '‹', { disabled: p === 0, aria: 'Previous page' })}
      ${pageItems(p, count).map((i) => (i === null ? '<li class="page-item disabled" aria-hidden="true"><span class="page-link libpage-gap">…</span></li>' : item(i, i + 1, { current: i === p, aria: `Page ${i + 1}` }))).join('')}
      ${item(p + 1, '›', { disabled: p >= count - 1, aria: 'Next page' })}
    </ul>
    <span class="fs-sm fg-3 libpage-range">${from.toLocaleString()}–${to.toLocaleString()} of ${lib.total.toLocaleString()}</span>`;
}

function goToPage(page) {
  if (page < 0 || page >= pageCount() || page === lib.page) return;
  loadSongs({ page });
  syncUrl('push');
  const list = $('libpage-list');
  if (list) list.scrollTop = 0;
}

// refresh: reload the current page in place (library:updated) instead of
// blanking the list while it loads.
async function loadSongs({ page = 0, refresh = false } = {}) {
  const seq = ++lib.loadSeq;
  lib.loading = true;
  lib.page = page;
  if (!refresh) { lib.songs = []; renderSongs(); }
  const params = new URLSearchParams({
    q: lib.query,
    sort: lib.sort,
    ...(lib.tab === 'broken' ? { reported: '1' } : {}),
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  try {
    const res = await fetch(`/api/library?${params}`);
    const data = await res.json();
    if (seq !== lib.loadSeq) return; // a newer search superseded this one
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lib.songs = data.songs;
    lib.total = data.total;
    // The page can vanish under us (songs deleted, narrower search): step back.
    if (!lib.songs.length && page > 0 && page >= pageCount()) {
      loadSongs({ page: pageCount() - 1, refresh });
      if (lib.open) syncUrl('replace');
      return;
    }
  } catch (err) {
    if (seq !== lib.loadSeq) return;
    showToast(`Could not load the library: ${err.message}`, 'error');
  } finally {
    if (seq === lib.loadSeq) { lib.loading = false; renderSongs(); }
  }
}

function addToQueue(songId, btn) {
  if (!state.lobbyId) { showToast('Open a playlist first', 'error'); return; }
  socket.emit('queue:add', { lobbyId: state.lobbyId, libraryId: songId, addedBy: state.username, userId: state.userId });
  // Stays "Added": the queue:update that follows keeps it that way, and a
  // rejected duplicate means it was already queued anyway.
  if (btn) {
    btn.textContent = 'Added';
    btn.disabled = true;
    btn.classList.add('added');
    btn.title = 'Already in the queue';
  }
}

// --- Requests -------------------------------------------------------------

const STATUS_THEMES = { pending: 'theme-warning', fulfilled: 'theme-success', dismissed: 'theme-secondary' };
function statusBadge(status) {
  const label = { pending: 'waiting', fulfilled: 'uploaded', dismissed: 'not found' }[status] || status;
  return `<span class="badge badge-subtle ${STATUS_THEMES[status] || 'theme-secondary'} libpage-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

async function loadRequests() {
  const list = $('libpage-requests');
  try {
    const res = await fetch(`/api/requests?status=${encodeURIComponent(lib.requestStatus)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const requests = data.requests || [];
    if (lib.requestStatus === 'pending') setRequestCount(requests.length);
    if (!list) return;
    if (!requests.length) {
      list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${lib.requestStatus === 'pending' ? 'No songs are waiting. Anything you queue that is not in the library shows up here.' : 'Nothing here yet.'}</li>`;
      return;
    }
    list.innerHTML = requests.map((r) => {
      const title = r.title || r.youtube_id || r.url || 'Unknown song';
      const sub = [r.artist, r.youtube_id ? `YouTube ${r.youtube_id}` : (r.url || '')].filter(Boolean).map(escapeHtml).join(' · ');
      const link = r.youtube_id ? `https://www.youtube.com/watch?v=${encodeURIComponent(r.youtube_id)}` : (r.url && /^https?:\/\//.test(r.url) ? r.url : null);
      return `<li class="list-group-item libpage-item">
        ${thumbHtml(r.youtube_id)}
        <div class="libpage-info min-w-0">
          <div class="text-truncate libpage-title" title="${escapeHtml(title)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</div>
          <div class="fs-sm fg-2 text-truncate libpage-sub">${sub}</div>
          <div class="fs-xs fg-3 libpage-meta">requested by ${escapeHtml(r.requested_by)} · ${relativeDate(r.created_at)}</div>
        </div>
        ${statusBadge(r.status)}
      </li>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<li class="list-group-item app-empty libpage-empty">Could not load requests: ${escapeHtml(err.message)}</li>`;
  }
}

function setRequestCount(n) {
  const el = $('libpage-requests-count');
  if (el) { el.textContent = n ? String(n) : ''; el.hidden = !n; }
}

async function refreshRequestCount() {
  try {
    const res = await fetch('/api/requests?status=pending');
    if (!res.ok) return;
    const data = await res.json();
    setRequestCount((data.requests || []).length);
  } catch {}
}

// --- URL ------------------------------------------------------------------
// The address bar follows the library state (frontend/router.js has the
// scheme): tabs and pages push a history entry, search/sort/filter replace it.
// history.state.libDepth counts the library entries pushed since it was opened
// in-app, so closing it can step back past them instead of adding another.

function syncUrl(mode) {
  const url = libraryPath(state.lobbyId, lib);
  if (window.location.pathname + window.location.search === url) return;
  if (mode === 'push') {
    const depth = history.state && history.state.libDepth;
    history.pushState(depth ? { libDepth: depth + 1 } : null, '', url);
  } else {
    history.replaceState(history.state, '', url);
  }
}

function syncControls() {
  const search = $('libpage-search');
  if (search && search.value.trim() !== lib.query) search.value = lib.query;
  const sort = $('libpage-sort');
  if (sort) sort.value = lib.sort;
  const status = $('libpage-request-status');
  if (status) status.value = lib.requestStatus;
}

export function isLibraryOpen() {
  return lib.open;
}

// Show the library in the state a URL asks for (direct load, Back/Forward).
// Leaves the address bar alone; it already says this.
export function showLibraryRoute(route) {
  const page = $('library-page');
  if (!page) return;
  const wasOpen = lib.open;
  const songsChanged = !wasOpen || route.query !== lib.query || route.sort !== lib.sort || route.page !== lib.page;
  const requestsChanged = route.requestStatus !== lib.requestStatus;
  clearTimeout(lib.searchTimer);
  lib.query = route.query;
  lib.sort = route.sort;
  lib.requestStatus = route.requestStatus;
  syncControls();
  if (!wasOpen) {
    lib.open = true;
    page.hidden = false;
    document.body.classList.add('libpage-open');
    refreshRequestCount();
    notifyViewChange();
  }
  updateContext();
  const tabChanged = route.tab !== lib.tab;
  const songsTabSwitch = tabChanged && ['library', 'broken'].includes(route.tab) && ['library', 'broken'].includes(lib.tab);
  if (!wasOpen || tabChanged || (route.tab === 'requests' && requestsChanged)) {
    // switchTab reloads on a Songs <-> Broken switch; do it once, at the right page.
    if (songsTabSwitch) { lib.tab = route.tab; switchTab(route.tab); }
    else switchTab(route.tab);
  }
  if (songsChanged || songsTabSwitch) loadSongs({ page: route.page });
}

// Close button / Escape: step back to the page the library was opened from,
// or (opened from a link) go to the view underneath it.
function requestCloseLibrary() {
  const depth = history.state && history.state.libDepth;
  closeLibraryPage();
  if (depth) history.go(-depth);
  else history.pushState(null, '', basePath({ view: state.lobbyId ? 'lobby' : 'landing', lobbyId: state.lobbyId }));
}

// --- Page -----------------------------------------------------------------

// "Broken" (needs replacement) is the Songs panel filtered to reported songs.
function switchTab(tab) {
  const songsMode = (t) => (t === 'broken' ? 'broken' : t === 'library' ? 'library' : null);
  const reload = lib.open && songsMode(tab) && songsMode(lib.tab) && tab !== lib.tab;
  lib.tab = tab;
  document.querySelectorAll('#library-page .libpage-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.libtab === tab);
    if (b.dataset.libtab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('libpage-songs-panel').hidden = tab !== 'library' && tab !== 'broken';
  const hint = $('libpage-broken-hint');
  if (hint) hint.hidden = tab !== 'broken';
  $('libpage-requests-panel').hidden = tab !== 'requests';
  $('libpage-downloads-panel').hidden = tab !== 'downloads';
  if (tab === 'requests') loadRequests();
  if (tab === 'downloads') showDownloads(); else hideDownloads();
  if (reload) loadSongs();
}

export function openLibraryPage(tab = 'library') {
  const page = $('library-page');
  if (!page) return;
  lib.open = true;
  page.hidden = false;
  document.body.classList.add('libpage-open');
  notifyViewChange();
  updateContext();
  switchTab(tab);
  loadSongs();
  refreshRequestCount();
  syncControls();
  history.pushState({ libDepth: 1 }, '', libraryPath(state.lobbyId, lib));
  const search = $('libpage-search');
  if (search && tab === 'library' && window.matchMedia('(pointer: fine)').matches) search.focus();
  const dlInput = $('dl-input');
  if (dlInput && tab === 'downloads' && window.matchMedia('(pointer: fine)').matches) dlInput.focus();
}

export function closeLibraryPage() {
  const page = $('library-page');
  if (!page) return;
  lib.open = false;
  page.hidden = true;
  document.body.classList.remove('libpage-open');
  hideDownloads();
  notifyViewChange();
}

// payload.replaced: a song's audio was replaced (same id). Whatever is
// playing it reloads the new file at the same position (player.js).
// payload.details: only its title, artist or album changed; the audio plays on.
export function handleLibraryUpdated(payload) {
  if (payload && payload.replaced) { clearReplacedFailure(payload.replaced); player.reloadReplaced(payload.replaced, payload.song); }
  if (payload && payload.details) player.updateDetails(payload.details, payload.song);
  handleReportsUpdated(payload);
  if (lib.open) loadSongs({ page: lib.page, refresh: true });
}

export function handleRequestsUpdated() {
  if (!lib.open) return;
  if (lib.tab === 'requests') loadRequests();
  else refreshRequestCount();
}

export function setupLibraryPage() {
  const page = $('library-page');
  if (!page) return;
  $('libpage-close').addEventListener('click', requestCloseLibrary);
  setupDownloads();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lib.open && !$('replace-dialog') && !isReportDialogOpen() && !isContextMenuOpen()) requestCloseLibrary();
  });
  // Right-click / long-press / ⋮ on a song row: the song menu (song-reports.js).
  bindSongMenu($('libpage-list'), '.libpage-item[data-id]', (row) => {
    const song = lib.songs.find((s) => s.id === row.dataset.id);
    return song ? { songId: song.id, title: song.title, artist: song.artist, youtubeId: song.youtube_id, sourceUrl: song.source_url } : null;
  });
  page.querySelectorAll('.libpage-tab').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.libtab === lib.tab) return;
    switchTab(b.dataset.libtab);
    syncUrl('push');
  }));
  $('libpage-search').addEventListener('input', (e) => {
    clearTimeout(lib.searchTimer);
    lib.searchTimer = setTimeout(() => { lib.query = e.target.value.trim(); loadSongs(); syncUrl('replace'); }, 250);
  });
  $('libpage-sort').addEventListener('change', (e) => { lib.sort = e.target.value; loadSongs(); syncUrl('replace'); });
  const onPagerClick = (e) => {
    const btn = e.target.closest('.libpage-page');
    if (btn && !btn.disabled) goToPage(Number(btn.dataset.page));
  };
  $('libpage-pager').addEventListener('click', onPagerClick);
  $('libpage-pager-top').addEventListener('click', onPagerClick);
  $('libpage-request-status').addEventListener('change', (e) => { lib.requestStatus = e.target.value; loadRequests(); syncUrl('replace'); });
  $('libpage-list').addEventListener('click', (e) => {
    const play = e.target.closest('.libpage-play');
    if (play) { playSong(play.dataset.id); return; }
    const replace = e.target.closest('.libpage-replace');
    if (replace) { openReplaceDialog({ songId: replace.dataset.id, returnFocus: replace }); return; }
    const btn = e.target.closest('.libpage-add');
    if (btn) { addToQueue(btn.dataset.id, btn); return; }
    if (e.target.closest('button, a[href], input, select, textarea')) return;
    const row = e.target.closest('.libpage-item[data-id]');
    if (row) playRow(row.dataset.id);
  });
  $('libpage-list').addEventListener('keydown', (e) => {
    const row = e.target.closest('.libpage-item[data-id]');
    if (!row || e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    playRow(row.dataset.id);
  });
}
