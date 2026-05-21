// Audio player, volume controls, and Safari unlock handling
import { state, elements, socket, STORAGE_KEYS, storageSet } from './state.js';
import { showToast, formatTime } from './ui.js';

export function setupAudioPlayer(advanceLocalQueue) {
  const audio = elements.audioPlayer;

  audio.addEventListener('timeupdate', () => {
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      elements.progressBar.value = percent;
      elements.currentTime.textContent = formatTime(audio.currentTime);
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    elements.duration.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('ended', () => {
    if (state.listeningMode === 'independent') {
      advanceLocalQueue();
      return;
    }
    socket.emit('playback:ended', { lobbyId: state.lobbyId });
  });

  audio.addEventListener('play', () => {
    state.isPlaying = true;
    state.audioUnlocked = true;
    hideUnlockPrompt();
  });

  audio.addEventListener('pause', () => {
    state.isPlaying = false;
  });

  audio.addEventListener('error', (e) => {
    if (!audio.src || audio.src === window.location.href) return;
    console.error('Audio error:', e);
    showToast('Error playing audio', 'error');
  });

  setupAudioUnlock();
  audio.volume = state.volume;
  setupVolumeControls();
}

export function setupMediaSession(togglePlayback, playNext, playPrevious) {
  if (!window.MediaSessionManager) return;

  MediaSessionManager.init({
    onPlay: function () { togglePlayback(); },
    onPause: function () { togglePlayback(); },
    onNext: function () { playNext(); },
    onPrevious: function () { playPrevious(); },
    onSeekTo: function (time) {
      const audio = elements.audioPlayer;
      if (audio && audio.duration) audio.currentTime = time;
    }
  });

  const audio = elements.audioPlayer;
  audio.addEventListener('timeupdate', function () {
    if (audio.duration) {
      MediaSessionManager.updatePositionState({ duration: audio.duration, position: audio.currentTime });
    }
  });
  audio.addEventListener('play', function () { MediaSessionManager.updatePlaybackState('playing'); });
  audio.addEventListener('pause', function () { MediaSessionManager.updatePlaybackState('paused'); });
}

function setupAudioUnlock() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (isIOS || isSafari) {
    const unlockAudio = () => {
      if (state.audioUnlocked) return;
      const audio = elements.audioPlayer;
      const silentPlay = audio.play();
      if (silentPlay) {
        silentPlay.then(() => {
          audio.pause();
          state.audioUnlocked = true;
          console.log('Audio unlocked via user gesture');
          hideUnlockPrompt();
          if (state.pendingPlay) {
            const pending = state.pendingPlay;
            state.pendingPlay = null;
            playAudioWithUnlock(pending.src, pending.position, pending.shouldPlay);
          }
        }).catch(() => {});
      }
    };
    ['touchstart', 'touchend', 'click'].forEach(event => {
      document.addEventListener(event, unlockAudio, { once: false, passive: true });
    });
  }
}

export function setupVolumeControls() {
  const volumePercent = Math.round(state.volume * 100);
  if (elements.volumeBar) {
    elements.volumeBar.value = volumePercent;
    elements.volumeBar.addEventListener('input', handleVolumeChange);
  }
  if (elements.volumeBtn) elements.volumeBtn.addEventListener('click', toggleMute);
  updateVolumeIcon();
}

function handleVolumeChange(e) {
  const volume = parseInt(e.target.value, 10) / 100;
  state.volume = volume;
  state.isMuted = volume === 0;
  elements.audioPlayer.volume = volume;
  storageSet(STORAGE_KEYS.VOLUME, volume);
  const percent = Math.round(volume * 100);
  if (elements.volumeBar) elements.volumeBar.value = percent;
  updateVolumeIcon();
}

export function toggleMute() {
  if (state.isMuted) {
    state.isMuted = false;
    state.volume = state.volumeBeforeMute || 1;
  } else {
    state.isMuted = true;
    state.volumeBeforeMute = state.volume || 1;
    state.volume = 0;
  }
  elements.audioPlayer.volume = state.volume;
  storageSet(STORAGE_KEYS.VOLUME, state.volume);
  const percent = Math.round(state.volume * 100);
  if (elements.volumeBar) elements.volumeBar.value = percent;
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const vol = state.volume;
  let iconPath;
  if (vol === 0 || state.isMuted) {
    iconPath = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  } else if (vol < 0.5) {
    iconPath = '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>';
  } else {
    iconPath = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  }
  if (elements.volumeIcon) elements.volumeIcon.innerHTML = iconPath;
}

export function playAudioWithUnlock(src, position, shouldPlay) {
  if (!state.lobbyId) return;
  const audio = elements.audioPlayer;
  if (src && audio.src !== src) audio.src = src;
  if (position !== undefined && isFinite(position)) audio.currentTime = position;
  if (shouldPlay) {
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(e => {
        console.log('Autoplay blocked:', e);
        if (e.name === 'NotAllowedError') {
          state.pendingPlay = { src: audio.src, position: audio.currentTime, shouldPlay: true };
          showUnlockPrompt();
        }
      });
    }
  }
}

function showUnlockPrompt() {
  if (document.getElementById('audio-unlock-prompt')) return;
  const prompt = document.createElement('div');
  prompt.id = 'audio-unlock-prompt';
  prompt.className = 'audio-unlock-prompt';
  prompt.innerHTML = `
    <div class="unlock-content">
      <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
    </svg>
      <span>Tap to enable audio</span>
    </div>
  `;
  prompt.addEventListener('click', () => {
    const audio = elements.audioPlayer;
    if (state.pendingPlay) {
      audio.src = state.pendingPlay.src;
      audio.currentTime = state.pendingPlay.position || 0;
    }
    audio.play().then(() => {
      state.audioUnlocked = true;
      state.pendingPlay = null;
      hideUnlockPrompt();
    }).catch(e => {
      console.error('Play failed even with user gesture:', e);
      showToast('Could not play audio. Try again.', 'error');
    });
  });
  document.body.appendChild(prompt);
}

export function hideUnlockPrompt() {
  const prompt = document.getElementById('audio-unlock-prompt');
  if (prompt) prompt.remove();
}
