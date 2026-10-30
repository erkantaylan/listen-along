// Queue management, drag-drop reordering, and queue display
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, sanitizeUrl, getCoverUrl, getInitials, formatDuration, t, toLower, syncRangeFill } from './ui.js';
import { viewedContext } from './playback.js';
import { refreshLibraryAddButtons } from './library.js';
import { player } from './player.js';
import { refreshPlayerBar } from './player-bar.js';
import { bindSongMenu, songMenuButtonHtml, reportIconHtml, reportsFor, onReportsChange } from './song-reports.js';

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

export function removeSong(index) {
  const song = state.queue[index];
  if (!song) return;
  socket.emit('queue:remove', { lobbyId: state.lobbyId, songId: song.id });
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

export function moveSongUp(index) {
  if (index <= 0) return;
  const song = state.queue[index];
  if (!song) return;
  socket.emit('queue:reorder', { lobbyId: state.lobbyId, songId: song.id, newIndex: index - 1 });
}

export function moveSongDown(index) {
  if (index >= state.queue.length - 1) return;
  const song = state.queue[index];
  if (!song) return;
  socket.emit('queue:reorder', { lobbyId: state.lobbyId, songId: song.id, newIndex: index + 1 });
}

// Playing a song makes this lobby the playback context (if it was not).
export function playSongAt(index) {
  if (!state.queue[index]) return;
  player.playFrom(viewedContext(), state.queue, index);
}

export function setupQueueDragAndDrop() {
  const list = elements.queueList;
  // Right-click / long-press / ⋮ on a queue row: the song menu (song-reports.js).
  bindSongMenu(list, '.queue-item[data-index]', (row) => {
    const song = state.queue[parseInt(row.dataset.index, 10)];
    return song ? { url: song.url, title: song.title } : null;
  });
  let draggedIndex = -1;
  list.addEventListener('dblclick', (e) => { const item = e.target.closest('.queue-item'); if (!item) return; const index = parseInt(item.dataset.index, 10); if (!isNaN(index)) playSongAt(index); });
  list.addEventListener('dragstart', (e) => { const item = e.target.closest('.queue-item'); if (!item) { e.preventDefault(); return; } draggedIndex = parseInt(item.dataset.index, 10); item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(draggedIndex)); requestAnimationFrame(() => item.classList.add('dragging')); });
  list.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const item = e.target.closest('.queue-item'); if (!item || parseInt(item.dataset.index, 10) === draggedIndex) return; list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom')); const rect = item.getBoundingClientRect(); if (e.clientY < rect.top + rect.height / 2) item.classList.add('drag-over-top'); else item.classList.add('drag-over-bottom'); });
  list.addEventListener('dragleave', (e) => { const item = e.target.closest('.queue-item'); if (item) item.classList.remove('drag-over-top', 'drag-over-bottom'); });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.querySelectorAll('.drag-over-top, .drag-over-bottom, .dragging').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging'));
    const targetItem = e.target.closest('.queue-item');
    if (!targetItem) return;
    const targetIndex = parseInt(targetItem.dataset.index, 10);
    if (targetIndex === draggedIndex) return;
    const rect = targetItem.getBoundingClientRect();
    let insertionPoint = e.clientY < rect.top + rect.height / 2 ? targetIndex : targetIndex + 1;
    let newIndex = draggedIndex < insertionPoint ? insertionPoint - 1 : insertionPoint;
    if (newIndex !== draggedIndex && newIndex >= 0) {
      const song = state.queue[draggedIndex];
      if (song) socket.emit('queue:reorder', { lobbyId: state.lobbyId, songId: song.id, newIndex });
    }
    draggedIndex = -1;
  });
  list.addEventListener('dragend', () => { list.querySelectorAll('.drag-over-top, .drag-over-bottom, .dragging').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging')); draggedIndex = -1; });
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

export function updateQueue() {
  refreshLibraryAddButtons();
  refreshPlayerBar();
  if (state.queue.length === 0) {
    elements.queueList.innerHTML = `<li class="list-group-item app-empty queue-empty"><p class="mb-1">${t('queue.empty', 'Queue is empty')}</p><p class="fs-sm mb-0 hint">${t('queue.emptyHint', 'Add a song to get started')}</p></li>`;
    return;
  }
  const isContextOnScreen = !!player.context && player.context.lobbyId === state.lobbyId;
  const songsWithIndices = state.queue.map((song, index) => ({ song, index }));
  let visibleSongs = state.hideErroredSongs ? songsWithIndices.filter(({ song }) => { const di = state.downloadStatus[song.url]; return !di || di.status !== 'error'; }) : [...songsWithIndices];
  if (state.queueSort === 'newest') visibleSongs.sort((a, b) => (b.song.addedAt || 0) - (a.song.addedAt || 0));
  else if (state.queueSort === 'oldest') visibleSongs.sort((a, b) => (a.song.addedAt || 0) - (b.song.addedAt || 0));
  if (visibleSongs.length === 0) { elements.queueList.innerHTML = '<li class="list-group-item app-empty queue-empty"><p class="mb-1">All songs have errors</p><p class="fs-sm mb-0 hint">Uncheck "Hide unplayable songs" to see them</p></li>'; return; }
  elements.queueList.innerHTML = visibleSongs.map(({ song, index }) => {
    const thumbUrl = song.id ? getCoverUrl(song.id, song.thumbnail) : sanitizeUrl(song.thumbnail);
    const downloadHtml = getDownloadStatusHtml(state.downloadStatus[song.url]);
    const isPlaying = isContextOnScreen && !!player.track && player.track.id === song.id;
    const canMoveUp = index > 0, canMoveDown = index < state.queue.length - 1;
    const listenersHtml = getQueueListenersHtml(song.title);
    return `<li class="list-group-item queue-item ${isPlaying ? 'playing' : ''}" data-index="${index}" data-url="${escapeHtml(song.url)}" data-title="${toLower(escapeHtml(song.title))}" draggable="true"><div class="queue-item-drag-handle" title="Drag to reorder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></div><div class="app-thumb queue-item-thumb">${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="">` : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>'}${downloadHtml.icon}</div><div class="queue-item-info"><div class="d-flex align-items-center gap-1 min-w-0"><div class="queue-item-title">${escapeHtml(song.title)}</div>${reportIconHtml(reportsFor({ url: song.url }))}</div><div class="queue-item-meta"><span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span>${song.addedBy ? `<span class="queue-item-added-by">${escapeHtml(song.addedBy)}</span>` : ''}${downloadHtml.badge}</div>${downloadHtml.progressBar}</div>${listenersHtml}<div class="queue-item-actions"><div class="queue-item-reorder"><button class="btn-text theme-secondary btn-icon btn-xs queue-item-up" aria-label="Move up" title="Move up" onclick="window.app.moveSongUp(${index})" ${!canMoveUp ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button><button class="btn-text theme-secondary btn-icon btn-xs queue-item-down" aria-label="Move down" title="Move down" onclick="window.app.moveSongDown(${index})" ${!canMoveDown ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button></div>${song.url && song.url.startsWith('http') ? `<button class="btn-text theme-secondary btn-icon btn-sm queue-item-youtube" aria-label="Open on YouTube" title="Open on YouTube" onclick="window.app.openSource(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg></button>` : ''}<button class="btn-text theme-secondary btn-icon btn-sm queue-item-play" aria-label="Play" title="Play" onclick="window.app.playSongAt(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><button class="btn-text theme-secondary btn-icon btn-sm queue-item-remove" aria-label="Remove from queue" title="Remove from queue" onclick="window.app.removeSong(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>${songMenuButtonHtml(song.title)}</div></li>`;
  }).join('');
}

export function setupQueueSearch() {
  const searchInput = document.getElementById('queue-search-input');
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const query = toLower(searchInput.value);
    elements.queueList.querySelectorAll('.queue-item').forEach(el => {
      el.style.display = (el.dataset.title || '').includes(query) ? '' : 'none';
    });
  });
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
