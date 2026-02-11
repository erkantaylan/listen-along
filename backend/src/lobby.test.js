const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createLobby, getLobby, joinLobby, leaveLobby, getLobbyUsers, getListeningMode, renameLobby, isNameTaken, deleteLobby, lobbies } = require('./lobby');

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

  describe('lobby name', () => {
    it('creates lobby with name', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(lobby.name, 'My Lobby');
    });

    it('creates lobby without name (null)', () => {
      const lobby = createLobby('host-1');
      assert.strictEqual(lobby.name, null);
    });

    it('trims lobby name', () => {
      const lobby = createLobby('host-1', null, 'synchronized', '  Spaced Name  ');
      assert.strictEqual(lobby.name, 'Spaced Name');
    });

    it('truncates name to 50 characters', () => {
      const longName = 'A'.repeat(60);
      const lobby = createLobby('host-1', null, 'synchronized', longName);
      assert.strictEqual(lobby.name.length, 50);
    });

    it('name is accessible via getLobby', () => {
      const created = createLobby('host-1', null, 'synchronized', 'Test Lobby');
      const found = getLobby(created.id);
      assert.strictEqual(found.name, 'Test Lobby');
    });
  });

  describe('renameLobby', () => {
    it('renames an existing lobby', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'Old Name');
      const result = renameLobby(lobby.id, 'New Name');
      assert.strictEqual(result.name, 'New Name');
      assert.strictEqual(getLobby(lobby.id).name, 'New Name');
    });

    it('returns null for non-existent lobby', () => {
      const result = renameLobby('nonexistent', 'Name');
      assert.strictEqual(result, null);
    });

    it('returns null for empty name', () => {
      const lobby = createLobby('host-1');
      const result = renameLobby(lobby.id, '');
      assert.strictEqual(result, null);
    });

    it('returns null for whitespace-only name', () => {
      const lobby = createLobby('host-1');
      const result = renameLobby(lobby.id, '   ');
      assert.strictEqual(result, null);
    });

    it('trims the new name', () => {
      const lobby = createLobby('host-1');
      const result = renameLobby(lobby.id, '  Trimmed  ');
      assert.strictEqual(result.name, 'Trimmed');
    });

    it('truncates to 50 characters', () => {
      const lobby = createLobby('host-1');
      const longName = 'B'.repeat(60);
      const result = renameLobby(lobby.id, longName);
      assert.strictEqual(result.name.length, 50);
    });

    it('rejects duplicate name (case-insensitive)', () => {
      createLobby('host-1', null, 'synchronized', 'Taken Name');
      const lobby2 = createLobby('host-2');
      const result = renameLobby(lobby2.id, 'taken name');
      assert.ok(result.error);
    });

    it('allows renaming to same name on same lobby', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Name');
      const result = renameLobby(lobby.id, 'My Name');
      assert.strictEqual(result.name, 'My Name');
      assert.ok(!result.error);
    });
  });

  describe('isNameTaken', () => {
    it('returns false when no lobbies have names', () => {
      createLobby('host-1');
      assert.strictEqual(isNameTaken('Any Name'), false);
    });

    it('returns true for taken name', () => {
      createLobby('host-1', null, 'synchronized', 'Existing');
      assert.strictEqual(isNameTaken('Existing'), true);
    });

    it('is case-insensitive', () => {
      createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken('my lobby'), true);
      assert.strictEqual(isNameTaken('MY LOBBY'), true);
    });

    it('excludes specified lobby from check', () => {
      const lobby = createLobby('host-1', null, 'synchronized', 'My Lobby');
      assert.strictEqual(isNameTaken('My Lobby', lobby.id), false);
    });

    it('returns false for null/empty name', () => {
      assert.strictEqual(isNameTaken(null), false);
      assert.strictEqual(isNameTaken(''), false);
      assert.strictEqual(isNameTaken('  '), false);
    });
  });
});
