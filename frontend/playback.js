// Local playback controls and the follow system. Every listener plays the
// shared queue at their own pace in the browser; the server only learns what
// each listener is playing (listener:now-playing) so others can see and follow it.
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, getCoverUrl, sanitizeUrl, t } from './ui.js';
import { playAudioWithUnlock } from './audio.js';

// These are imported lazily to avoid circular deps with queue.js
let _updateQueue, _updateListeners;
export function _setQueueFns(updateQueue, updateListeners) {
  _updateQueue = updateQueue;
  _updateListeners = updateListeners;
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
  if (_updateQueue) _updateQueue();
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
  state.repeatMode = newRepeat;
  storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
  updatePlaybackModeUI();
}

export function toggleShuffle() {
  const newShuffle = !state.isShuffleEnabled;
  state.isShuffleEnabled = newShuffle;
  storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(newShuffle));
  updatePlaybackModeUI();
}

export function togglePlayback() {
  const audio = elements.audioPlayer;
  if (audio.paused) {
    if (!audio.src || audio.src === window.location.origin + '/') {
      if (state.queue.length > 0) playLocalTrack(state.queue[0]);
    } else { playAudioWithUnlock(audio.src, audio.currentTime, true); }
  } else { audio.pause(); }
}

export function playPrevious() {
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
}

export function playNext() {
  if (state.followingSocketId) stopFollowing();
  advanceLocalQueue();
}

export function seekTo() {
  const percent = elements.progressBar.value;
  const duration = elements.audioPlayer.duration;
  if (duration) elements.audioPlayer.currentTime = (percent / 100) * duration;
}

export function playLocalTrack(track) {
  if (!track) return;
  state.currentTrack = track;
  updateNowPlaying(track);
  if (_updateListeners) _updateListeners();
  const streamUrl = `/api/stream?q=${encodeURIComponent(track.url)}`;
  playAudioWithUnlock(streamUrl, 0, true);
  if (state.lobbyId) {
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
  if (thumbUrl) { elements.albumArt.innerHTML = `<img src="${escapeHtml(thumbUrl)}" alt="Album art">`; }
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
  shuffleBtn.classList.toggle('active', state.isShuffleEnabled);
  shuffleBtn.setAttribute('aria-label', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
  shuffleBtn.setAttribute('title', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
}
