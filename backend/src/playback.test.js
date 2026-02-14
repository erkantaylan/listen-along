const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const playback = require('./playback');
const lobby = require('./lobby');

// Mock socket.io
function createMockIo() {
  const rooms = new Map();
  const emits = [];

  return {
    to: (room) => ({
      emit: (event, data) => {
        emits.push({ room, event, data });
      }
    }),
    on: mock.fn(),
    emits,
    rooms
  };
}

describe('Playback Module', () => {
  beforeEach(() => {
    // Clean up any existing lobby state
    playback.cleanupLobby('test-lobby');
  });

  afterEach(() => {
    // Ensure timers are stopped after each test
    playback.cleanupLobby('test-lobby');
  });

  describe('initLobby', () => {
    test('creates new lobby state', () => {
      const state = playback.initLobby('test-lobby');

      assert.equal(state.lobbyId, 'test-lobby');
      assert.equal(state.currentTrack, null);
      assert.equal(state.position, 0);
      assert.equal(state.isPlaying, false);
    });

    test('returns existing state if already initialized', () => {
      const state1 = playback.initLobby('test-lobby');
      state1.position = 42;

      const state2 = playback.initLobby('test-lobby');
      assert.equal(state2.position, 42);
    });
  });

  describe('getState', () => {
    test('returns null for non-existent lobby', () => {
      assert.equal(playback.getState('non-existent'), null);
    });

    test('returns state for existing lobby', () => {
      playback.initLobby('test-lobby');
      const state = playback.getState('test-lobby');

      assert.equal(state.lobbyId, 'test-lobby');
    });
  });

  describe('play', () => {
    test('starts playback with new track', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      const result = playback.play('test-lobby', track, io);

      assert.equal(result.type, 'sync');
      assert.equal(result.track.id, '1');
      assert.equal(result.isPlaying, true);
      assert(result.position >= 0);
    });

    test('broadcasts sync to lobby', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);

      // Should have emitted sync message
      const syncEmit = io.emits.find(e => e.event === 'playback:sync');
      assert(syncEmit);
      assert.equal(syncEmit.room, 'test-lobby');
    });
  });

  describe('pause', () => {
    test('pauses playback and captures position', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      const result = playback.pause('test-lobby', io);

      assert.equal(result.isPlaying, false);
      assert(result.position >= 0);
    });

    test('returns null for non-existent lobby', () => {
      const io = createMockIo();
      const result = playback.pause('non-existent', io);

      assert.equal(result, null);
    });
  });

  describe('resume', () => {
    test('resumes playback from current position', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      playback.pause('test-lobby', io);
      const result = playback.resume('test-lobby', io);

      assert.equal(result.isPlaying, true);
    });

    test('returns null if no track loaded', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const result = playback.resume('test-lobby', io);
      assert.equal(result, null);
    });
  });

  describe('seek', () => {
    test('updates position', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      const result = playback.seek('test-lobby', 60, io);

      assert(result.position >= 60);
    });

    test('clamps negative position to zero', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      const result = playback.seek('test-lobby', -10, io);

      assert(result.position >= 0);
    });
  });

  describe('setTrack', () => {
    test('sets track without autoplay', () => {
      const io = createMockIo();
      const track = { id: '2', title: 'New Song', duration: 200 };

      const result = playback.setTrack('test-lobby', track, false, io);

      assert.equal(result.track.id, '2');
      assert.equal(result.isPlaying, false);
      assert.equal(result.position, 0);
    });

    test('sets track with autoplay', () => {
      const io = createMockIo();
      const track = { id: '2', title: 'New Song', duration: 200 };

      const result = playback.setTrack('test-lobby', track, true, io);

      assert.equal(result.track.id, '2');
      assert.equal(result.isPlaying, true);
    });
  });

  describe('getJoinState', () => {
    test('returns current playback state for new user', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      const state = playback.getJoinState('test-lobby');

      assert.equal(state.type, 'sync');
      assert.equal(state.track.id, '1');
      assert(state.serverTime > 0);
    });

    test('returns null for non-existent lobby', () => {
      const state = playback.getJoinState('non-existent');
      assert.equal(state, null);
    });
  });

  describe('getCurrentPosition', () => {
    test('returns static position when paused', () => {
      playback.initLobby('test-lobby');
      const state = playback.getState('test-lobby');
      state.position = 30;
      state.isPlaying = false;

      const pos = playback.getCurrentPosition(state);
      assert.equal(pos, 30);
    });

    test('returns elapsed position when playing', () => {
      playback.initLobby('test-lobby');
      const state = playback.getState('test-lobby');
      state.position = 30;
      state.isPlaying = true;
      state.startedAt = Date.now() - 5000; // 5 seconds ago

      const pos = playback.getCurrentPosition(state);
      assert(pos >= 35 && pos < 36); // Should be ~35 seconds
    });
  });

  describe('stopSyncTimer', () => {
    test('stops sync timer without removing lobby state', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');
      lobby.createLobby('test-lobby-sync');
      playback.initLobby('test-lobby');

      // Set a track and play to trigger sync timer start indirectly
      const state = playback.getState('test-lobby');
      assert(state !== null);

      // Manually verify stopSyncTimer doesn't crash on lobby without timer
      playback.stopSyncTimer('test-lobby');
      assert(playback.getState('test-lobby') !== null, 'state should still exist after stopSyncTimer');
    });

    test('is a no-op for non-existent lobby', () => {
      // Should not throw
      playback.stopSyncTimer('non-existent-lobby');
    });
  });

  describe('cleanupLobby', () => {
    test('removes lobby state', () => {
      playback.initLobby('test-lobby');
      assert(playback.getState('test-lobby') !== null);

      playback.cleanupLobby('test-lobby');
      assert.equal(playback.getState('test-lobby'), null);
    });
  });

  describe('shuffle', () => {
    test('toggleShuffle enables shuffle mode', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const result = playback.toggleShuffle('test-lobby', true, 5, io);

      assert.equal(result.shuffleEnabled, true);
      const state = playback.getState('test-lobby');
      assert.equal(state.shuffleEnabled, true);
      assert.equal(state.shuffledIndices.length, 5);
    });

    test('toggleShuffle disables shuffle mode', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      playback.toggleShuffle('test-lobby', true, 5, io);
      const result = playback.toggleShuffle('test-lobby', false, 5, io);

      assert.equal(result.shuffleEnabled, false);
      const state = playback.getState('test-lobby');
      assert.equal(state.shuffleEnabled, false);
      assert.equal(state.shuffledIndices.length, 0);
    });

    test('toggleShuffle broadcasts to lobby', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      playback.toggleShuffle('test-lobby', true, 5, io);

      const shuffleEmit = io.emits.find(e => e.event === 'playback:shuffle');
      assert(shuffleEmit);
      assert.equal(shuffleEmit.room, 'test-lobby');
      assert.equal(shuffleEmit.data.shuffleEnabled, true);
    });

    test('getShuffleState returns shuffle state', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');
      playback.toggleShuffle('test-lobby', true, 5, io);

      const state = playback.getShuffleState('test-lobby');

      assert.equal(state.shuffleEnabled, true);
    });

    test('getShuffleState returns false for uninitialized lobby', () => {
      const state = playback.getShuffleState('non-existent');

      assert.equal(state.shuffleEnabled, false);
    });

    test('getNextShuffleIndex returns index from shuffled order', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');
      playback.toggleShuffle('test-lobby', true, 5, io);

      const nextIndex = playback.getNextShuffleIndex('test-lobby', 5);

      assert(nextIndex !== null);
      assert(nextIndex >= 0 && nextIndex < 5);
    });

    test('getNextShuffleIndex returns null when shuffle disabled', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const nextIndex = playback.getNextShuffleIndex('test-lobby', 5);

      assert.equal(nextIndex, null);
    });

    test('updateShuffleForQueueChange regenerates indices', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');
      playback.toggleShuffle('test-lobby', true, 3, io);

      const stateBefore = playback.getState('test-lobby');
      assert.equal(stateBefore.shuffledIndices.length, 3);

      playback.updateShuffleForQueueChange('test-lobby', 5);

      const stateAfter = playback.getState('test-lobby');
      assert.equal(stateAfter.shuffledIndices.length, 5);
    });
  });

  describe('setRepeatMode', () => {
    test('sets repeat mode to all', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const result = playback.setRepeatMode('test-lobby', 'all', io);

      assert.equal(result.repeatMode, 'all');
      assert.equal(playback.getRepeatMode('test-lobby'), 'all');
    });

    test('sets repeat mode to one', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const result = playback.setRepeatMode('test-lobby', 'one', io);

      assert.equal(result.repeatMode, 'one');
    });

    test('rejects invalid repeat mode', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      const result = playback.setRepeatMode('test-lobby', 'invalid', io);

      assert.equal(result, null);
    });

    test('returns null for non-existent lobby', () => {
      const io = createMockIo();
      const result = playback.setRepeatMode('non-existent', 'all', io);

      assert.equal(result, null);
    });

    test('broadcasts sync after mode change', () => {
      const io = createMockIo();
      playback.initLobby('test-lobby');

      playback.setRepeatMode('test-lobby', 'all', io);

      const syncEmit = io.emits.find(e => e.event === 'playback:sync');
      assert(syncEmit);
      assert.equal(syncEmit.data.repeatMode, 'all');
    });
  });

  describe('getRepeatMode', () => {
    test('returns off for new lobby', () => {
      playback.initLobby('test-lobby');
      assert.equal(playback.getRepeatMode('test-lobby'), 'off');
    });

    test('returns off for non-existent lobby', () => {
      assert.equal(playback.getRepeatMode('non-existent'), 'off');
    });
  });

  describe('trackEnded with repeat-one', () => {
    test('restarts track when repeat mode is one', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      playback.setRepeatMode('test-lobby', 'one', io);

      // Simulate track ending
      const state = playback.getState('test-lobby');
      state.position = 180; // At end of track

      const result = playback.trackEnded('test-lobby', io);

      assert.equal(result.repeated, true);
      assert.equal(result.track.id, '1');

      // State should be reset to beginning
      const newState = playback.getState('test-lobby');
      assert.equal(newState.isPlaying, true);
      assert.equal(newState.position, 0);
    });
  });

  describe('sync message includes repeatMode', () => {
    test('initLobby sets default repeat mode', () => {
      const state = playback.initLobby('test-lobby');
      assert.equal(state.repeatMode, 'off');
    });

    test('play sync message includes repeatMode', () => {
      const io = createMockIo();
      const track = { id: '1', title: 'Test Song', duration: 180 };

      const result = playback.play('test-lobby', track, io);

      assert.equal(result.repeatMode, 'off');
    });
  });

  describe('independent listening mode', () => {
    beforeEach(() => {
      lobby.lobbies.clear();
    });

    test('does not broadcast sync for independent lobbies', () => {
      const io = createMockIo();
      // Create an independent lobby
      lobby.createLobby(null, 'test-lobby', 'independent');
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);

      // Should NOT have any playback:sync emits
      const syncEmits = io.emits.filter(e => e.event === 'playback:sync');
      assert.equal(syncEmits.length, 0);
    });

    test('broadcasts sync for synchronized lobbies', () => {
      const io = createMockIo();
      // Create a synchronized lobby
      lobby.createLobby(null, 'test-lobby', 'synchronized');
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);

      // Should have playback:sync emits
      const syncEmits = io.emits.filter(e => e.event === 'playback:sync');
      assert(syncEmits.length > 0);
    });

    test('pause does not broadcast sync for independent lobbies', () => {
      const io = createMockIo();
      lobby.createLobby(null, 'test-lobby', 'independent');
      const track = { id: '1', title: 'Test Song', duration: 180 };

      playback.play('test-lobby', track, io);
      io.emits.length = 0; // Clear emits

      playback.pause('test-lobby', io);

      const syncEmits = io.emits.filter(e => e.event === 'playback:sync');
      assert.equal(syncEmits.length, 0);
    });
  });
});
