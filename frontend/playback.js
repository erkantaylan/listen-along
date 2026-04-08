// Playback controls, state handlers, mode management, and follow system
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, getCoverUrl, sanitizeUrl, getInitials, t } from './ui.js';
import { playAudioWithUnlock } from './audio.js';

// These are imported lazily to avoid circular deps with queue.js
let _updateQueue, _updateListeners;
export function _setQueueFns(updateQueue, updateListeners) {
  _updateQueue = updateQueue;
  _updateListeners = updateListeners;
}

export function handlePlaybackState(data) {
  state.isPlaying = data.isPlaying;
  state.currentTrack = data.track;
  if (state.currentTrack) updateNowPlaying(state.currentTrack);
  if (data.isPlaying && data.audioUrl) {
    playAudioWithUnlock(data.audioUrl, data.position || 0, true);
  } else { elements.audioPlayer.pause(); }
  updatePlayButton();
  if (_updateListeners) _updateListeners();
}

export function handlePlaybackSync(data) {
  if (state.listeningMode === 'independent') return;
  const audio = elements.audioPlayer;
  const serverPosition = data.position || 0;
  state.isPlaying = data.isPlaying;
  updatePlayButton();
  if (data.repeatMode !== undefined && data.repeatMode !== state.repeatMode) {
    state.repeatMode = data.repeatMode;
    storageSet(STORAGE_KEYS.REPEAT_MODE, data.repeatMode);
    updatePlaybackModeUI();
  }
  const shouldPlayAudio = state.userMode === 'listening';
  if (data.track && data.track.url) {
    const streamUrl = `/api/stream?q=${encodeURIComponent(data.track.url)}`;
    if (!audio.src || !audio.src.includes(encodeURIComponent(data.track.url))) {
      state.currentTrack = data.track;
      updateNowPlaying(data.track);
      if (_updateQueue) _updateQueue();
      if (_updateListeners) _updateListeners();
      if (data.isPlaying && shouldPlayAudio) { playAudioWithUnlock(streamUrl, serverPosition, true); }
      else { audio.src = streamUrl; audio.currentTime = serverPosition; }
      return;
    }
  }
  const drift = Math.abs(audio.currentTime - serverPosition);
  if (drift > 1) audio.currentTime = serverPosition;
  if (shouldPlayAudio) {
    if (data.isPlaying && audio.paused) playAudioWithUnlock(audio.src, audio.currentTime, true);
    else if (!data.isPlaying && !audio.paused) audio.pause();
  } else { if (!audio.paused) audio.pause(); }
}

export function handleTrackChanged(data) {
  state.currentTrack = data.track;
  state.queue = data.queue || state.queue;
  updateNowPlaying(data.track);
  if (_updateQueue) _updateQueue();
  if (_updateListeners) _updateListeners();
  if (data.audioUrl) playAudioWithUnlock(data.audioUrl, 0, true);
}

export function handleShuffleState(data) {
  state.isShuffleEnabled = data.shuffleEnabled;
  storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(data.shuffleEnabled));
  updatePlaybackModeUI();
}

export function handleDownloadStatus(data) {
  state.downloadStatus[data.url] = { status: data.status, percent: data.percent || 0, error: data.error };
  if (_updateQueue) _updateQueue();
}

export function handleDownloadProgress(data) {
  if (state.downloadStatus[data.url]) { state.downloadStatus[data.url].percent = data.percent; }
  else { state.downloadStatus[data.url] = { status: 'downloading', percent: data.percent }; }
  updateQueueProgress(data.url, data.percent);
}

export function handleModeChanged(data) {
  state.userMode = data.mode;
  updateModeButton();
  if (data.mode === 'lobby') {
    elements.audioPlayer.pause();
    showToast('Lobby mode: Audio paused', 'info');
  } else if (data.mode === 'listening' && state.isPlaying) {
    const audio = elements.audioPlayer;
    if (audio.src) playAudioWithUnlock(audio.src, audio.currentTime, true);
    showToast('Listening mode: Audio resumed', 'info');
  }
}

export function handleUsersUpdated(data) {
  state.listeners = data.users || [];
  if (state.followingSocketId) {
    const leaderStillHere = state.listeners.some(u => u.socketId === state.followingSocketId);
    if (!leaderStillHere) {
      state.followingSocketId = null;
      state.followingUsername = null;
      showToast(t('follow.leaderLeft', 'The user you were following has left'), 'info');
    }
  }
  if (_updateListeners) _updateListeners();
  if (state.listeningMode === 'independent' && _updateQueue) _updateQueue();
}

export function handleFollowSync(data) {
  if (!data.track) return;
  const song = state.queue.find(s => s.title === data.track.title);
  if (song) playLocalTrack(song);
  else if (data.track.url) playLocalTrack(data.track);
}

export function startFollowing(targetSocketId) {
  const target = state.listeners.find(u => u.socketId === targetSocketId);
  if (!target) return;
  state.followingSocketId = targetSocketId;
  state.followingUsername = target.username;
  socket.emit('follow:start', { lobbyId: state.lobbyId, targetSocketId });
  if (_updateListeners) _updateListeners();
  showToast(t('follow.started', 'Following {name}', { name: target.username }), 'info');
}

export function stopFollowing() {
  state.followingSocketId = null;
  state.followingUsername = null;
  socket.emit('follow:stop', { lobbyId: state.lobbyId });
  if (_updateListeners) _updateListeners();
  showToast(t('follow.stopped', 'Stopped following'), 'info');
}

export function toggleUserMode() {
  const newMode = state.userMode === 'listening' ? 'lobby' : 'listening';
  socket.emit('mode:set', { lobbyId: state.lobbyId, mode: newMode });
}

export function updateQueueProgress(url, percent) {
  const queueItems = elements.queueList.querySelectorAll('.queue-item');
  for (const item of queueItems) {
    const progressBar = item.querySelector('.queue-item-progress-bar');
    if (progressBar && item.dataset.url === url) {
      progressBar.style.width = `${percent}%`;
      const percentText = item.querySelector('.queue-item-percent');
      if (percentText) percentText.textContent = `${percent}%`;
      break;
    }
  }
}

export function cycleRepeatMode() {
  const cycle = { 'off': 'all', 'all': 'one', 'one': 'off' };
  const newRepeat = cycle[state.repeatMode] || 'off';
  if (state.listeningMode === 'independent') {
    state.repeatMode = newRepeat;
    storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
    updatePlaybackModeUI();
    return;
  }
  socket.emit('playback:setRepeat', { lobbyId: state.lobbyId, mode: newRepeat });
  state.repeatMode = newRepeat;
  storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
  updatePlaybackModeUI();
}

export function toggleShuffle() {
  if (state.listeningMode === 'independent') {
    const newShuffle = !state.isShuffleEnabled;
    state.isShuffleEnabled = newShuffle;
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(newShuffle));
    updatePlaybackModeUI();
    return;
  }
  socket.emit('queue:shuffle', { lobbyId: state.lobbyId });
  showToast('Upcoming songs shuffled', 'info');
}

export function togglePlayback() {
  if (state.listeningMode === 'independent') {
    const audio = elements.audioPlayer;
    if (audio.paused) {
      if (!audio.src || audio.src === window.location.origin + '/') {
        if (state.queue.length > 0) playLocalTrack(state.queue[0]);
      } else { playAudioWithUnlock(audio.src, audio.currentTime, true); }
    } else { audio.pause(); }
    return;
  }
  socket.emit('playback:toggle', { lobbyId: state.lobbyId });
}

export function playPrevious() {
  if (state.listeningMode === 'independent') {
    if (state.followingSocketId) stopFollowing();
    const audio = elements.audioPlayer;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      if (audio.paused) playAudioWithUnlock(audio.src, 0, true);
      return;
    }
    if (state.queue.length === 0) return;
    const currentIndex = state.currentTrack ? state.queue.findIndex(s => s.id === state.currentTrack.id) : -1;
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) {
      if (state.repeatMode === 'all') prevIndex = state.queue.length - 1;
      else { if (audio.src) { audio.currentTime = 0; if (audio.paused) playAudioWithUnlock(audio.src, 0, true); } return; }
    }
    playLocalTrack(state.queue[prevIndex]);
    return;
  }
  socket.emit('playback:previous', { lobbyId: state.lobbyId });
}

export function playNext() {
  if (state.listeningMode === 'independent') {
    if (state.followingSocketId) stopFollowing();
    advanceLocalQueue();
    return;
  }
  socket.emit('playback:next', { lobbyId: state.lobbyId });
}

export function seekTo() {
  const percent = elements.progressBar.value;
  const duration = elements.audioPlayer.duration;
  if (duration) {
    const position = (percent / 100) * duration;
    if (state.listeningMode === 'independent') { elements.audioPlayer.currentTime = position; return; }
    socket.emit('playback:seek', { lobbyId: state.lobbyId, position });
  }
}

export function playLocalTrack(track) {
  if (!track) return;
  state.currentTrack = track;
  updateNowPlaying(track);
  if (_updateListeners) _updateListeners();
  const streamUrl = `/api/stream?q=${encodeURIComponent(track.url)}`;
  playAudioWithUnlock(streamUrl, 0, true);
  if (state.listeningMode === 'independent' && state.lobbyId) {
    socket.emit('listener:now-playing', { lobbyId: state.lobbyId, track: { title: track.title, thumbnail: track.thumbnail } });
  }
}

export function advanceLocalQueue() {
  if (state.queue.length === 0) return;
  const currentIndex = state.currentTrack ? state.queue.findIndex(s => s.id === state.currentTrack.id) : -1;
  if (state.repeatMode === 'one' && currentIndex >= 0) { playLocalTrack(state.queue[currentIndex]); return; }
  if (state.isShuffleEnabled && state.queue.length > 1) {
    let randomIndex;
    do { randomIndex = Math.floor(Math.random() * state.queue.length); } while (randomIndex === currentIndex && state.queue.length > 1);
    playLocalTrack(state.queue[randomIndex]);
    return;
  }
  let nextIndex = currentIndex + 1;
  if (nextIndex >= state.queue.length) {
    if (state.repeatMode === 'all') nextIndex = 0;
    else { elements.audioPlayer.pause(); state.isPlaying = false; updatePlayButton(); return; }
  }
  playLocalTrack(state.queue[nextIndex]);
}

export function updateNowPlaying(track) {
  elements.trackTitle.textContent = track.title || 'Unknown Track';
  elements.trackArtist.textContent = track.artist || '';
  const sourceLink = document.getElementById('track-source-link');
  if (sourceLink) {
    if (track.url && track.url.startsWith('http')) { sourceLink.href = track.url; sourceLink.hidden = false; }
    else { sourceLink.hidden = true; }
  }
  const thumbUrl = track.id ? getCoverUrl(track.id, track.thumbnail) : sanitizeUrl(track.thumbnail);
  if (thumbUrl) { elements.albumArt.innerHTML = `<img src="${thumbUrl}" alt="Album art">`; }
  else { elements.albumArt.innerHTML = '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>'; }
  if (window.MediaSessionManager) {
    MediaSessionManager.updateTrack({ title: track.title, artist: track.artist, thumbnail: track.thumbnail, songId: track.id });
  }
}

export function updatePlayButton() {
  const icon = elements.playBtn.querySelector('svg');
  if (state.isPlaying) {
    icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    elements.playBtn.setAttribute('aria-label', 'Pause');
  } else {
    icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    elements.playBtn.setAttribute('aria-label', 'Play');
  }
}

export function updatePlaybackModeUI() {
  const repeatBtn = elements.repeatBtn;
  repeatBtn.classList.toggle('active', state.repeatMode !== 'off');
  if (state.repeatMode === 'all') {
    repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
    repeatBtn.setAttribute('aria-label', 'Repeat all'); repeatBtn.setAttribute('title', 'Repeat all');
  } else if (state.repeatMode === 'one') {
    repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">1</text></svg>';
    repeatBtn.setAttribute('aria-label', 'Repeat one'); repeatBtn.setAttribute('title', 'Repeat one');
  } else {
    repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M8 8h8v8H8z"/></svg>';
    repeatBtn.setAttribute('aria-label', 'Repeat off'); repeatBtn.setAttribute('title', 'Repeat off');
  }
  const shuffleBtn = elements.shuffleBtn;
  if (state.listeningMode === 'synchronized') {
    shuffleBtn.classList.remove('active');
    shuffleBtn.setAttribute('aria-label', 'Shuffle upcoming'); shuffleBtn.setAttribute('title', 'Shuffle upcoming');
  } else {
    shuffleBtn.classList.toggle('active', state.isShuffleEnabled);
    shuffleBtn.setAttribute('aria-label', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
    shuffleBtn.setAttribute('title', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
  }
}

export function updateListeningModeBadge() {
  const badge = elements.listeningModeBadge;
  if (!badge) return;
  if (state.listeningMode === 'independent') {
    badge.textContent = 'Independent'; badge.className = 'listening-mode-badge independent';
  } else {
    badge.textContent = 'JAM'; badge.className = 'listening-mode-badge synchronized';
  }
  badge.hidden = false;
}

export function updateModeButton() {
  if (!elements.modeBtn) return;
  const isListening = state.userMode === 'listening';
  elements.modeBtn.classList.toggle('active', isListening);
  elements.modeBtn.setAttribute('aria-pressed', isListening.toString());
  elements.modeBtn.setAttribute('aria-label', isListening ? 'Switch to lobby mode' : 'Switch to listening mode');
  elements.modeBtn.title = isListening ? 'Listening - click to enter lobby mode' : 'Lobby mode - click to start listening';
  const icon = elements.modeBtn.querySelector('svg');
  if (icon) {
    icon.innerHTML = isListening
      ? '<path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>'
      : '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
  }
}
