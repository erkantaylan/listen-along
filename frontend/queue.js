// Queue management, drag-drop reordering, and queue display
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, sanitizeUrl, getCoverUrl, getInitials, formatDuration, t, toLower, syncRangeFill } from './ui.js';
import { viewedContext } from './playback.js';
import { refreshLibraryAddButtons } from './library.js';
import { player } from './player.js';
import { refreshPlayerBar } from './player-bar.js';
import { bindSongMenu, songMenuButtonHtml, reportIconHtml, reportsFor, onReportsChange } from './song-reports.js';
import { isEditMode, setEditMode, onEditModeChange, isDragging, bindDragReorder } from './queue-edit.js';

// A song marked broken anywhere: the queue's badges follow.
onReportsChange(() => { if (state.lobbyId) updateQueue(); });

// queue:update arrives for the lobby on screen and for the lobby being played
// from (the socket stays in that one); they may be the same lobby.
export function handleQueueUpdated(data) {
  const songs = data.songs || data.queue || [];
  player.updateQueue(data.lobbyId, songs);
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  state.queue = songs;
  updateQueue();
}

export function handleSongAdded(data) {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  state.queue.push(data.song);
  updateQueue();
  showToast(`Added: ${data.song.title}`, 'success');
}

export function addSong() {
  const input = elements.songInput.value.trim();
  if (!input) return;
  socket.emit('queue:add', { lobbyId: state.lobbyId, query: input, addedBy: state.username, userId: state.userId });
  elements.songInput.value = '';
}

// Remove a song (edit mode). Shown gone at once; the toast offers Undo, which
// asks the server to put it back where it was (queue:restore, within a minute).
export function removeSong(index) {
  const song = state.queue[index];
  if (!song) return;
  const lobbyId = state.lobbyId;
  socket.emit('queue:remove', { lobbyId, songId: song.id });
  const next = rowAfter(index);
  state.queue = state.queue.filter((s) => s.id !== song.id);
  updateQueue();
  if (next) focusRow(next.id, '.queue-item-remove');
  showToast(t('queue.removed', `Removed "${song.title}"`, { title: song.title }), 'info', {
    duration: 6000,
    action: { label: t('queue.undo', 'Undo'), onClick: () => socket.emit('queue:restore', { lobbyId, songId: song.id }) },
  });
}

function rowAfter(index) {
  return state.queue[index + 1] || state.queue[index - 1] || null;
}

export function clearQueue() {
  if (!state.queue.length) return;
  socket.emit('queue:clear', { lobbyId: state.lobbyId });
}

// --- Playlist download (to device) ---------------------------------------
// Downloads every queued song to the user's device, ONE AT A TIME. The
// server already has the audio cached on disk, so this just pulls each file
// over; doing it sequentially (await per song) is the concurrency control —
// it never kicks off 100 transfers at once. Files land in the device's
// Downloads folder where apps like VLC can pick them up.

let playlistDownloadActive = false;
let playlistDownloadController = null;

function padNum(n, width) {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

// Make a title safe to use as a filename (client side; the server also sets
// a Content-Disposition fallback for direct hits).
function safeFileName(title) {
  return String(title || 'audio')
    .replace(/[\/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio';
}

function showDownloadProgress(done, total, title) {
  const el = elements.playlistDownloadProgress;
  if (!el) return;
  el.hidden = false;
  if (elements.pdlLabel) elements.pdlLabel.textContent = `Downloading ${done}/${total}: ${title || ''}`.trim();
  if (elements.pdlBarFill) elements.pdlBarFill.style.width = `${Math.round((done / total) * 100)}%`;
}

function hideDownloadProgress() {
  const el = elements.playlistDownloadProgress;
  if (el) el.hidden = true;
  if (elements.pdlBarFill) elements.pdlBarFill.style.width = '0%';
}

export function cancelPlaylistDownload() {
  if (!playlistDownloadActive) return;
  playlistDownloadActive = false;
  if (playlistDownloadController) playlistDownloadController.abort();
}

// File extension for a downloaded song. Library uploads are AAC m4a
// (audio/mp4); only migrated legacy cache files are mp3.
const AUDIO_EXTENSIONS = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
function audioExtension(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[type] || 'm4a';
}

export async function downloadPlaylist() {
  if (playlistDownloadActive) { cancelPlaylistDownload(); return; }

  const songs = (state.queue || []).filter(s => s && s.url);
  if (!songs.length) { showToast('Queue is empty', 'error'); return; }

  playlistDownloadActive = true;
  if (elements.downloadQueueBtn) elements.downloadQueueBtn.classList.add('active');

  const width = String(songs.length).length;
  let ok = 0, failed = 0;

  for (let i = 0; i < songs.length; i++) {
    if (!playlistDownloadActive) break;
    const song = songs[i];
    showDownloadProgress(i, songs.length, song.title);

    playlistDownloadController = new AbortController();
    try {
      const res = await fetch(`/api/stream?q=${encodeURIComponent(song.url)}&dl=1`, {
        credentials: 'include',
        signal: playlistDownloadController.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const ext = audioExtension(blob.type);

      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `${padNum(i + 1, width)} - ${safeFileName(song.title)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      ok++;
    } catch (err) {
      if (err && err.name === 'AbortError') break;
      console.error('Download failed for', song.title, err);
      failed++;
    }
  }

  showDownloadProgress(ok + failed, songs.length, '');
  const wasCancelled = !playlistDownloadActive;
  playlistDownloadActive = false;
  playlistDownloadController = null;
  if (elements.downloadQueueBtn) elements.downloadQueueBtn.classList.remove('active');
  setTimeout(hideDownloadProgress, 1200);

  if (wasCancelled) showToast(`Download cancelled — ${ok} saved`, 'info');
  else if (failed) showToast(`Downloaded ${ok} song${ok !== 1 ? 's' : ''}, ${failed} failed`, failed > ok ? 'error' : 'info');
  else showToast(`Downloaded ${ok} song${ok !== 1 ? 's' : ''} to your device`, 'success');
}

// Move a song (edit mode): applied locally at once, the server's queue:update
// confirms it and tells everyone else.
export function moveSong(fromIndex, toIndex) {
  const song = state.queue[fromIndex];
  if (!song || toIndex < 0 || toIndex >= state.queue.length || toIndex === fromIndex) return;
  socket.emit('queue:reorder', { lobbyId: state.lobbyId, songId: song.id, newIndex: toIndex });
  const songs = [...state.queue];
  songs.splice(fromIndex, 1);
  songs.splice(toIndex, 0, song);
  state.queue = songs;
  updateQueue();
}

export function moveSongUp(index) { moveSong(index, index - 1); }
export function moveSongDown(index) { moveSong(index, index + 1); }

// Playing a song makes this lobby the playback context (if it was not).
// The song already playing from here is resumed if paused, never restarted.
export function playSongAt(index) {
  const song = state.queue[index];
  if (!song) return;
  const ctx = player.context;
  if (ctx && ctx.lobbyId === state.lobbyId && player.track && player.track.id === song.id) {
    if (!player.isPlaying) player.play();
    return;
  }
  player.playFrom(viewedContext(), state.queue, index);
}

function focusRow(songId, selector) {
  const row = elements.queueList.querySelector(`.queue-item[data-song-id="${CSS.escape(songId)}"]`);
  if (!row) return;
  const target = (selector && row.querySelector(selector)) || row;
  target.focus({ preventScroll: false });
}

// Edit mode on/off: header button, toolbar, rows.
function applyEditMode(on) {
  const btn = elements.editQueueBtn;
  if (btn) {
    btn.textContent = on ? t('queue.done', 'Done') : t('queue.edit', 'Edit');
    btn.classList.toggle('btn-solid', on);
    btn.classList.toggle('theme-primary', on);
    btn.classList.toggle('btn', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  elements.queueList.classList.toggle('is-editing', on);
  if (elements.clearQueueBtn) elements.clearQueueBtn.hidden = !on;
  if (elements.queueSortSelect) elements.queueSortSelect.disabled = on;
  updateQueue();
}

export function toggleEditMode() {
  setEditMode(!isEditMode() && state.canEdit);
}

export function exitEditMode() {
  setEditMode(false);
}

// Row interactions. Normal mode: click / tap / Enter / Space plays from that
// song. Edit mode: drag the handle (mouse, touch, pen), or focus the handle
// and press ↑/↓ (Alt+↑/↓ anywhere on the row) to move; Delete removes.
export function setupQueueInteractions() {
  const list = elements.queueList;
  // Right-click / long-press / ⋮ on a queue row: the song menu (song-reports.js).
  bindSongMenu(list, '.queue-item[data-index]', (row) => {
    const song = state.queue[parseInt(row.dataset.index, 10)];
    return song ? { url: song.url, title: song.title } : null;
  });
  onEditModeChange(applyEditMode);
  if (elements.editQueueBtn) {
    elements.editQueueBtn.textContent = t('queue.edit', 'Edit');
    elements.editQueueBtn.addEventListener('click', toggleEditMode);
  }
  if (elements.clearQueueBtn) elements.clearQueueBtn.hidden = true;

  const rowIndex = (row) => parseInt(row.dataset.index, 10);

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.queue-item[data-index]');
    if (!row) return;
    const remove = e.target.closest('.queue-item-remove');
    if (remove) { removeSong(rowIndex(row)); return; }
    // Buttons (⋮, broken report, handle) and links do their own thing.
    if (e.target.closest('button, a[href], input, select, textarea')) return;
    if (isEditMode()) return;
    playSongAt(rowIndex(row));
  });

  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.queue-item[data-index]');
    if (!row) return;
    const index = rowIndex(row);
    const onRow = e.target === row;
    const onHandle = !!e.target.closest('.queue-item-handle');
    if (!isEditMode()) {
      if (onRow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playSongAt(index); }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (onHandle || e.altKey)) {
      e.preventDefault();
      const to = index + (e.key === 'ArrowUp' ? -1 : 1);
      const song = state.queue[index];
      if (!song || to < 0 || to >= state.queue.length) return;
      moveSong(index, to);
      focusRow(song.id, onHandle ? '.queue-item-handle' : null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (onRow || onHandle)) {
      e.preventDefault();
      removeSong(index);
    }
  });

  bindDragReorder(list, {
    rowSelector: '.queue-item[data-index]',
    handleSelector: '.queue-item-handle',
    scroller: list.closest('.lobby-body'),
    onDrop: (fromRow, toRow) => moveSong(rowIndex(fromRow), rowIndex(toRow)),
    onEnd: () => { if (renderPending) updateQueue(); },
  });
}

function getDownloadStatusHtml(downloadInfo) {
  if (!downloadInfo) return { icon: '', badge: '', progressBar: '' };
  const status = downloadInfo.status;
  const percent = downloadInfo.percent || 0;
  let icon = '', badge = '', progressBar = '';
  switch (status) {
    case 'pending': icon = '<span class="queue-item-status pending" title="Pending download">⏳</span>'; badge = '<span class="badge badge-subtle theme-secondary queue-item-badge pending">pending</span>'; break;
    case 'downloading': icon = '<span class="queue-item-status downloading" title="Downloading">📥</span>'; badge = `<span class="badge badge-subtle theme-primary queue-item-badge downloading"><span class="queue-item-percent">${percent}%</span></span>`; progressBar = `<div class="progress queue-item-progress" role="progressbar" aria-label="Download progress"><div class="progress-bar queue-item-progress-bar" style="width: ${percent}%"></div></div>`; break;
    case 'ready': icon = '<span class="queue-item-status ready" title="Ready">✓</span>'; break;
    case 'unavailable': icon = '<span class="queue-item-status unavailable" title="Not in the library yet">⏳</span>'; badge = '<span class="badge badge-subtle theme-warning queue-item-badge pending" title="Not in the library yet — it will play once someone uploads it">not in library</span>'; break;
    case 'error': { const errorMsg = downloadInfo.error || 'Download failed'; icon = `<span class="queue-item-status error" title="${escapeHtml(errorMsg)}">❌</span>`; badge = `<span class="badge badge-subtle theme-danger queue-item-badge error" title="${escapeHtml(errorMsg)}">${escapeHtml(errorMsg)}</span>`; break; }
  }
  return { icon, badge, progressBar };
}

function getListenersForSong(songTitle) {
  return state.listeners.filter(user => user.currentTrack && user.currentTrack.title === songTitle);
}

function getQueueListenersHtml(songTitle) {
  const listeners = getListenersForSong(songTitle);
  if (listeners.length === 0) return '';
  const maxVisible = 3;
  const visible = listeners.slice(0, maxVisible);
  const overflow = listeners.length - maxVisible;
  const avatars = visible.map(user => { const avatar = user.emoji || getInitials(user.username); return `<div class="queue-listener-avatar${user.emoji ? ' emoji' : ''}" title="${escapeHtml(user.username)}">${escapeHtml(avatar)}</div>`; }).join('');
  const overflowBadge = overflow > 0 ? `<div class="queue-listener-avatar overflow" title="${overflow} more">+${overflow}</div>` : '';
  return `<div class="queue-item-listeners">${avatars}${overflowBadge}</div>`;
}

const DRAG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

// A queue:update during a drag waits until the drop.
let renderPending = false;

export function updateQueue() {
  if (isDragging()) { renderPending = true; return; }
  renderPending = false;
  refreshLibraryAddButtons();
  refreshPlayerBar();
  if (state.queue.length === 0) {
    elements.queueList.innerHTML = `<li class="list-group-item app-empty queue-empty"><p class="mb-1">${t('queue.empty', 'Queue is empty')}</p><p class="fs-sm mb-0 hint">${t('queue.emptyHint', 'Add a song to get started')}</p></li>`;
    return;
  }
  const editing = isEditMode();
  const isContextOnScreen = !!player.context && player.context.lobbyId === state.lobbyId;
  const songsWithIndices = state.queue.map((song, index) => ({ song, index }));
  let visibleSongs = state.hideErroredSongs ? songsWithIndices.filter(({ song }) => { const di = state.downloadStatus[song.url]; return !di || di.status !== 'error'; }) : [...songsWithIndices];
  // Edit mode always shows the real order (that is what gets reordered).
  if (!editing && state.queueSort === 'newest') visibleSongs.sort((a, b) => (b.song.addedAt || 0) - (a.song.addedAt || 0));
  else if (!editing && state.queueSort === 'oldest') visibleSongs.sort((a, b) => (a.song.addedAt || 0) - (b.song.addedAt || 0));
  if (visibleSongs.length === 0) { elements.queueList.innerHTML = '<li class="list-group-item app-empty queue-empty"><p class="mb-1">All songs have errors</p><p class="fs-sm mb-0 hint">Uncheck "Hide unplayable songs" to see them</p></li>'; return; }
  // Keep keyboard focus on the same row (and the same handle / button) across re-renders.
  const active = document.activeElement;
  const focusedRow = active && elements.queueList.contains(active) ? active.closest('.queue-item') : null;
  const focusedId = focusedRow ? focusedRow.dataset.songId : null;
  const focusedPart = !focusedRow || active === focusedRow ? null
    : ['.queue-item-handle', '.queue-item-remove', '.song-menu-btn'].find((sel) => active.matches(sel)) || null;
  elements.queueList.innerHTML = visibleSongs.map(({ song, index }) => {
    const thumbUrl = song.id ? getCoverUrl(song.id, song.thumbnail) : sanitizeUrl(song.thumbnail);
    const downloadHtml = getDownloadStatusHtml(state.downloadStatus[song.url]);
    const isPlaying = isContextOnScreen && !!player.track && player.track.id === song.id;
    const title = escapeHtml(song.title);
    const listenersHtml = editing ? '' : getQueueListenersHtml(song.title);
    const handle = editing ? `<button class="btn-text theme-secondary btn-icon btn-sm queue-item-handle" type="button" aria-label="Move ${title} (drag, or press up / down)" title="Drag to reorder (or focus and press ↑ / ↓)">${DRAG_ICON}</button>` : '';
    const remove = editing ? `<button class="btn-text theme-danger btn-icon btn-sm queue-item-remove" type="button" aria-label="Remove ${title}" title="Remove from playlist">${REMOVE_ICON}</button>` : '';
    return `<li class="list-group-item ${editing ? '' : 'list-group-item-action '}queue-item${isPlaying ? ' playing' : ''}" data-index="${index}" data-song-id="${escapeHtml(song.id)}" data-url="${escapeHtml(song.url)}" data-title="${toLower(title)}" tabindex="0"${isPlaying ? ' aria-current="true"' : ''}>`
      + handle
      + `<div class="app-thumb queue-item-thumb">${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="">` : NOTE_ICON}${downloadHtml.icon}</div>`
      + `<div class="queue-item-info"><div class="d-flex align-items-center gap-1 min-w-0"><div class="queue-item-title">${title}</div>${reportIconHtml(reportsFor({ url: song.url }))}</div><div class="queue-item-meta"><span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span>${song.addedBy ? `<span class="queue-item-added-by">${escapeHtml(song.addedBy)}</span>` : ''}${downloadHtml.badge}</div>${downloadHtml.progressBar}</div>`
      + listenersHtml
      + `<div class="queue-item-actions">${remove}${editing ? '' : songMenuButtonHtml(song.title)}</div></li>`;
  }).join('');
  applyQueueFilter();
  if (focusedId && !elements.queueList.contains(document.activeElement)) focusRow(focusedId, focusedPart);
}

// The "Filter songs" box (kept across re-renders).
function applyQueueFilter() {
  const input = document.getElementById('queue-search-input');
  const query = input ? toLower(input.value) : '';
  elements.queueList.querySelectorAll('.queue-item').forEach(el => {
    el.style.display = !query || (el.dataset.title || '').includes(query) ? '' : 'none';
  });
}

export function setupQueueSearch() {
  const searchInput = document.getElementById('queue-search-input');
  if (!searchInput) return;
  searchInput.addEventListener('input', applyQueueFilter);
}

// The playlist header's listener count. Who is listening and what they play
// is the global people panel (social.js).
export function updateListeners() {
  const listenerWord = state.listeners.length !== 1 ? t('lobby.listeners', 'listeners') : t('lobby.listener', 'listener');
  elements.userCount.textContent = `${state.listeners.length} ${listenerWord}`;
}

// Clear the lobby page's lists (switching or leaving a lobby page). The full
// player follows player.js and is left alone.
export function resetLobbyUI() {
  setEditMode(false);
  updateQueue();
  updateListeners();
}

export function openSource(index) {
  const song = state.queue[index];
  if (song && song.url && song.url.startsWith('http')) window.open(song.url, '_blank', 'noopener,noreferrer');
}

export function copySourceUrl(index) {
  const song = state.queue[index];
  if (song && song.url && song.url.startsWith('http')) {
    navigator.clipboard.writeText(song.url).then(() => showToast(t('queue.urlCopied', 'YouTube link copied to clipboard'))).catch(() => showToast(song.url));
  }
}
