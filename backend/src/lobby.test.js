const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createLobby, getLobby, joinLobby, leaveLobby, getLobbyUsers, deleteLobby, lobbies } = require('./lobby');

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
});
