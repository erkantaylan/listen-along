const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createLobby, getLobby, joinLobby, leaveLobby, getLobbyUsers, getListeningMode, deleteLobby, isNameTaken, renameLobby, getAllLobbies, pinLobby, lobbies, cleanupEmptyLobbies } = require('./lobby');
const { getQueue, deleteQueue, hasQueue } = require('./queue');
const playback = require('./playback');

describe('Lobby System', () => {
  beforeEach(() => {
    // Clear all lobbies before each test
    lobbies.clear();
  });

  describe('createLobby', () => {
    it('creates a lobby with unique ID', () => {
      const lobby = createLobby('host-123');
      assert.ok(lobby.id);
      assert.strictEqual(lobby.id.length, 8);
      assert.strictEqual(lobby.hostId, 'host-123');
      assert.ok(lobby.users instanceof Map);
      assert.strictEqual(lobby.users.size, 0);
    });

    it('creates lobbies with different IDs', () => {
      const lobby1 = createLobby('host-1');
      const lobby2 = createLobby('host-2');
      assert.notStrictEqual(lobby1.id, lobby2.id);
    });
  });

  describe('getLobby', () => {
    it('returns existing lobby', () => {
      const created = createLobby('host-1');
      const found = getLobby(created.id);
      assert.strictEqual(found.id, created.id);
    });

    it('returns undefined for non-existent lobby', () => {
      const found = getLobby('nonexistent');
      assert.strictEqual(found, undefined);
    });
  });

  describe('joinLobby', () => {
    it('adds user to lobby', () => {
      const lobby = createLobby('host-1');
      const result = joinLobby(lobby.id, 'socket-123', 'Alice');

      assert.ok(result);
      assert.strictEqual(result.user.username, 'Alice');
      assert.strictEqual(result.user.socketId, 'socket-123');
      assert.strictEqual(result.lobby.users.size, 1);
    });

    it('generates default username if not provided', () => {
      const lobby = createLobby('host-1');
      const result = joinLobby(lobby.id, 'socket-123');

      assert.ok(result.user.username.startsWith('User-'));
    });

    it('returns null for non-existent lobby', () => {
      const result = joinLobby('nonexistent', 'socket-123', 'Alice');
      assert.strictEqual(result, null);
    });

    it('allows multiple users to join', () => {
      const lobby = createLobby('host-1');
      joinLobby(lobby.id, 'socket-1', 'Alice');
      joinLobby(lobby.id, 'socket-2', 'Bob');
      joinLobby(lobby.id, 'socket-3', 'Charlie');

      assert.strictEqual(lobby.users.size, 3);
    });
  });

  describe('leaveLobby', () => {
    it('removes user from lobby', () => {
      const lobby = createLobby('host-1');
      joinLobby(lobby.id, 'socket-123', 'Alice');
      const user = leaveLobby(lobby.id, 'socket-123');

      assert.strictEqual(user.username, 'Alice');
      assert.strictEqual(lobby.users.size, 0);
    });

    it('returns null for non-existent lobby', () => {
      const user = leaveLobby('nonexistent', 'socket-123');
      assert.strictEqual(user, null);
    });

    it('returns undefined for non-existent user', () => {
      const lobby = createLobby('host-1');
      const user = leaveLobby(lobby.id, 'nonexistent');
      assert.strictEqual(user, undefined);
    });
  });

  describe('getLobbyUsers', () => {
    it('returns array of users', () => {
      const lobby = createLobby('host-1');
      joinLobby(lobby.id, 'socket-1', 'Alice');
      joinLobby(lobby.id, 'socket-2', 'Bob');

      const users = getLobbyUsers(lobby.id);
      assert.strictEqual(users.length, 2);
      assert.ok(users.some(u => u.username === 'Alice'));
      assert.ok(users.some(u => u.username === 'Bob'));
    });

    it('returns empty array for non-existent lobby', () => {
      const users = getLobbyUsers('nonexistent');
      assert.deepStrictEqual(users, []);
    });
  });

  describe('listeningMode', () => {
    it('defaults to synchronized', () => {
      const lobby = createLobby('host-1');
      assert.strictEqual(lobby.listeningMode, 'synchronized');
    });

    it('can be set to independent', () => {
      const lobby = createLobby('host-1', null, 'independent');
      assert.strictEqual(lobby.listeningMode, 'independent');
    });

    it('sanitizes invalid mode to synchronized', () => {
      const lobby = createLobby('host-1', null, 'invalid');
      assert.strictEqual(lobby.listeningMode, 'synchronized');
    });

    it('getListeningMode returns mode for existing lobby', () => {
      const lobby = createLobby('host-1', null, 'independent');
      assert.strictEqual(getListeningMode(lobby.id), 'independent');
    });

    it('getListeningMode returns synchronized for non-existent lobby', () => {
      assert.strictEqual(getListeningMode('nonexistent'), 'synchronized');
    });

    it('is accessible via getLobby', () => {
      const created = createLobby('host-1', null, 'independent');
      const found = getLobby(created.id);
      assert.strictEqual(found.listeningMode, 'independent');
    });
  });

  describe('deleteLobby', () => {
    it('removes lobby', () => {
      const lobby = createLobby('host-1');
      const deleted = deleteLobby(lobby.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(getLobby(lobby.id), undefined);
    });

    it('returns false for non-existent lobby', () => {
      const deleted = deleteLobby('nonexistent');
      assert.strictEqual(deleted, false);
    });
  });

  describe('lobby naming', () => {
    it('creates a lobby with a name', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(lobby.name, 'My Lobby');
    });

    it('creates a lobby without a name', () => {
      const lobby = createLobby('host-1');
      assert.strictEqual(lobby.name, null);
    });

    it('includes name in getAllLobbies', () => {
      createLobby('host-1', null, 'synchronized', 'Named Lobby');
      const all = getAllLobbies();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].name, 'Named Lobby');
    });
  });

  describe('isNameTaken', () => {
    it('returns false when no lobbies have names', () => {
      createLobby('host-1');
      assert.strictEqual(isNameTaken('Test'), false);
    });

    it('returns true when name is taken', () => {
      createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken('My Lobby'), true);
    });

    it('is case-insensitive', () => {
      createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken('my lobby'), true);
      assert.strictEqual(isNameTaken('MY LOBBY'), true);
    });

    it('excludes a specific lobby from the check', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken('My Lobby', lobby.id), false);
    });

    it('returns false for null or empty name', () => {
      createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken(null), false);
      assert.strictEqual(isNameTaken(''), false);
    });
  });

  describe('renameLobby', () => {
    it('renames an existing lobby', async () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'Old Name');
      const result = await renameLobby(lobby.id, 'New Name');
      assert.ok(result.lobby);
      assert.strictEqual(result.lobby.name, 'New Name');
      // Verify in-memory state updated
      const found = getLobby(lobby.id);
      assert.strictEqual(found.name, 'New Name');
    });

    it('returns null for non-existent lobby', async () => {
      const result = await renameLobby('nonexistent', 'Name');
      assert.strictEqual(result, null);
    });

    it('returns error for empty name', async () => {
      const lobby = createLobby('host-1');
      const result = await renameLobby(lobby.id, '');
      assert.ok(result.error);
      assert.strictEqual(result.error, 'Name cannot be empty');
    });

    it('returns error for name over 50 characters', async () => {
      const lobby = createLobby('host-1');
      const longName = 'a'.repeat(51);
      const result = await renameLobby(lobby.id, longName);
      assert.ok(result.error);
      assert.strictEqual(result.error, 'Name must be 50 characters or less');
    });

    it('returns error when name is already taken', async () => {
      createLobby('host-1', null, 'synchronized', 'Taken Name');
      const lobby2 = createLobby('host-2');
      const result = await renameLobby(lobby2.id, 'Taken Name');
      assert.ok(result.error);
      assert.strictEqual(result.error, 'A lobby with that name already exists');
    });

    it('allows renaming to same name (own lobby)', async () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Name');
      const result = await renameLobby(lobby.id, 'My Name');
      assert.ok(result.lobby);
      assert.strictEqual(result.lobby.name, 'My Name');
    });

    it('trims whitespace from name', async () => {
      const lobby = createLobby('host-1');
      const result = await renameLobby(lobby.id, '  Trimmed  ');
      assert.ok(result.lobby);
      assert.strictEqual(result.lobby.name, 'Trimmed');
    });
  });

  describe('pinLobby', () => {
    it('pins a lobby', async () => {
      const lobby = createLobby('host-1');
      const result = await pinLobby(lobby.id, true);
      assert.ok(result);
      assert.strictEqual(result.lobby.pinned, true);
      // Verify in-memory state
      const found = getLobby(lobby.id);
      assert.strictEqual(found.pinned, true);
    });

    it('unpins a lobby', async () => {
      const lobby = createLobby('host-1');
      await pinLobby(lobby.id, true);
      const result = await pinLobby(lobby.id, false);
      assert.ok(result);
      assert.strictEqual(result.lobby.pinned, false);
    });

    it('returns null for non-existent lobby', async () => {
      const result = await pinLobby('nonexistent', true);
      assert.strictEqual(result, null);
    });

    it('includes pinned state in getAllLobbies', async () => {
      const lobby = createLobby('host-1');
      await pinLobby(lobby.id, true);
      const all = getAllLobbies();
      assert.strictEqual(all[0].pinned, true);
    });
  });

  describe('cleanupEmptyLobbies', () => {
    it('cleans up queue and playback Maps for expired empty lobbies', async () => {
      const lobby = createLobby('host-1', 'cleanup-test');
      const lobbyId = lobby.id;

      // Set up queue and playback state for this lobby
      getQueue(lobbyId);
      playback.initLobby(lobbyId);

      assert.ok(hasQueue(lobbyId), 'queue should exist before cleanup');
      assert.ok(playback.getState(lobbyId), 'playback state should exist before cleanup');

      // Make the lobby expired (older than 24h timeout)
      const lobbyData = lobbies.get(lobbyId);
      lobbyData.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyLobbies();

      // Lobby should be removed from memory
      assert.strictEqual(lobbies.has(lobbyId), false, 'lobby should be removed from memory');
      // Queue and playback should also be cleaned up
      assert.strictEqual(hasQueue(lobbyId), false, 'queue should be cleaned up');
      assert.strictEqual(playback.getState(lobbyId), null, 'playback state should be cleaned up');
    });

    it('does not clean up pinned lobbies even if expired', async () => {
      const lobby = createLobby('host-1', 'pinned-test');
      const lobbyId = lobby.id;

      getQueue(lobbyId);
      playback.initLobby(lobbyId);

      // Pin the lobby
      await pinLobby(lobbyId, true);

      // Make the lobby expired (older than 24h timeout)
      const lobbyData = lobbies.get(lobbyId);
      lobbyData.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyLobbies();

      // Pinned lobby should NOT be removed
      assert.ok(lobbies.has(lobbyId), 'pinned lobby should not be removed');
      assert.ok(hasQueue(lobbyId), 'queue for pinned lobby should not be removed');
    });

    it('does not clean up lobbies that are not expired', async () => {
      const lobby = createLobby('host-1', 'active-test');

      getQueue(lobby.id);
      playback.initLobby(lobby.id);

      await cleanupEmptyLobbies();

      assert.ok(lobbies.has(lobby.id), 'active lobby should not be removed');
      assert.ok(hasQueue(lobby.id), 'queue for active lobby should not be removed');
    });
  });
});
