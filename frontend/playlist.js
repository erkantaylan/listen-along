// Personal playlists and solo player mode
import { state, elements, viewActivators, STORAGE_KEYS, storageSet } from './state.js';
import { showView, showToast, escapeHtml, sanitizeUrl, formatDuration, formatTime, t } from './ui.js';
import { playAudioWithUnlock } from './audio.js';

// Register landing view activator (appended to existing)
const originalLandingActivator = viewActivators.landing;
viewActivators.landing = () => {
  if (originalLandingActivator) originalLandingActivator();
  fetchPlaylists();
};

// Register profile view activator
viewActivators.profile = undefined; // handled by auth.js loadProfilePage

export function fetchPlaylists() {
  fetch(`/api/playlists?userId=${encodeURIComponent(state.userId)}`)
    .then(res => res.json())
    .then(data => { state.playlists = data.playlists || []; renderPlaylists(); })
    .catch(() => {});
}

export function renderPlaylists() {
  if (!elements.playlistsSection || !elements.playlistsList) return;
  if (state.playlists.length === 0) {
    elements.playlistsSection.hidden = false;
    elements.playlistsList.innerHTML = '<li class="playlists-empty">No playlists yet. Create one to save songs!</li>';
    return;
  }
  elements.playlistsSection.hidden = false;
  elements.playlistsList.innerHTML = state.playlists.map(p => `<li class="playlist-item" data-id="${escapeHtml(p.id)}"><div class="playlist-item-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div><div class="playlist-item-info" onclick="window.app.openPlaylist('${escapeHtml(p.id)}')"><div class="playlist-item-name">${escapeHtml(p.name)}</div><div class="playlist-item-meta">${p.song_count || 0} song${(p.song_count || 0) !== 1 ? 's' : ''}</div></div><div class="playlist-item-actions"><button class="btn-icon" onclick="window.app.deletePlaylist('${escapeHtml(p.id)}')" aria-label="Delete playlist"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></div></li>`).join('');
}

export function createNewPlaylist() {
  const name = prompt('Playlist name:');
  if (!name || !name.trim()) return;
  fetch('/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: state.userId, name: name.trim() }) })
    .then(res => { if (!res.ok) throw new Error('Failed to create'); return res.json(); })
    .then(created => { showToast(`Playlist "${created.name}" created`, 'success'); fetchPlaylists(); })
    .catch(() => showToast('Could not create playlist. Database may be unavailable.', 'error'));
}

export function deletePlaylistAction(playlistId) {
  if (!confirm('Delete this playlist?')) return;
  fetch(`/api/playlists/${playlistId}?userId=${encodeURIComponent(state.userId)}`, { method: 'DELETE' })
    .then(res => { if (!res.ok) throw new Error('Failed'); return res.json(); })
    .then(() => { showToast('Playlist deleted', 'success'); fetchPlaylists(); })
    .catch(() => showToast('Failed to delete playlist', 'error'));
}

export function openPlaylist(playlistId) {
  fetch(`/api/playlists/${playlistId}`)
    .then(res => { if (!res.ok) throw new Error('Not found'); return res.json(); })
    .then(playlist => {
      state.soloPlaylistId = playlist.id;
      state.soloPlaylistSongs = playlist.songs || [];
      state.soloCurrentIndex = -1;
      elements.soloPlaylistName.textContent = playlist.name;
      updateSoloSongCount();
      updateSoloQueue();
      resetSoloNowPlaying();
      showView('solo');
      window.history.pushState({ solo: playlistId }, '', '/');
      if (state.soloPlaylistSongs.length > 0) soloPlayTrack(0);
    })
    .catch(() => showToast('Could not open playlist', 'error'));
}

export function leaveSoloPlayer() {
  elements.audioPlayer.pause();
  elements.audioPlayer.src = '';
  state.soloPlaylistId = null;
  state.soloPlaylistSongs = [];
  state.soloCurrentIndex = -1;
  showView('landing');
}

function updateSoloSongCount() {
  if (elements.soloSongCount) {
    const count = state.soloPlaylistSongs.length;
    elements.soloSongCount.textContent = `${count} song${count !== 1 ? 's' : ''}`;
  }
}

function resetSoloNowPlaying() {
  if (elements.soloTrackTitle) elements.soloTrackTitle.textContent = t('player.noTrackPlaying', 'No track playing');
  if (elements.soloTrackArtist) elements.soloTrackArtist.textContent = t('player.addSongHint', 'Add a song to get started');
  if (elements.soloAlbumArt) elements.soloAlbumArt.innerHTML = '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
  if (elements.soloProgressBar) elements.soloProgressBar.value = 0;
  if (elements.soloCurrentTime) elements.soloCurrentTime.textContent = '0:00';
  if (elements.soloDuration) elements.soloDuration.textContent = '0:00';
}

export function soloPlayTrack(index) {
  if (index < 0 || index >= state.soloPlaylistSongs.length) return;
  state.soloCurrentIndex = index;
  const song = state.soloPlaylistSongs[index];
  if (elements.soloTrackTitle) elements.soloTrackTitle.textContent = song.title || 'Unknown';
  if (elements.soloTrackArtist) elements.soloTrackArtist.textContent = '';
  const thumbUrl = sanitizeUrl(song.thumbnail);
  if (elements.soloAlbumArt) {
    elements.soloAlbumArt.innerHTML = thumbUrl ? `<img src="${thumbUrl}" alt="Album art">` : '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
  }
  playAudioWithUnlock(`/api/stream?q=${encodeURIComponent(song.url)}`, 0, true);
  updateSoloQueue();
}

export function soloTogglePlayback() {
  const audio = elements.audioPlayer;
  if (audio.paused) {
    if (!audio.src || audio.src === window.location.origin + '/') { if (state.soloPlaylistSongs.length > 0) soloPlayTrack(0); }
    else playAudioWithUnlock(audio.src, audio.currentTime, true);
  } else audio.pause();
}

export function soloPrevious() {
  const audio = elements.audioPlayer;
  if (audio.src) { audio.currentTime = 0; if (audio.paused) playAudioWithUnlock(audio.src, 0, true); }
}

export function soloNext() { soloAdvance(); }

export function soloAdvance() {
  if (state.soloPlaylistSongs.length === 0) return;
  let nextIndex = state.soloCurrentIndex + 1;
  if (state.soloRepeatMode === 'one' && state.soloCurrentIndex >= 0) { soloPlayTrack(state.soloCurrentIndex); return; }
  if (nextIndex >= state.soloPlaylistSongs.length) {
    if (state.soloRepeatMode === 'all') nextIndex = 0;
    else { elements.audioPlayer.pause(); return; }
  }
  soloPlayTrack(nextIndex);
}

export function soloCycleRepeat() {
  const modes = ['off', 'all', 'one'];
  state.soloRepeatMode = modes[(modes.indexOf(state.soloRepeatMode) + 1) % modes.length];
  storageSet(STORAGE_KEYS.REPEAT_MODE, state.soloRepeatMode);
  updateSoloRepeatButton();
}

function updateSoloRepeatButton() {
  if (elements.soloRepeatBtn) {
    elements.soloRepeatBtn.dataset.mode = state.soloRepeatMode;
    elements.soloRepeatBtn.setAttribute('aria-label', { 'off': 'Repeat off', 'all': 'Repeat all', 'one': 'Repeat one' }[state.soloRepeatMode]);
  }
}

export function soloSeek() {
  const percent = elements.soloProgressBar.value;
  const duration = elements.audioPlayer.duration;
  if (duration) elements.audioPlayer.currentTime = (percent / 100) * duration;
}

export function soloAddSong() {
  const input = elements.soloSongInput.value.trim();
  if (!input || !state.soloPlaylistId) return;
  elements.soloAddSongBtn.disabled = true;
  showToast('Fetching song info...', 'info');
  fetch(`/api/metadata?q=${encodeURIComponent(input)}`)
    .then(res => { if (!res.ok) throw new Error('Not found'); return res.json(); })
    .then(meta => fetch(`/api/playlists/${state.soloPlaylistId}/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: meta.url || input, title: meta.title || 'Unknown', duration: meta.duration || 0, thumbnail: meta.thumbnail || null }) }))
    .then(res => { if (!res.ok) throw new Error('Failed to add'); return res.json(); })
    .then(song => { state.soloPlaylistSongs.push(song); updateSoloQueue(); updateSoloSongCount(); elements.soloSongInput.value = ''; showToast(`Added: ${song.title}`, 'success'); if (state.soloPlaylistSongs.length === 1) soloPlayTrack(0); })
    .catch(() => showToast('Failed to add song', 'error'))
    .finally(() => { elements.soloAddSongBtn.disabled = false; });
}

export function soloRemoveSong(index) {
  const song = state.soloPlaylistSongs[index];
  if (!song || !state.soloPlaylistId) return;
  fetch(`/api/playlists/${state.soloPlaylistId}/songs/${song.id}`, { method: 'DELETE' })
    .then(res => {
      if (!res.ok) throw new Error('Failed');
      state.soloPlaylistSongs.splice(index, 1);
      if (index < state.soloCurrentIndex) state.soloCurrentIndex--;
      else if (index === state.soloCurrentIndex) {
        if (state.soloPlaylistSongs.length > 0) soloPlayTrack(Math.min(state.soloCurrentIndex, state.soloPlaylistSongs.length - 1));
        else { elements.audioPlayer.pause(); elements.audioPlayer.src = ''; state.soloCurrentIndex = -1; resetSoloNowPlaying(); }
      }
      updateSoloQueue();
      updateSoloSongCount();
    })
    .catch(() => showToast('Failed to remove song', 'error'));
}

export function updateSoloQueue() {
  if (!elements.soloQueueList) return;
  if (state.soloPlaylistSongs.length === 0) {
    elements.soloQueueList.innerHTML = `<li class="queue-empty"><p>${t('solo.playlistEmpty', 'Playlist is empty')}</p><p class="hint">${t('player.addSongHint', 'Add a song to get started')}</p></li>`;
    return;
  }
  elements.soloQueueList.innerHTML = state.soloPlaylistSongs.map((song, index) => {
    const thumbUrl = sanitizeUrl(song.thumbnail);
    const isPlaying = index === state.soloCurrentIndex;
    return `<li class="queue-item ${isPlaying ? 'playing' : ''}" data-index="${index}" data-title="${escapeHtml(song.title).toLowerCase()}"><div class="queue-item-thumb" onclick="window.app.soloPlayTrack(${index})">${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}</div><div class="queue-item-info" onclick="window.app.soloPlayTrack(${index})" style="cursor:pointer"><div class="queue-item-title">${escapeHtml(song.title)}</div><div class="queue-item-meta"><span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span></div></div><div class="queue-item-actions">${song.url && song.url.startsWith('http') ? `<button class="btn-icon queue-item-youtube" aria-label="Open on YouTube" title="Open on YouTube" onclick="window.app.soloOpenSource(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg></button>` : ''}<button class="btn-icon queue-item-play" aria-label="Play" onclick="window.app.soloPlayTrack(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><button class="btn-icon queue-item-remove" aria-label="Remove from playlist" onclick="window.app.soloRemoveSong(${index})"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div></li>`;
  }).join('');
}

export function setupSoloSearch() {
  const searchInput = document.getElementById('solo-search-input');
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase();
    if (!elements.soloQueueList) return;
    elements.soloQueueList.querySelectorAll('.queue-item').forEach(el => { el.style.display = (el.dataset.title || '').includes(query) ? '' : 'none'; });
  });
}

export function setupSoloAudioHooks() {
  const audio = elements.audioPlayer;
  audio.addEventListener('timeupdate', () => {
    if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) {
      if (audio.duration) { elements.soloProgressBar.value = (audio.currentTime / audio.duration) * 100; elements.soloCurrentTime.textContent = formatTime(audio.currentTime); }
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) elements.soloDuration.textContent = formatTime(audio.duration);
  });
  audio.addEventListener('ended', () => { if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) soloAdvance(); });
  audio.addEventListener('play', () => { if (state.soloPlaylistId) updateSoloPlayButton(); });
  audio.addEventListener('pause', () => { if (state.soloPlaylistId) updateSoloPlayButton(); });
}

function updateSoloPlayButton() {
  if (!elements.soloPlayBtn) return;
  const icon = elements.soloPlayBtn.querySelector('svg');
  const audio = elements.audioPlayer;
  icon.innerHTML = !audio.paused ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  elements.soloPlayBtn.setAttribute('aria-label', !audio.paused ? 'Pause' : 'Play');
}

export function soloOpenSource(index) {
  const song = state.soloPlaylistSongs[index];
  if (song && song.url && song.url.startsWith('http')) window.open(song.url, '_blank', 'noopener,noreferrer');
}
