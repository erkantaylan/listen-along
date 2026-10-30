// Music library page: every song in the library (searchable, with uploader)
// plus the list of song requests waiting for an upload. Songs are added to the
// current lobby's queue from here.
import { state, socket } from './state.js';
import { showToast, formatDuration, notifyViewChange } from './ui.js';
import { libraryPath, basePath } from './router.js';
import { player } from './player.js';

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
function libraryTrack(song) {
  return {
    libraryId: song.id,
    url: `library:${song.id}`,
    // The file version makes the url change when the audio is replaced.
    src: `/api/library/${encodeURIComponent(song.id)}/file${song.file_version ? `?v=${encodeURIComponent(song.file_version)}` : ''}`,
    title: song.title,
    artist: song.artist || '',
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

// Small "source" link to where the song originally came from (e.g. YouTube).
// Only http(s) links are rendered; anything else is dropped.
function sourceLinkHtml(song) {
  const url = song.source_url || (song.youtube_id ? `https://www.youtube.com/watch?v=${encodeURIComponent(song.youtube_id)}` : null);
  if (!url || !/^https?:\/\//i.test(url)) return '';
  let label = 'source';
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, '');
    label = host === 'youtube.com' || host === 'youtu.be' ? 'YouTube' : host;
  } catch { return ''; }
  return `<a class="libpage-source" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(label)} ↗</a>`;
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
  if (count) count.textContent = lib.total ? String(lib.total) : '';
  if (!lib.songs.length) {
    list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${lib.loading ? 'Loading…' : (lib.query ? 'No songs match your search' : 'The library is empty. Songs appear here once they are uploaded.')}</li>`;
  } else {
    list.innerHTML = lib.songs.map((song) => {
      const sub = [song.artist, song.album].filter(Boolean).map(escapeHtml).join(' · ');
      const meta = [
        song.duration_sec ? formatDuration(song.duration_sec) : '',
        `added by ${escapeHtml(song.uploaded_by || 'unknown')}`,
        relativeDate(song.created_at),
        sourceLinkHtml(song),
      ].filter(Boolean).join(' · ');
      return `<li class="list-group-item libpage-item${isCurrentSong(song.id) ? ' is-playing' : ''}" data-id="${escapeHtml(song.id)}">
        ${thumbHtml(song.youtube_id)}
        <div class="libpage-info min-w-0">
          <div class="fw-medium text-truncate libpage-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
          <div class="fs-sm fg-2 text-truncate libpage-sub">${sub}</div>
          <div class="fs-xs fg-3 libpage-meta">${meta}</div>
        </div>
        ${playButtonHtml(song.id)}
        <button class="btn-text theme-secondary btn-icon btn-sm libpage-replace" type="button" data-id="${escapeHtml(song.id)}" aria-label="Replace audio of ${escapeHtml(song.title)}" title="Replace audio…">${REPLACE_ICON}</button>
        <button class="btn-solid theme-primary btn-sm libpage-add" type="button" data-id="${escapeHtml(song.id)}">Add</button>
      </li>`;
    }).join('');
    const keys = queuedKeys();
    list.querySelectorAll('.libpage-add').forEach((btn, i) => setAddButton(btn, lib.songs[i], keys));
  }
  renderPager();
}

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
          <div class="fw-medium text-truncate libpage-title" title="${escapeHtml(title)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</div>
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
  if (!wasOpen || route.tab !== lib.tab || (route.tab === 'requests' && requestsChanged)) switchTab(route.tab);
  if (songsChanged) loadSongs({ page: route.page });
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

function switchTab(tab) {
  lib.tab = tab;
  document.querySelectorAll('#library-page .libpage-tab').forEach((b) => b.classList.toggle('active', b.dataset.libtab === tab));
  $('libpage-songs-panel').hidden = tab !== 'library';
  $('libpage-requests-panel').hidden = tab !== 'requests';
  if (tab === 'requests') loadRequests();
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
}

export function closeLibraryPage() {
  const page = $('library-page');
  if (!page) return;
  lib.open = false;
  page.hidden = true;
  document.body.classList.remove('libpage-open');
  notifyViewChange();
}

// payload.replaced: a song's audio was replaced (same id). Whatever is
// playing it reloads the new file at the same position (player.js).
export function handleLibraryUpdated(payload) {
  if (payload && payload.replaced) player.reloadReplaced(payload.replaced, payload.song);
  if (lib.open) loadSongs({ page: lib.page, refresh: true });
}

// --- Replace --------------------------------------------------------------
// Fix a wrongly uploaded song: upload another m4a file for it. The song keeps
// its id, so every playlist holding it plays the new file. Any approved user
// may do it; the server keeps an audit trail (POST /api/library/:id/replace).

function closeReplaceDialog() {
  const d = $('replace-dialog');
  if (d) d.remove();
}

function openReplaceDialog(songId) {
  const song = lib.songs.find((s) => s.id === songId);
  if (!song) return;
  closeReplaceDialog();
  const source = song.source_url || (song.youtube_id ? `https://www.youtube.com/watch?v=${song.youtube_id}` : '');
  const dialog = document.createElement('div');
  dialog.id = 'replace-dialog';
  dialog.className = 'app-modal replace-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'replace-title');
  dialog.innerHTML = `<form class="card app-modal-card replace-form" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="replace-title" class="h6 mb-0 text-truncate">Replace audio</h2>
      <button class="btn-text theme-secondary btn-icon btn-sm replace-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <div class="card-body vstack gap-4">
      <p class="fs-sm fg-3 mb-0">Upload the right file for <span class="fg-2">${escapeHtml(song.title)}${song.artist ? ` — ${escapeHtml(song.artist)}` : ''}</span>. Every playlist with this song plays the new file; the change is logged.</p>
      <div><label class="form-label" for="replace-file">Audio file (.m4a, AAC)</label>
        <input class="form-control" type="file" id="replace-file" accept=".m4a,audio/mp4" required></div>
      <div><label class="form-label" for="replace-song-title">Title</label>
        <input class="form-control" id="replace-song-title" maxlength="300" required value="${escapeHtml(song.title)}"></div>
      <div><label class="form-label" for="replace-artist">Artist</label>
        <input class="form-control" id="replace-artist" maxlength="300" required value="${escapeHtml(song.artist || '')}"></div>
      <div><label class="form-label" for="replace-album">Album <span class="fg-3">(optional)</span></label>
        <input class="form-control" id="replace-album" maxlength="300" value="${escapeHtml(song.album || '')}"></div>
      <div><label class="form-label" for="replace-source">Source link <span class="fg-3">(optional, e.g. the YouTube video)</span></label>
        <input class="form-control" id="replace-source" type="url" maxlength="2048" value="${escapeHtml(source)}" placeholder="https://www.youtube.com/watch?v=…"></div>
      <div class="alert theme-danger fs-sm mb-0 replace-error" role="alert" hidden></div>
    </div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn replace-cancel" type="button">Cancel</button>
      <button class="btn-solid theme-primary replace-submit" type="submit">Replace</button>
    </div>
  </form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector('form');
  const err = dialog.querySelector('.replace-error');
  const showError = (msg) => { err.textContent = msg; err.hidden = false; };
  dialog.querySelector('.replace-close').addEventListener('click', closeReplaceDialog);
  dialog.querySelector('.replace-cancel').addEventListener('click', closeReplaceDialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeReplaceDialog(); });
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeReplaceDialog(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const file = $('replace-file').files[0];
    const title = $('replace-song-title').value.trim();
    const artist = $('replace-artist').value.trim();
    const link = $('replace-source').value.trim();
    if (!file) return showError('Choose an .m4a file.');
    if (!/\.m4a$/i.test(file.name)) return showError('Only .m4a (AAC) files are accepted.');
    if (!title || !artist) return showError('Title and artist are required.');
    if (link && !/^https?:\/\//i.test(link)) return showError('The source link must start with http:// or https://');
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('title', title);
    fd.append('artist', artist);
    const album = $('replace-album').value.trim();
    if (album) fd.append('album', album);
    if (link) {
      fd.append('source_url', link);
      const yt = youtubeIdFromUrl(link);
      if (yt) fd.append('youtube_id', yt);
    }
    const submit = dialog.querySelector('.replace-submit');
    submit.disabled = true;
    submit.textContent = 'Uploading…';
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(song.id)}/replace`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const other = data.song && data.song.id !== song.id ? ` (“${data.song.title}”${data.song.artist ? ` by ${data.song.artist}` : ''})` : '';
        throw new Error((data.error || `HTTP ${res.status}`) + other);
      }
      closeReplaceDialog();
      showToast(`Replaced the audio of “${data.song.title}”`, 'success');
      if (lib.open) loadSongs({ page: lib.page, refresh: true });
    } catch (ex) {
      showError(`Could not replace: ${ex.message}`);
      submit.disabled = false;
      submit.textContent = 'Replace';
    }
  });
  $('replace-file').focus();
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lib.open && !$('replace-dialog')) requestCloseLibrary(); });
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
    if (replace) { openReplaceDialog(replace.dataset.id); return; }
    const btn = e.target.closest('.libpage-add');
    if (btn) addToQueue(btn.dataset.id, btn);
  });
}
