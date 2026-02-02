/**
 * Playback synchronization module
 *
 * Manages synchronized playback state across all clients in a lobby.
 * Server is the single source of truth for:
 * - Current track
 * - Playback position (timestamp)
 * - Play/pause state
 */

// Playback state per lobby
const lobbyPlayback = new Map();

// Sync interval in milliseconds (how often to broadcast position)
const SYNC_INTERVAL = 1000;

/**
 * Initialize playback state for a lobby
 */
function initLobby(lobbyId) {
  if (lobbyPlayback.has(lobbyId)) {
    return lobbyPlayback.get(lobbyId);
  }

  const state = {
    lobbyId,
    currentTrack: null,      // { id, title, duration, url, addedBy }
    position: 0,             // Current position in seconds
    isPlaying: false,
    startedAt: null,         // Server timestamp when playback started
    syncTimer: null,         // Interval for sync broadcasts
    repeatMode: 'off',       // 'off', 'all', 'one'
  };

  lobbyPlayback.set(lobbyId, state);
  return state;
}

/**
 * Get playback state for a lobby
 */
function getState(lobbyId) {
  return lobbyPlayback.get(lobbyId) || null;
}

/**
 * Calculate current position based on server time
 * Accounts for time elapsed since playback started
 */
function getCurrentPosition(state) {
  if (!state.isPlaying || !state.startedAt) {
    return state.position;
  }
  const elapsed = (Date.now() - state.startedAt) / 1000;
  return state.position + elapsed;
}

/**
 * Build sync message payload for clients
 */
function buildSyncMessage(state) {
  return {
    type: 'sync',
    lobbyId: state.lobbyId,
    track: state.currentTrack,
    position: getCurrentPosition(state),
    isPlaying: state.isPlaying,
    repeatMode: state.repeatMode,
    serverTime: Date.now(),
  };
}

/**
 * Start playback of a track
 */
function play(lobbyId, track, io) {
  const state = initLobby(lobbyId);

  // If resuming same track, just unpause
  if (state.currentTrack && track && state.currentTrack.id === track.id) {
    state.isPlaying = true;
    state.startedAt = Date.now();
  } else {
    // New track
    state.currentTrack = track;
    state.position = 0;
    state.isPlaying = true;
    state.startedAt = Date.now();
  }

  // Start sync timer if not running
  startSyncTimer(lobbyId, io);

  // Broadcast immediate state update
  broadcastSync(lobbyId, io);

  return buildSyncMessage(state);
}

/**
 * Pause playback
 */
function pause(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state) return null;

  // Capture current position before pausing
  state.position = getCurrentPosition(state);
  state.isPlaying = false;
  state.startedAt = null;

  // Stop sync timer
  stopSyncTimer(lobbyId);

  // Broadcast pause state
  broadcastSync(lobbyId, io);

  return buildSyncMessage(state);
}

/**
 * Resume playback from current position
 */
function resume(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state || !state.currentTrack) return null;

  state.isPlaying = true;
  state.startedAt = Date.now();

  startSyncTimer(lobbyId, io);
  broadcastSync(lobbyId, io);

  return buildSyncMessage(state);
}

/**
 * Seek to a specific position
 */
function seek(lobbyId, position, io) {
  const state = getState(lobbyId);
  if (!state) return null;

  state.position = Math.max(0, position);
  if (state.isPlaying) {
    state.startedAt = Date.now();
  }

  broadcastSync(lobbyId, io);

  return buildSyncMessage(state);
}

/**
 * Handle track ended - auto-advance to next or repeat
 * Emits 'trackEnded' event for queue system to provide next track
 */
function trackEnded(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state) return null;

  // Handle repeat one mode - restart the same track
  if (state.repeatMode === 'one' && state.currentTrack) {
    state.position = 0;
    state.startedAt = Date.now();
    state.isPlaying = true;
    broadcastSync(lobbyId, io);
    return { lobbyId, repeated: true, track: state.currentTrack };
  }

  // Reset playback state
  state.isPlaying = false;
  state.position = 0;
  state.startedAt = null;
  stopSyncTimer(lobbyId);

  // Emit event for queue system to handle (includes repeat mode for 'all')
  io.to(lobbyId).emit('playback:trackEnded', {
    lobbyId,
    endedTrack: state.currentTrack,
    repeatMode: state.repeatMode,
  });

  return { lobbyId, endedTrack: state.currentTrack, repeatMode: state.repeatMode };
}

/**
 * Set repeat mode for a lobby
 */
function setRepeatMode(lobbyId, mode, io) {
  const state = getState(lobbyId);
  if (!state) return null;

  const validModes = ['off', 'all', 'one'];
  if (!validModes.includes(mode)) {
    return null;
  }

  state.repeatMode = mode;
  broadcastSync(lobbyId, io);

  return { lobbyId, repeatMode: mode };
}

/**
 * Get current repeat mode for a lobby
 */
function getRepeatMode(lobbyId) {
  const state = getState(lobbyId);
  return state ? state.repeatMode : 'off';
}

/**
 * Set next track (called by queue system after trackEnded)
 */
function setTrack(lobbyId, track, autoPlay, io) {
  const state = initLobby(lobbyId);

  state.currentTrack = track;
  state.position = 0;

  if (autoPlay && track) {
    state.isPlaying = true;
    state.startedAt = Date.now();
    startSyncTimer(lobbyId, io);
  } else {
    state.isPlaying = false;
    state.startedAt = null;
  }

  broadcastSync(lobbyId, io);

  return buildSyncMessage(state);
}

/**
 * Get current state for a user joining mid-song
 */
function getJoinState(lobbyId) {
  const state = getState(lobbyId);
  if (!state) return null;

  return buildSyncMessage(state);
}

/**
 * Start periodic sync timer
 */
function startSyncTimer(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state || state.syncTimer) return;

  state.syncTimer = setInterval(() => {
    broadcastSync(lobbyId, io);

    // Check if track has ended
    const pos = getCurrentPosition(state);
    if (state.currentTrack && state.currentTrack.duration && pos >= state.currentTrack.duration) {
      trackEnded(lobbyId, io);
    }
  }, SYNC_INTERVAL);
}

/**
 * Stop sync timer
 */
function stopSyncTimer(lobbyId) {
  const state = getState(lobbyId);
  if (!state || !state.syncTimer) return;

  clearInterval(state.syncTimer);
  state.syncTimer = null;
}

/**
 * Broadcast sync message to all clients in lobby
 */
function broadcastSync(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state) return;

  io.to(lobbyId).emit('playback:sync', buildSyncMessage(state));
}

/**
 * Clean up lobby playback state
 */
function cleanupLobby(lobbyId) {
  stopSyncTimer(lobbyId);
  lobbyPlayback.delete(lobbyId);
}

/**
 * Set up socket handlers for playback events
 */
function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    // Client requests current state (on join)
    socket.on('playback:getState', (lobbyId, callback) => {
      const state = getJoinState(lobbyId);
      if (callback) callback(state);
    });

    // Play command (with optional track)
    socket.on('playback:play', ({ lobbyId, track }) => {
      const result = play(lobbyId, track, io);
      if (result) {
        io.to(lobbyId).emit('playback:sync', result);
      }
    });

    // Pause command
    socket.on('playback:pause', ({ lobbyId }) => {
      pause(lobbyId, io);
    });

    // Resume command
    socket.on('playback:resume', ({ lobbyId }) => {
      resume(lobbyId, io);
    });

    // Seek command
    socket.on('playback:seek', ({ lobbyId, position }) => {
      seek(lobbyId, position, io);
    });

    // Client reports playback position (for drift detection)
    socket.on('playback:reportPosition', ({ lobbyId, clientPosition }) => {
      const state = getState(lobbyId);
      if (!state) return;

      const serverPosition = getCurrentPosition(state);
      const drift = Math.abs(serverPosition - clientPosition);

      // If drift exceeds threshold, force resync
      if (drift > 2) { // More than 2 seconds out of sync
        socket.emit('playback:forceSync', buildSyncMessage(state));
      }
    });

    // Note: playback:ended is handled in index.js to coordinate with queue

    // Set repeat mode
    socket.on('playback:setRepeat', ({ lobbyId, mode }) => {
      setRepeatMode(lobbyId, mode, io);
    });
  });
}

module.exports = {
  initLobby,
  getState,
  getCurrentPosition,
  play,
  pause,
  resume,
  seek,
  trackEnded,
  setTrack,
  setRepeatMode,
  getRepeatMode,
  getJoinState,
  cleanupLobby,
  setupSocketHandlers,
  // Exported for testing
  SYNC_INTERVAL,
};
