// Music library page: every song in the library (searchable, with uploader)
// plus the list of song requests waiting for an upload. Songs are added to the
// current lobby's queue from here.
import { state, socket } from './state.js';
import { showToast, formatDuration } from './ui.js';

// Escapes for both text and attribute contexts (ui.js escapeHtml leaves quotes).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PAGE_SIZE = 50;

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

// --- Preview ----------------------------------------------------------------
// One shared <audio> for listening to a library song without a lobby; starting
// another preview replaces the current one.

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

const preview = { audio: null, songId: null };

function previewPlaying(songId) {
  return preview.songId === songId && preview.audio && !preview.audio.paused;
}

function previewButtonHtml(songId) {
  const playing = previewPlaying(songId);
  return `<button class="btn-icon libpage-preview${playing ? ' playing' : ''}" data-id="${escapeHtml(songId)}" type="button" aria-label="${playing ? 'Pause preview' : 'Play preview'}" title="${playing ? 'Pause' : 'Preview'}">${playing ? PAUSE_ICON : PLAY_ICON}</button>`;
}

function updatePreviewButtons() {
  document.querySelectorAll('.libpage-preview').forEach((btn) => {
    const playing = previewPlaying(btn.dataset.id);
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    btn.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    btn.title = playing ? 'Pause' : 'Preview';
  });
}

function togglePreview(songId) {
  if (!preview.audio) {
    preview.audio = new Audio();
    preview.audio.preload = 'none';
    ['play', 'pause', 'ended'].forEach((ev) => preview.audio.addEventListener(ev, updatePreviewButtons));
    preview.audio.addEventListener('error', () => {
      if (!preview.songId) return;
      showToast('Could not play this song', 'error');
      preview.songId = null;
      updatePreviewButtons();
    });
  }
  if (preview.songId === songId) {
    if (preview.audio.paused) preview.audio.play().catch(() => {});
    else preview.audio.pause();
    return;
  }
  preview.songId = songId;
  preview.audio.src = `/api/library/${encodeURIComponent(songId)}/file`;
  preview.audio.play().catch(() => {});
  updatePreviewButtons();
}

function stopPreview() {
  if (!preview.audio) return;
  preview.songId = null;
  preview.audio.pause();
  preview.audio.removeAttribute('src');
  preview.audio.load();
  updatePreviewButtons();
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
    return `<img class="libpage-thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/default.jpg" alt="" loading="lazy">`;
  }
  return '<div class="libpage-thumb libpage-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
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
    el.textContent = 'Join a lobby to add songs to its queue';
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
  if (!state.lobbyId) btn.title = 'Join a lobby first';
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
    list.innerHTML = `<li class="libpage-empty">${lib.loading ? 'Loading…' : (lib.query ? 'No songs match your search' : 'The library is empty. Songs appear here once they are uploaded.')}</li>`;
  } else {
    list.innerHTML = lib.songs.map((song) => {
      const sub = [song.artist, song.album].filter(Boolean).map(escapeHtml).join(' · ');
      const meta = [
        song.duration_sec ? formatDuration(song.duration_sec) : '',
        `added by ${escapeHtml(song.uploaded_by || 'unknown')}`,
        relativeDate(song.created_at),
        sourceLinkHtml(song),
      ].filter(Boolean).join(' · ');
      return `<li class="libpage-item" data-id="${escapeHtml(song.id)}">
        ${thumbHtml(song.youtube_id)}
        <div class="libpage-info">
          <div class="libpage-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
          <div class="libpage-sub">${sub}</div>
          <div class="libpage-meta">${meta}</div>
        </div>
        ${previewButtonHtml(song.id)}
        <button class="btn btn-small btn-primary libpage-add" data-id="${escapeHtml(song.id)}">Add</button>
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

function renderPager() {
  const pager = $('libpage-pager');
  if (!pager) return;
  const count = pageCount();
  if (lib.total <= PAGE_SIZE) { pager.hidden = true; pager.innerHTML = ''; return; }
  pager.hidden = false;
  const p = lib.page;
  const from = p * PAGE_SIZE + 1;
  const to = Math.min(lib.total, (p + 1) * PAGE_SIZE);
  const btn = (page, label, { current = false, disabled = false, aria = '' } = {}) =>
    `<button class="libpage-page${current ? ' current' : ''}" type="button" data-page="${page}"${disabled ? ' disabled' : ''}${current ? ' aria-current="page"' : ''}${aria ? ` aria-label="${aria}"` : ''}>${label}</button>`;
  pager.innerHTML = `
    <div class="libpage-pages">
      ${btn(p - 1, '‹', { disabled: p === 0, aria: 'Previous page' })}
      ${pageItems(p, count).map((i) => (i === null ? '<span class="libpage-gap">…</span>' : btn(i, i + 1, { current: i === p, aria: `Page ${i + 1}` }))).join('')}
      ${btn(p + 1, '›', { disabled: p >= count - 1, aria: 'Next page' })}
    </div>
    <span class="libpage-range">${from.toLocaleString()}–${to.toLocaleString()} of ${lib.total.toLocaleString()}</span>`;
}

function goToPage(page) {
  if (page < 0 || page >= pageCount() || page === lib.page) return;
  loadSongs({ page });
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
  if (!state.lobbyId) { showToast('Join a lobby first', 'error'); return; }
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

function statusBadge(status) {
  const label = { pending: 'waiting', fulfilled: 'uploaded', dismissed: 'not found' }[status] || status;
  return `<span class="libpage-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
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
      list.innerHTML = `<li class="libpage-empty">${lib.requestStatus === 'pending' ? 'No songs are waiting. Anything you queue that is not in the library shows up here.' : 'Nothing here yet.'}</li>`;
      return;
    }
    list.innerHTML = requests.map((r) => {
      const title = r.title || r.youtube_id || r.url || 'Unknown song';
      const sub = [r.artist, r.youtube_id ? `YouTube ${r.youtube_id}` : (r.url || '')].filter(Boolean).map(escapeHtml).join(' · ');
      const link = r.youtube_id ? `https://www.youtube.com/watch?v=${encodeURIComponent(r.youtube_id)}` : (r.url && /^https?:\/\//.test(r.url) ? r.url : null);
      return `<li class="libpage-item">
        ${thumbHtml(r.youtube_id)}
        <div class="libpage-info">
          <div class="libpage-title" title="${escapeHtml(title)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</div>
          <div class="libpage-sub">${sub}</div>
          <div class="libpage-meta">requested by ${escapeHtml(r.requested_by)} · ${relativeDate(r.created_at)}</div>
        </div>
        ${statusBadge(r.status)}
      </li>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<li class="libpage-empty">Could not load requests: ${escapeHtml(err.message)}</li>`;
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
  updateContext();
  switchTab(tab);
  loadSongs();
  refreshRequestCount();
  const search = $('libpage-search');
  if (search && tab === 'library' && window.matchMedia('(pointer: fine)').matches) search.focus();
}

export function closeLibraryPage() {
  const page = $('library-page');
  if (!page) return;
  lib.open = false;
  stopPreview();
  page.hidden = true;
  document.body.classList.remove('libpage-open');
}

export function handleLibraryUpdated() {
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
  $('libpage-close').addEventListener('click', closeLibraryPage);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lib.open) closeLibraryPage(); });
  page.querySelectorAll('.libpage-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.libtab)));
  $('libpage-search').addEventListener('input', (e) => {
    clearTimeout(lib.searchTimer);
    lib.searchTimer = setTimeout(() => { lib.query = e.target.value.trim(); loadSongs(); }, 250);
  });
  $('libpage-sort').addEventListener('change', (e) => { lib.sort = e.target.value; loadSongs(); });
  $('libpage-pager').addEventListener('click', (e) => {
    const btn = e.target.closest('.libpage-page');
    if (btn && !btn.disabled) goToPage(Number(btn.dataset.page));
  });
  $('libpage-request-status').addEventListener('change', (e) => { lib.requestStatus = e.target.value; loadRequests(); });
  $('libpage-list').addEventListener('click', (e) => {
    const play = e.target.closest('.libpage-preview');
    if (play) { togglePreview(play.dataset.id); return; }
    const btn = e.target.closest('.libpage-add');
    if (btn) addToQueue(btn.dataset.id, btn);
  });
}
