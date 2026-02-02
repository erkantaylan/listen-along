const socket = io();

// Playback sync state
const playbackState = {
  lobbyId: null,
  audio: null,
  isPlaying: false,
  currentTrack: null,
  serverTimeOffset: 0,      // Difference between server and client time
  syncThreshold: 0.5,       // Acceptable drift in seconds
  reportInterval: null,
};

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  stopReportInterval();
});

// Join a lobby and receive current playback state
function joinLobby(lobbyId) {
  playbackState.lobbyId = lobbyId;
  socket.emit('lobby:join', { lobbyId });

  // Request current playback state
  socket.emit('playback:getState', lobbyId, (state) => {
    if (state) {
      handleSync(state);
    }
  });
}

// Leave current lobby
function leaveLobby() {
  if (playbackState.lobbyId) {
    socket.emit('lobby:leave', { lobbyId: playbackState.lobbyId });
    playbackState.lobbyId = null;
    stopPlayback();
  }
}

// Handle sync message from server
socket.on('playback:sync', (state) => {
  handleSync(state);
});

// Handle forced resync (drift exceeded threshold)
socket.on('playback:forceSync', (state) => {
  console.log('Force resync triggered');
  handleSync(state, true);
});

// Handle track ended event
socket.on('playback:trackEnded', (data) => {
  console.log('Track ended:', data.endedTrack?.title);
  // Queue system will provide next track
});

function handleSync(state, forceSeek = false) {
  if (!state) return;

  // Calculate server time offset
  playbackState.serverTimeOffset = Date.now() - state.serverTime;

  // Update track if changed
  if (state.track && (!playbackState.currentTrack ||
      playbackState.currentTrack.id !== state.track.id)) {
    playbackState.currentTrack = state.track;
    onTrackChanged(state.track);
  }

  // Sync position
  if (playbackState.audio) {
    const targetPosition = state.position;
    const currentPosition = playbackState.audio.currentTime;
    const drift = Math.abs(targetPosition - currentPosition);

    // Only seek if drift exceeds threshold or forced
    if (forceSeek || drift > playbackState.syncThreshold) {
      playbackState.audio.currentTime = targetPosition;
      console.log(`Synced position: ${targetPosition.toFixed(2)}s (drift: ${drift.toFixed(2)}s)`);
    }
  }

  // Sync play/pause state
  if (state.isPlaying !== playbackState.isPlaying) {
    playbackState.isPlaying = state.isPlaying;
    if (state.isPlaying) {
      playAudio();
    } else {
      pauseAudio();
    }
  }
}

function onTrackChanged(track) {
  console.log('Now playing:', track.title);
  // Audio source will be set by the audio streaming module
  // This is called when track metadata changes
}

function playAudio() {
  if (playbackState.audio) {
    playbackState.audio.play().catch(e => {
      console.warn('Autoplay blocked:', e.message);
    });
    startReportInterval();
  }
}

function pauseAudio() {
  if (playbackState.audio) {
    playbackState.audio.pause();
    stopReportInterval();
  }
}

function stopPlayback() {
  pauseAudio();
  playbackState.currentTrack = null;
  playbackState.isPlaying = false;
}

// Periodically report client position to server for drift detection
function startReportInterval() {
  stopReportInterval();
  playbackState.reportInterval = setInterval(() => {
    if (playbackState.audio && playbackState.lobbyId) {
      socket.emit('playback:reportPosition', {
        lobbyId: playbackState.lobbyId,
        clientPosition: playbackState.audio.currentTime,
      });
    }
  }, 5000); // Report every 5 seconds
}

function stopReportInterval() {
  if (playbackState.reportInterval) {
    clearInterval(playbackState.reportInterval);
    playbackState.reportInterval = null;
  }
}

// User actions - emit to server
function userPlay() {
  if (playbackState.lobbyId) {
    socket.emit('playback:play', { lobbyId: playbackState.lobbyId });
  }
}

function userPause() {
  if (playbackState.lobbyId) {
    socket.emit('playback:pause', { lobbyId: playbackState.lobbyId });
  }
}

function userSeek(position) {
  if (playbackState.lobbyId) {
    socket.emit('playback:seek', {
      lobbyId: playbackState.lobbyId,
      position,
    });
  }
}

// Handle audio element ended event
function onAudioEnded() {
  if (playbackState.lobbyId) {
    socket.emit('playback:ended', { lobbyId: playbackState.lobbyId });
  }
}

// Initialize audio element (called when audio source is set)
function initAudio(audioElement) {
  playbackState.audio = audioElement;
  audioElement.addEventListener('ended', onAudioEnded);
}

// Expose functions for other modules
window.listenAlong = {
  joinLobby,
  leaveLobby,
  userPlay,
  userPause,
  userSeek,
  initAudio,
  getState: () => ({ ...playbackState }),
};
