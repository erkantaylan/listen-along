// Full-player controls. Playback itself is player.ts; every listener plays at
// their own pace, and the server only learns what each listener is playing
// (listener:now-playing, presence:now-playing). Listening along with another
// user is listen-along.ts.
import { state, elements, STORAGE_KEYS, storageSet } from '../shared/state.ts';
import { escapeHtml, getCoverUrl, sanitizeUrl, showToast, syncRangeFill, t } from '../shared/ui.ts';
import { player } from './player.ts';
import { refreshPlayerBar } from './player-bar.ts';
import { clearFailureFor } from './playback-failures.ts';
import type { RepeatMode } from './player-queue.ts';
import type { DownloadProgressPayload, DownloadStatusPayload, Track, UsersUpdatedPayload } from '../shared/types.ts';

// These are imported lazily to avoid circular deps with queue.ts
let _updateQueue: (() => void) | undefined, _updateListeners: (() => void) | undefined;
export function _setQueueFns(updateQueue: () => void, updateListeners: () => void): void {
  _updateQueue = updateQueue;
  _updateListeners = updateListeners;
}

export function handleDownloadStatus(data: DownloadStatusPayload): void {
  state.downloadStatus[data.url] = { status: data.status, percent: data.percent || 0, error: data.error };
  if (data.status === 'ready') clearFailureFor(data.url); // it reached the library: worth playing again
  if (_updateQueue) _updateQueue();
}

export function handleDownloadProgress(data: DownloadProgressPayload): void {
  if (state.downloadStatus[data.url]) { state.downloadStatus[data.url].percent = data.percent; }
  else { state.downloadStatus[data.url] = { status: 'downloading', percent: data.percent }; }
  updateQueueProgress(data.url, data.percent);
}

// users:updated for the playlist on screen refreshes its listener list.
export function handleUsersUpdated(data: UsersUpdatedPayload): void {
  const playlistId = data.playlistId || state.playlistId;
  const users = data.users || [];
  if (playlistId !== state.playlistId) return;
  state.listeners = users;
  if (_updateListeners) _updateListeners();
  if (_updateQueue) _updateQueue();
}

// The playlist page's queue as a player context.
export function viewedContext(): { playlistId: string | null; name: string | null } {
  return { playlistId: state.playlistId, name: state.playlistName };
}

// Start the playlist on screen from its first song (shuffle, when on, takes over
// from the next one). Songs waiting as requests are not in the queue.
export function playViewedFromTop(): void {
  if (state.queue.length) player.playFrom(viewedContext(), state.queue, 0);
  else showToast(t('landing.emptyPlaylist', 'This playlist has no songs yet'), 'info');
}

export function updateQueueProgress(url: string, percent: number): void {
  const queueItems = elements.queueList.querySelectorAll<HTMLElement>('.queue-item');
  for (const item of queueItems) {
    const progressBar = item.querySelector<HTMLElement>('.queue-item-progress-bar');
    if (progressBar && item.dataset.url === url) {
      progressBar.style.width = `${percent}%`;
      const percentText = item.querySelector('.queue-item-percent');
      if (percentText) percentText.textContent = `${percent}%`;
      break;
    }
  }
}

export function cycleRepeatMode(): void {
  const cycle: Record<RepeatMode, RepeatMode> = { 'off': 'all', 'all': 'one', 'one': 'off' };
  const newRepeat = cycle[state.repeatMode] || 'off';
  state.repeatMode = newRepeat;
  storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
  updatePlaybackModeUI();
}

export function toggleShuffle(): void {
  const newShuffle = !state.isShuffleEnabled;
  state.isShuffleEnabled = newShuffle;
  storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(newShuffle));
  updatePlaybackModeUI();
}

// Full-player buttons. With nothing loaded, Play starts the playlist on screen.
export function togglePlayback(): void {
  if (player.track) { player.toggle(); return; }
  if (state.viewPlay) { state.viewPlay(); return; }
  if (state.playlistId && state.queue.length) player.playFrom(viewedContext(), state.queue, 0);
}

export function playPrevious(): void { player.previous(); }

export function playNext(): void { player.next(); }

export function seekTo(): void {
  const percent = Number(elements.progressBar.value);
  if (player.duration) player.seek((percent / 100) * player.duration);
}

// Player bar readout for the loaded track (or the empty state); the
// "artist · from" line and the enabled controls are player-bar.ts.
export function updateNowPlaying(track: Track | null | undefined): void {
  if (!track) { resetNowPlaying(); refreshPlayerBar(); return; }
  elements.trackTitle.textContent = track.title || 'Unknown Track';
  elements.trackArtist.textContent = track.artist || '';
  const thumbUrl = track.id ? getCoverUrl(track.id, track.thumbnail) : sanitizeUrl(track.thumbnail);
  if (thumbUrl) { elements.albumArt.innerHTML = `<img src="${escapeHtml(thumbUrl)}" alt="">`; }
  else { elements.albumArt.innerHTML = NOTE_ART; }
  refreshPlayerBar();
}

const NOTE_ART = '<span class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></span>';

function resetNowPlaying(): void {
  elements.progressBar.value = String(0);
  syncRangeFill(elements.progressBar);
  elements.currentTime.textContent = '0:00';
  elements.duration.textContent = '0:00';
  elements.albumArt.innerHTML = NOTE_ART;
}


export function updatePlayButton(): void {
  const icon = elements.playBtn.querySelector('svg') as SVGSVGElement;
  if (player.isPlaying) {
    icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    elements.playBtn.setAttribute('aria-label', 'Pause');
  } else {
    icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    elements.playBtn.setAttribute('aria-label', 'Play');
  }
}

export function updatePlaybackModeUI(): void {
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
