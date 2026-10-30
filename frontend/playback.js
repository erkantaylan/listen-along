// Full-player controls and the follow system. Playback itself is player.js;
// every listener plays at their own pace, and the server only learns what each
// listener is playing (listener:now-playing) so others can see and follow it.
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, escapeHtml, getCoverUrl, sanitizeUrl, t, syncRangeFill } from './ui.js';
import { player } from './player.js';
import { getMemberLobby } from './lobby.js';
import { refreshPlayerBar } from './player-bar.js';
import { refreshPeople } from './social.js';

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

// users:updated for the lobby on screen refreshes its listener list; for the
// member lobby (the one being played from) it also checks the follow leader.
export function handleUsersUpdated(data) {
  const lobbyId = data.lobbyId || state.lobbyId;
  const users = data.users || [];
  if (state.followingSocketId && lobbyId === getMemberLobby()) {
    if (!users.some(u => u.socketId === state.followingSocketId)) {
      clearFollowing();
      showToast(t('follow.leaderLeft', 'The user you were following has left'), 'info');
    }
  }
  if (lobbyId !== state.lobbyId) return;
  state.listeners = users;
  if (_updateListeners) _updateListeners();
  if (_updateQueue) _updateQueue();
}

// The lobby page's queue as a player context.
export function viewedContext() {
  return { lobbyId: state.lobbyId, name: state.lobbyName };
}

// The leader played something: play the same song from the member lobby's queue.
export function handleFollowSync(data) {
  if (!data.track) return;
  const lobbyId = getMemberLobby();
  if (lobbyId && (!player.context || player.context.lobbyId !== lobbyId) && state.lobbyId === lobbyId) {
    player.setContext(viewedContext(), state.queue, { keepDriver: true });
  }
  const song = player.queue.find(s => s.title === data.track.title);
  if (song) player.playTrack(song);
  else if (data.track.url) player.playTrack(data.track);
}

function clearFollowing() {
  state.followingSocketId = null;
  state.followingUsername = null;
  pendingFollow = null;
  if (player.driver && player.driver.name === 'follow') player.setDriver(null);
  if (_updateListeners) _updateListeners();
  refreshPeople();
}

// Follow someone from the people panel (social.js): play what they play.
// Interim: following works through the playlist they play from (it becomes
// the playback context and the member lobby), as before; listen-along will
// rework this. `person.nowPlaying.context` carries { lobbyId, name, socketId }
// only when that playlist is visible to us.
let pendingFollow = null;

export function followPerson(person) {
  const ctx = person && person.nowPlaying && person.nowPlaying.context;
  if (!ctx || ctx.type !== 'lobby' || !ctx.socketId || ctx.socketId === socket.id) return;
  if (state.followingSocketId) clearFollowing();
  state.followingSocketId = ctx.socketId;
  state.followingUsername = person.name;
  // A manual skip / pick / context change ends following.
  player.setDriver({ name: 'follow', onTakeover: () => stopFollowing() });
  if (getMemberLobby() === ctx.lobbyId) {
    socket.emit('follow:start', { lobbyId: ctx.lobbyId, targetSocketId: ctx.socketId });
  } else {
    // Make their playlist the context; membership follows it (lobby.js), and
    // follow:start goes out once the server confirms the join.
    pendingFollow = { lobbyId: ctx.lobbyId, socketId: ctx.socketId };
    player.setContext({ type: 'lobby', lobbyId: ctx.lobbyId, name: ctx.name }, [], { keepDriver: true });
  }
  refreshPeople();
  showToast(t('follow.started', 'Following {name}', { name: person.name }), 'info');
}

// lobby:joined: send a follow that was waiting for this membership.
export function flushPendingFollow(data) {
  if (!pendingFollow || !data || data.viewing || data.lobbyId !== pendingFollow.lobbyId) return;
  socket.emit('follow:start', { lobbyId: pendingFollow.lobbyId, targetSocketId: pendingFollow.socketId });
  pendingFollow = null;
}

export function isFollowingPerson(person) {
  const ctx = person && person.nowPlaying && person.nowPlaying.context;
  return !!state.followingSocketId && !!ctx && ctx.socketId === state.followingSocketId;
}

export function stopFollowing() {
  if (!state.followingSocketId) return;
  clearFollowing();
  socket.emit('follow:stop', { lobbyId: getMemberLobby() });
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

// Full-player buttons. With nothing loaded, Play starts the lobby on screen.
export function togglePlayback() {
  if (player.track) { player.toggle(); return; }
  if (state.lobbyId && state.queue.length) player.playFrom(viewedContext(), state.queue, 0);
}

export function playPrevious() { player.previous(); }

export function playNext() { player.next(); }

export function seekTo() {
  const percent = Number(elements.progressBar.value);
  if (player.duration) player.seek((percent / 100) * player.duration);
}

// Player bar readout for the loaded track (or the empty state); the
// "artist · from" line and the enabled controls are player-bar.js.
export function updateNowPlaying(track) {
  if (!track) { resetNowPlaying(); refreshPlayerBar(); return; }
  elements.trackTitle.textContent = track.title || 'Unknown Track';
  elements.trackArtist.textContent = track.artist || '';
  const sourceLink = document.getElementById('track-source-link');
  if (sourceLink) {
    if (track.url && track.url.startsWith('http')) { sourceLink.href = track.url; sourceLink.hidden = false; }
    else { sourceLink.hidden = true; }
  }
  const thumbUrl = track.id ? getCoverUrl(track.id, track.thumbnail) : sanitizeUrl(track.thumbnail);
  if (thumbUrl) { elements.albumArt.innerHTML = `<img src="${escapeHtml(thumbUrl)}" alt="">`; }
  else { elements.albumArt.innerHTML = NOTE_ART; }
  refreshPlayerBar();
}

const NOTE_ART = '<span class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></span>';

function resetNowPlaying() {
  const sourceLink = document.getElementById('track-source-link');
  if (sourceLink) sourceLink.hidden = true;
  elements.progressBar.value = 0;
  syncRangeFill(elements.progressBar);
  elements.currentTime.textContent = '0:00';
  elements.duration.textContent = '0:00';
  elements.albumArt.innerHTML = NOTE_ART;
}


export function updatePlayButton() {
  const icon = elements.playBtn.querySelector('svg');
  if (player.isPlaying) {
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
