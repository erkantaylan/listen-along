/**
 * Playback synchronization module
 *
 * Manages synchronized playback state across all clients in a lobby.
 * Server is the single source of truth for:
 * - Current track
 * - Playback position (timestamp)
 * - Play/pause state
 */

const db = require('./db');
const lobby = require('./lobby');

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
    currentTrack: null,      // { id, title, duration, url, addedBy, thumbnail }
    position: 0,             // Current position in seconds
    isPlaying: false,
    startedAt: null,         // Server timestamp when playback started
    syncTimer: null,         // Interval for sync broadcasts
    shuffleEnabled: false,   // Shuffle mode toggle
    shuffledIndices: [],     // Shuffled playback order (indices into queue)
    shuffleIndex: 0,         // Current position in shuffled order
    repeatMode: 'off',       // 'off', 'all', 'one'
  };

  lobbyPlayback.set(lobbyId, state);
  return state;
}

/**
 * Initialize playback state from database if available
 */
async function initLobbyFromDB(lobbyId) {
  if (lobbyPlayback.has(lobbyId)) {
    return lobbyPlayback.get(lobbyId);
  }

  const state = initLobby(lobbyId);

  if (db.isAvailable()) {
    try {
      const result = await db.query(
        'SELECT current_track, position, is_playing, shuffle_enabled, shuffled_indices, shuffle_index, repeat_mode FROM playback_state WHERE lobby_id = $1',
        [lobbyId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        state.currentTrack = row.current_track;
        state.position = parseFloat(row.position) || 0;
        // Note: is_playing from DB indicates if it was playing when persisted
        // We start paused to avoid sync issues on reconnect
        state.isPlaying = false;
        state.shuffleEnabled = row.shuffle_enabled || false;
        state.shuffledIndices = row.shuffled_indices || [];
        state.shuffleIndex = row.shuffle_index || 0;
        state.repeatMode = row.repeat_mode || 'off';
      }
    } catch (err) {
      console.error('Failed to load playback state from DB:', err.message);
    }
  }

  return state;
}

/**
 * Persist playback state to database
 */
async function persistState(lobbyId) {
  if (!db.isAvailable()) return;

  const state = getState(lobbyId);
  if (!state) return;

  try {
    await db.query(
      `INSERT INTO playback_state (lobby_id, current_track, position, is_playing, shuffle_enabled, shuffled_indices, shuffle_index, repeat_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (lobby_id) DO UPDATE SET
         current_track = $2,
         position = $3,
         is_playing = $4,
         shuffle_enabled = $5,
         shuffled_indices = $6,
         shuffle_index = $7,
         repeat_mode = $8`,
      [
        lobbyId,
        state.currentTrack ? JSON.stringify(state.currentTrack) : null,
        getCurrentPosition(state),
        state.isPlaying,
        state.shuffleEnabled,
        JSON.stringify(state.shuffledIndices),
        state.shuffleIndex,
        state.repeatMode
      ]
    );
  } catch (err) {
    console.error('Failed to persist playback state:', err.message);
  }
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

  // Persist state
  persistState(lobbyId);

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

  // Persist state
  persistState(lobbyId);

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

  // Persist state
  persistState(lobbyId);

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

  // Persist state
  persistState(lobbyId);

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
    persistState(lobbyId);
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

  // Persist state
  persistState(lobbyId);

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

  // Persist state
  persistState(lobbyId);

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

  // Persist state
  persistState(lobbyId);

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
 * Skips for independent listening lobbies
 */
function startSyncTimer(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state || state.syncTimer) return;

  // Don't start sync timer for independent listening lobbies
  if (lobby.getListeningMode(lobbyId) === 'independent') return;

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
 * Skips broadcasting for independent listening lobbies
 */
function broadcastSync(lobbyId, io) {
  const state = getState(lobbyId);
  if (!state) return;

  // Skip sync broadcasting for independent listening lobbies
  if (lobby.getListeningMode(lobbyId) === 'independent') return;

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
 * Remove playback entries for lobby IDs not in the provided set of valid IDs.
 * Called by lobby cleanup to prevent orphaned Map entries from accumulating.
 */
function cleanupOrphanedPlayback(validLobbyIds) {
  for (const lobbyId of lobbyPlayback.keys()) {
    if (!validLobbyIds.has(lobbyId)) {
      cleanupLobby(lobbyId);
    }
  }
}

/**
 * Fisher-Yates shuffle algorithm
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Toggle shuffle mode
 */
function toggleShuffle(lobbyId, enabled, queueLength, io) {
  const state = getState(lobbyId);
  if (!state) return null;

  state.shuffleEnabled = enabled;

  if (enabled && queueLength > 0) {
    // Generate shuffled indices (0 to queueLength-1)
    const indices = Array.from({ length: queueLength }, (_, i) => i);
    state.shuffledIndices = shuffleArray(indices);
    state.shuffleIndex = 0;
  } else {
    state.shuffledIndices = [];
    state.shuffleIndex = 0;
  }

  // Broadcast shuffle state to all clients
  io.to(lobbyId).emit('playback:shuffle', {
    lobbyId,
    shuffleEnabled: state.shuffleEnabled,
  });

  // Persist state
  persistState(lobbyId);

  return { shuffleEnabled: state.shuffleEnabled };
}

/**
 * Get shuffle state for a lobby
 */
function getShuffleState(lobbyId) {
  const state = getState(lobbyId);
  if (!state) return { shuffleEnabled: false };
  return { shuffleEnabled: state.shuffleEnabled };
}

/**
 * Get next song index when shuffle is enabled
 * Returns the queue index of the next song to play
 */
function getNextShuffleIndex(lobbyId, queueLength) {
  const state = getState(lobbyId);
  if (!state || !state.shuffleEnabled || queueLength === 0) {
    return null;
  }

  // Move to next position in shuffle order
  state.shuffleIndex = (state.shuffleIndex + 1) % state.shuffledIndices.length;

  // If we've gone through all songs, reshuffle
  if (state.shuffleIndex === 0) {
    const indices = Array.from({ length: queueLength }, (_, i) => i);
    state.shuffledIndices = shuffleArray(indices);
  }

  // Persist state
  persistState(lobbyId);

  return state.shuffledIndices[state.shuffleIndex];
}

/**
 * Update shuffle indices when queue changes
 */
function updateShuffleForQueueChange(lobbyId, queueLength) {
  const state = getState(lobbyId);
  if (!state || !state.shuffleEnabled) return;

  // Regenerate shuffle indices for new queue length
  if (queueLength > 0) {
    const indices = Array.from({ length: queueLength }, (_, i) => i);
    state.shuffledIndices = shuffleArray(indices);
    state.shuffleIndex = 0;
  } else {
    state.shuffledIndices = [];
    state.shuffleIndex = 0;
  }

  // Persist state
  persistState(lobbyId);
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

    // Toggle shuffle mode
    socket.on('playback:shuffle', ({ lobbyId, enabled, queueLength }) => {
      toggleShuffle(lobbyId, enabled, queueLength, io);
    });

    // Get shuffle state (on join)
    socket.on('playback:getShuffleState', (lobbyId, callback) => {
      const shuffleState = getShuffleState(lobbyId);
      if (callback) callback(shuffleState);
    });
  });
}

module.exports = {
  initLobby,
  initLobbyFromDB,
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
  cleanupOrphanedPlayback,
  setupSocketHandlers,
  toggleShuffle,
  getShuffleState,
  getNextShuffleIndex,
  updateShuffleForQueueChange,
  stopSyncTimer,
  // Exported for testing
  SYNC_INTERVAL,
};
