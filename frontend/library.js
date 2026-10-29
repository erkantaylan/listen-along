// Music library page: every song in the library (searchable, with uploader)
// plus the list of song requests waiting for an upload. Songs are added to the
// current lobby's queue from here.
import { state, socket } from './state.js';
import { showToast, formatDuration } from './ui.js';

// Escapes for both text and attribute contexts (ui.js escapeHtml leaves quotes).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PAGE_SIZE = 200;

const lib = {
  open: false,
  tab: 'library',
  songs: [],
  total: 0,
  loading: false,
  query: '',
  sort: 'recent',
  requestStatus: 'pending',
  searchTimer: null,
  loadSeq: 0,
};

const $ = (id) => document.getElementById(id);

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

function renderSongs() {
  const list = $('libpage-list');
  if (!list) return;
  const count = $('libpage-count');
  if (count) count.textContent = lib.total ? String(lib.total) : '';
  if (!lib.songs.length) {
    list.innerHTML = `<li class="libpage-empty">${lib.loading ? 'Loading…' : (lib.query ? 'No songs match your search' : 'The library is empty. Songs appear here once they are uploaded.')}</li>`;
  } else {
    const canAdd = !!state.lobbyId;
    list.innerHTML = lib.songs.map((song) => {
      const sub = [song.artist, song.album].filter(Boolean).map(escapeHtml).join(' · ');
      const meta = [
        song.duration_sec ? formatDuration(song.duration_sec) : '',
        `added by ${escapeHtml(song.uploaded_by || 'unknown')}`,
        relativeDate(song.created_at),
      ].filter(Boolean).join(' · ');
      return `<li class="libpage-item" data-id="${escapeHtml(song.id)}">
        ${thumbHtml(song.youtube_id)}
        <div class="libpage-info">
          <div class="libpage-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
          <div class="libpage-sub">${sub}</div>
          <div class="libpage-meta">${meta}</div>
        </div>
        <button class="btn btn-small btn-primary libpage-add" data-id="${escapeHtml(song.id)}" ${canAdd ? '' : 'disabled title="Join a lobby first"'}>Add</button>
      </li>`;
    }).join('');
  }
  const more = $('libpage-more');
  if (more) more.hidden = lib.songs.length >= lib.total;
}

async function loadSongs({ append = false } = {}) {
  const seq = ++lib.loadSeq;
  lib.loading = true;
  if (!append) { lib.songs = []; renderSongs(); }
  const params = new URLSearchParams({
    q: lib.query,
    sort: lib.sort,
    limit: String(PAGE_SIZE),
    offset: String(append ? lib.songs.length : 0),
  });
  try {
    const res = await fetch(`/api/library?${params}`);
    const data = await res.json();
    if (seq !== lib.loadSeq) return; // a newer search superseded this one
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lib.songs = append ? lib.songs.concat(data.songs) : data.songs;
    lib.total = data.total;
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
  if (btn) {
    btn.textContent = 'Added';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = 'Add'; btn.disabled = !state.lobbyId; }, 2000);
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
  page.hidden = true;
  document.body.classList.remove('libpage-open');
}

export function handleLibraryUpdated() {
  if (lib.open) loadSongs();
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
  $('libpage-more').addEventListener('click', () => loadSongs({ append: true }));
  $('libpage-request-status').addEventListener('change', (e) => { lib.requestStatus = e.target.value; loadRequests(); });
  $('libpage-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.libpage-add');
    if (btn) addToQueue(btn.dataset.id, btn);
  });
}
