// Queue management, drag-drop reordering, and queue display
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, sanitizeUrl, getCoverUrl, getInitials, formatDuration, t, toLower } from './ui.js';
import { stopFollowing, playLocalTrack, updatePlayButton, updatePlaybackModeUI, updateModeButton } from './playback.js';

export function handleQueueUpdated(data) {
  state.queue = data.songs || data.queue || [];
  if (data.currentIndex !== undefined) state.queueCurrentIndex = data.currentIndex;
  updateQueue();
}

export function handleSongAdded(data) {
  state.queue.push(data.song);
  updateQueue();
  showToast(`Added: ${data.song.title}`, 'success');
}

export function addSong() {
  const input = elements.songInput.value.trim();
  if (!input) return;
  socket.emit('queue:add', { lobbyId: state.lobbyId, query: input, addedBy: state.username });
  elements.songInput.value = '';
}

export function showLibraryDialog() {
  var existing = document.getElementById('library-dialog');
  if (existing) existing.remove();
  var dialog = document.createElement('div');
  dialog.id = 'library-dialog';
  dialog.className = 'share-overlay';
  dialog.innerHTML = '<div class="library-dialog"><div class="library-dialog-header"><h3>Browse Library</h3><button class="btn-icon share-close-btn" id="library-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div><input type="text" class="library-search" id="library-search" placeholder="Search songs..." autocomplete="off"><div class="library-list" id="library-list"><div class="library-loading">Loading...</div></div></div>';
  document.body.appendChild(dialog);
  document.getElementById('library-close-btn').addEventListener('click', function() { dialog.remove(); });
  dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.remove(); });
  fetch('/api/library').then(function(res) { return res.json(); }).then(function(data) {
    var songs = data.songs || [];
    var listEl = document.getElementById('library-list');
    var searchEl = document.getElementById('library-search');
    function renderLibrary() {
      var q = searchEl.value.toLocaleLowerCase('tr');
      var filtered = q ? songs.filter(function(s) { return (s.title || '').toLocaleLowerCase('tr').includes(q); }) : songs;
      if (filtered.length === 0) { listEl.innerHTML = '<div class="library-empty">No songs found</div>'; return; }
      listEl.innerHTML = filtered.map(function(song) {
        var dur = formatDuration(song.duration);
        var thumb = song.thumbnail_url ? '<img class="library-thumb" src="' + escapeHtml(song.thumbnail_url) + '" alt="">' : '<div class="library-thumb-placeholder"></div>';
        return '<div class="library-item" data-url="' + escapeHtml(song.url) + '" data-title="' + escapeHtml(song.title) + '" data-duration="' + (song.duration || 0) + '" data-thumbnail="' + escapeHtml(song.thumbnail_url || '') + '">' + thumb + '<div class="library-item-info"><div class="library-item-title">' + escapeHtml(song.title) + '</div><div class="library-item-meta">' + dur + '</div></div><button class="btn btn-small btn-primary library-add-btn">Add</button></div>';
      }).join('');
    }
    renderLibrary();
    searchEl.addEventListener('input', renderLibrary);
    listEl.addEventListener('click', function(e) {
      var btn = e.target.closest('.library-add-btn');
      if (!btn) return;
      var item = btn.closest('.library-item');
      if (!item) return;
      socket.emit('queue:add', { lobbyId: state.lobbyId, url: item.dataset.url, title: item.dataset.title, duration: parseFloat(item.dataset.duration) || 0, thumbnail: item.dataset.thumbnail || undefined, addedBy: state.username });
      btn.textContent = 'Added'; btn.disabled = true;
      setTimeout(function() { btn.textContent = 'Add'; btn.disabled = false; }, 2000);
    });
  }).catch(function() { document.getElementById('library-list').innerHTML = '<div class="library-empty">Failed to load library</div>'; });
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

export function playSongAt(index) {
  const song = state.queue[index];
  if (!song) return;
  if (state.listeningMode === 'independent') {
    if (state.followingSocketId) stopFollowing();
    playLocalTrack(song);
    return;
  }
  socket.emit('queue:play-at', { lobbyId: state.lobbyId, index });
}

export function setupQueueDragAndDrop() {
  const list = elements.queueList;
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
    case 'pending': icon = '<span class="queue-item-status pending" title="Pending download">⏳</span>'; badge = '<span class="queue-item-badge pending">pending</span>'; break;
    case 'downloading': icon = '<span class="queue-item-status downloading" title="Downloading">📥</span>'; badge = `<span class="queue-item-badge downloading"><span class="queue-item-percent">${percent}%</span></span>`; progressBar = `<div class="queue-item-progress"><div class="queue-item-progress-bar" style="width: ${percent}%"></div></div>`; break;
    case 'ready': icon = '<span class="queue-item-status ready" title="Ready">✓</span>'; break;
    case 'error': { const errorMsg = downloadInfo.error || 'Download failed'; icon = `<span class="queue-item-status error" title="${escapeHtml(errorMsg)}">❌</span>`; badge = `<span class="queue-item-badge error" title="${escapeHtml(errorMsg)}">${escapeHtml(errorMsg)}</span>`; break; }
  }
  return { icon, badge, progressBar };
}

function getListenersForSong(songTitle) {
  if (state.listeningMode !== 'independent') return [];
  return state.listeners.filter(user => user.mode === 'listening' && user.currentTrack && user.currentTrack.title === songTitle);
}

function getQueueListenersHtml(songTitle) {
  const listeners = getListenersForSong(songTitle);
  if (listeners.length === 0) return '';
  const maxVisible = 3;
  const visible = listeners.slice(0, maxVisible);
  const overflow = listeners.length - maxVisible;
  const avatars = visible.map(user => { const avatar = user.emoji || getInitials(user.username); return `<div class="queue-listener-avatar${user.emoji ? ' emoji' : ''}" title="${escapeHtml(user.username)}">${avatar}</div>`; }).join('');
  const overflowBadge = overflow > 0 ? `<div class="queue-listener-avatar overflow" title="${overflow} more">+${overflow}</div>` : '';
  return `<div class="queue-item-listeners">${avatars}${overflowBadge}</div>`;
}

export function updateQueue() {
  if (state.queue.length === 0) {
    elements.queueList.innerHTML = `<li class="queue-empty"><p>${t('queue.empty', 'Queue is empty')}</p><p class="hint">${t('queue.emptyHint', 'Add a song to get started')}</p></li>`;
    return;
  }
  const songsWithIndices = state.queue.map((song, index) => ({ song, index }));
  let visibleSongs = state.hideErroredSongs ? songsWithIndices.filter(({ song }) => { const di = state.downloadStatus[song.url]; return !di || di.status !== 'error'; }) : [...songsWithIndices];
  if (state.queueSort === 'newest') visibleSongs.sort((a, b) => (b.song.addedAt || 0) - (a.song.addedAt || 0));
  else if (state.queueSort === 'oldest') visibleSongs.sort((a, b) => (a.song.addedAt || 0) - (b.song.addedAt || 0));
  if (visibleSongs.length === 0) { elements.queueList.innerHTML = '<li class="queue-empty"><p>All songs have errors</p><p class="hint">Uncheck "Hide errored songs" to see them</p></li>'; return; }
  const isJamMode = state.listeningMode === 'synchronized';
  const curIdx = state.queueCurrentIndex;
  elements.queueList.innerHTML = visibleSongs.map(({ song, index }) => {
    const thumbUrl = song.id ? getCoverUrl(song.id, song.thumbnail) : sanitizeUrl(song.thumbnail);
    const downloadHtml = getDownloadStatusHtml(state.downloadStatus[song.url]);
    const isPlaying = state.currentTrack && state.currentTrack.id === song.id;
    const canMoveUp = index > 0, canMoveDown = index < state.queue.length - 1;
    const listenersHtml = getQueueListenersHtml(song.title);
    let positionClass = '';
    if (isJamMode && curIdx >= 0) { if (index === curIdx) positionClass = 'now-playing'; else if (index < curIdx) positionClass = 'played'; }
    return `<li class="queue-item ${isPlaying ? 'playing' : ''} ${positionClass}" data-index="${index}" data-url="${escapeHtml(song.url)}" data-title="${toLower(escapeHtml(song.title))}" draggable="true"><div class="queue-item-drag-handle" title="Drag to reorder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></div><div class="queue-item-thumb">${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}${downloadHtml.icon}</div><div class="queue-item-info"><div class="queue-item-title">${escapeHtml(song.title)}</div><div class="queue-item-meta"><span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span>${song.addedBy ? `<span class="queue-item-added-by">${escapeHtml(song.addedBy)}</span>` : ''}${downloadHtml.badge}</div>${downloadHtml.progressBar}</div>${listenersHtml}<div class="queue-item-actions"><div class="queue-item-reorder"><button class="btn-icon-small queue-item-up" aria-label="Move up" onclick="window.app.moveSongUp(${index})" ${!canMoveUp ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button><button class="btn-icon-small queue-item-down" aria-label="Move down" onclick="window.app.moveSongDown(${index})" ${!canMoveDown ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button></div>${song.url && song.url.startsWith('http') ? `<button class="btn-icon queue-item-youtube" aria-label="Open on YouTube" title="Open on YouTube" onclick="window.app.openSource(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg></button>` : ''}<button class="btn-icon queue-item-play" aria-label="Play" onclick="window.app.playSongAt(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><button class="btn-icon queue-item-remove" aria-label="Remove from queue" onclick="window.app.removeSong(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div></li>`;
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

export function updateListeners() {
  const listenerWord = state.listeners.length !== 1 ? t('lobby.listeners', 'listeners') : t('lobby.listener', 'listener');
  elements.userCount.textContent = `${state.listeners.length} ${listenerWord}`;
  if (state.listeners.length === 0) {
    elements.listenersList.innerHTML = `<li class="listener-empty"><p>${t('listeners.noListeners', 'No one else is here yet')}</p><p class="hint">${t('listeners.shareHint', 'Share the lobby link to invite friends')}</p></li>`;
    return;
  }
  elements.listenersList.innerHTML = state.listeners.map(user => {
    const modeIcon = user.mode === 'lobby' ? '<svg class="mode-icon lobby" viewBox="0 0 24 24" fill="currentColor" title="Lobby mode"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>' : '<svg class="mode-icon listening" viewBox="0 0 24 24" fill="currentColor" title="Listening"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg>';
    const avatar = user.emoji || getInitials(user.username);
    let nowListening = '';
    if (user.mode === 'listening') {
      const track = (state.listeningMode === 'independent') ? user.currentTrack : state.currentTrack;
      if (track && track.title) nowListening = `<span class="listener-track">${escapeHtml(track.title)}</span>`;
    }
    let followBtn = '';
    if (state.listeningMode === 'independent' && user.socketId !== socket.id && user.mode === 'listening') {
      const isFollowing = state.followingSocketId === user.socketId;
      followBtn = isFollowing
        ? `<button class="follow-btn following" data-socket-id="${user.socketId}" title="${t('follow.stopFollowing', 'Stop following')}"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg></button>`
        : `<button class="follow-btn" data-socket-id="${user.socketId}" title="${t('follow.followUser', 'Follow')}"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg></button>`;
    }
    const followingBadge = (state.followingSocketId === user.socketId) ? `<span class="listener-badge following">${t('follow.following', 'Following')}</span>` : '';
    return `<li class="listener-item ${user.mode === 'lobby' ? 'lobby-mode' : ''}"><div class="listener-avatar${user.emoji ? ' emoji' : ''}">${avatar}</div><div class="listener-info"><span class="listener-name">${escapeHtml(user.username)}</span>${nowListening}</div>${followBtn}${followingBadge}${modeIcon}${user.isHost ? '<span class="listener-badge">Host</span>' : ''}</li>`;
  }).join('');
  if (state.listeningMode === 'independent') {
    elements.listenersList.querySelectorAll('.follow-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetSocketId = btn.dataset.socketId;
        if (state.followingSocketId === targetSocketId) stopFollowing();
        else startFollowing(targetSocketId);
      });
    });
  }
}

import { startFollowing } from './playback.js';

export function resetLobbyUI() {
  elements.trackTitle.textContent = t('player.noTrackPlaying', 'No track playing');
  elements.trackArtist.textContent = t('player.addSongHint', 'Add a song to get started');
  const sourceLink = document.getElementById('track-source-link');
  if (sourceLink) sourceLink.hidden = true;
  elements.progressBar.value = 0;
  elements.currentTime.textContent = '0:00';
  elements.duration.textContent = '0:00';
  elements.albumArt.innerHTML = '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
  state.isPlaying = false;
  state.isShuffleEnabled = false;
  state.repeatMode = 'off';
  state.userMode = 'listening';
  state.queueCurrentIndex = -1;
  state.followingSocketId = null;
  state.followingUsername = null;
  updatePlayButton();
  updatePlaybackModeUI();
  updateModeButton();
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
