const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const playback = require('./playback');

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

  describe('cleanupLobby', () => {
    test('removes lobby state', () => {
      playback.initLobby('test-lobby');
      assert(playback.getState('test-lobby') !== null);

      playback.cleanupLobby('test-lobby');
      assert.equal(playback.getState('test-lobby'), null);
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
});
