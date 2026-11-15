const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createPlaylist, getPlaylist, joinPlaylist, leavePlaylist, getPlaylistUsers, deletePlaylist, isNameTaken, renamePlaylist, getAllPlaylists, pinPlaylist, setVisibility, playlists: lobbies, cleanupEmptyPlaylists } = require('./core/playlists/index.ts').playlist;
const { getQueue, deleteQueue, hasQueue } = require('./core/queue/index.ts');

describe('Lobby System', () => {
  beforeEach(() => {
    // Clear all lobbies before each test
    lobbies.clear();
  });

  describe('createPlaylist', () => {
    it('creates a lobby with unique ID', () => {
      const lobby = createPlaylist('host-123');
      assert.ok(lobby.id);
      assert.strictEqual(lobby.id.length, 8);
      assert.strictEqual(lobby.ownerId, 'host-123');
      assert.ok(lobby.users instanceof Map);
      assert.strictEqual(lobby.users.size, 0);
    });

    it('creates lobbies with different IDs', () => {
      const lobby1 = createPlaylist('host-1');
      const lobby2 = createPlaylist('host-2');
      assert.notStrictEqual(lobby1.id, lobby2.id);
    });

    it('defaults new lobbies to public', () => {
      const lobby = createPlaylist('host-1');
      assert.strictEqual(lobby.visibility, 'public');
    });

    it('honors an explicit private visibility', () => {
      const lobby = createPlaylist('host-1', null, null, 'private');
      assert.strictEqual(lobby.visibility, 'private');
    });

    it('creates ownerless playlists public even when private is asked for', () => {
      const lobby = createPlaylist(null, null, null, 'private');
      assert.strictEqual(lobby.visibility, 'public');
    });

    it('normalizes a null host to null (anonymous, no owner)', () => {
      const lobby = createPlaylist(null);
      assert.strictEqual(lobby.ownerId, null);
    });
  });

  describe('visibility', () => {
    it('setVisibility switches visibility on the in-memory lobby', async () => {
      const lobby = createPlaylist('host-1', 'vis-test');
      assert.strictEqual(lobby.visibility, 'public');

      await setVisibility('vis-test', 'private');
      assert.strictEqual(lobbies.get('vis-test').visibility, 'private');

      await setVisibility('vis-test', 'public');
      assert.strictEqual(lobbies.get('vis-test').visibility, 'public');
    });

    it('getAllPlaylists exposes ownerId and visibility', () => {
      createPlaylist('owner-x', 'all-test', 'Mine', 'private');
      const entry = getAllPlaylists().find(l => l.id === 'all-test');
      assert.ok(entry);
      assert.strictEqual(entry.ownerId, 'owner-x');
      assert.strictEqual(entry.visibility, 'private');
    });
  });

  describe('getPlaylist', () => {
    it('returns existing lobby', () => {
      const created = createPlaylist('host-1');
      const found = getPlaylist(created.id);
      assert.strictEqual(found.id, created.id);
    });

    it('returns undefined for non-existent lobby', () => {
      const found = getPlaylist('nonexistent');
      assert.strictEqual(found, undefined);
    });
  });

  describe('joinPlaylist', () => {
    it('adds user to lobby', () => {
      const lobby = createPlaylist('host-1');
      const result = joinPlaylist(lobby.id, 'socket-123', 'Alice');

      assert.ok(result);
      assert.strictEqual(result.user.username, 'Alice');
      assert.strictEqual(result.user.socketId, 'socket-123');
      assert.strictEqual(result.playlist.users.size, 1);
    });

    it('generates default username if not provided', () => {
      const lobby = createPlaylist('host-1');
      const result = joinPlaylist(lobby.id, 'socket-123');

      assert.ok(result.user.username.startsWith('User-'));
    });

    it('returns null for non-existent lobby', () => {
      const result = joinPlaylist('nonexistent', 'socket-123', 'Alice');
      assert.strictEqual(result, null);
    });

    it('allows multiple users to join', () => {
      const lobby = createPlaylist('host-1');
      joinPlaylist(lobby.id, 'socket-1', 'Alice');
      joinPlaylist(lobby.id, 'socket-2', 'Bob');
      joinPlaylist(lobby.id, 'socket-3', 'Charlie');

      assert.strictEqual(lobby.users.size, 3);
    });
  });

  describe('leavePlaylist', () => {
    it('removes user from lobby', () => {
      const lobby = createPlaylist('host-1');
      joinPlaylist(lobby.id, 'socket-123', 'Alice');
      const user = leavePlaylist(lobby.id, 'socket-123');

      assert.strictEqual(user.username, 'Alice');
      assert.strictEqual(lobby.users.size, 0);
    });

    it('returns null for non-existent lobby', () => {
      const user = leavePlaylist('nonexistent', 'socket-123');
      assert.strictEqual(user, null);
    });

    it('returns undefined for non-existent user', () => {
      const lobby = createPlaylist('host-1');
      const user = leavePlaylist(lobby.id, 'nonexistent');
      assert.strictEqual(user, undefined);
    });
  });

  describe('getPlaylistUsers', () => {
    it('returns array of users', () => {
      const lobby = createPlaylist('host-1');
      joinPlaylist(lobby.id, 'socket-1', 'Alice');
      joinPlaylist(lobby.id, 'socket-2', 'Bob');

      const users = getPlaylistUsers(lobby.id);
      assert.strictEqual(users.length, 2);
      assert.ok(users.some(u => u.username === 'Alice'));
      assert.ok(users.some(u => u.username === 'Bob'));
    });

    it('returns empty array for non-existent lobby', () => {
      const users = getPlaylistUsers('nonexistent');
      assert.deepStrictEqual(users, []);
    });
  });


  describe('deletePlaylist', () => {
    it('removes lobby', () => {
      const lobby = createPlaylist('host-1');
      const deleted = deletePlaylist(lobby.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(getPlaylist(lobby.id), undefined);
    });

    it('returns false for non-existent lobby', () => {
      const deleted = deletePlaylist('nonexistent');
      assert.strictEqual(deleted, false);
    });
  });

  describe('lobby naming', () => {
    it('creates a lobby with a name', () => {
      const lobby = createPlaylist('host-1', null, 'My Lobby');
      assert.strictEqual(lobby.name, 'My Lobby');
    });

    it('creates a lobby without a name', () => {
      const lobby = createPlaylist('host-1');
      assert.strictEqual(lobby.name, null);
    });

    it('includes name in getAllPlaylists', () => {
      createPlaylist('host-1', null, 'Named Lobby');
      const all = getAllPlaylists();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].name, 'Named Lobby');
    });
  });

  describe('isNameTaken', () => {
    it('returns false when no lobbies have names', () => {
      createPlaylist('host-1');
      assert.strictEqual(isNameTaken('Test'), false);
    });

    it('returns true when name is taken', () => {
      createPlaylist('host-1', null, 'My Lobby');
      assert.strictEqual(isNameTaken('My Lobby'), true);
    });

    it('is case-insensitive', () => {
      createPlaylist('host-1', null, 'My Lobby');
      assert.strictEqual(isNameTaken('my lobby'), true);
      assert.strictEqual(isNameTaken('MY LOBBY'), true);
    });

    it('excludes a specific lobby from the check', () => {
      const lobby = createPlaylist('host-1', null, 'My Lobby');
      assert.strictEqual(isNameTaken('My Lobby', lobby.id), false);
    });

    it("ignores playlists the caller cannot see (no leak of others' private names)", () => {
      createPlaylist('owner-a', null, 'Secret Mix', 'private');
      const access = require('./core/playlists/index.ts').access;
      assert.strictEqual(isNameTaken('Secret Mix', null, l => access.canView(l, 'owner-b')), false);
      assert.strictEqual(isNameTaken('Secret Mix', null, l => access.canView(l, 'owner-a')), true);
    });

    it('returns false for null or empty name', () => {
      createPlaylist('host-1', null, 'My Lobby');
      assert.strictEqual(isNameTaken(null), false);
      assert.strictEqual(isNameTaken(''), false);
    });
  });

  describe('renamePlaylist', () => {
    it('renames an existing lobby', async () => {
      const lobby = createPlaylist('host-1', null, 'Old Name');
      const result = await renamePlaylist(lobby.id, 'New Name');
      assert.ok(result.playlist);
      assert.strictEqual(result.playlist.name, 'New Name');
      // Verify in-memory state updated
      const found = getPlaylist(lobby.id);
      assert.strictEqual(found.name, 'New Name');
    });

    it('returns null for non-existent lobby', async () => {
      const result = await renamePlaylist('nonexistent', 'Name');
      assert.strictEqual(result, null);
    });

    it('returns error for empty name', async () => {
      const lobby = createPlaylist('host-1');
      const result = await renamePlaylist(lobby.id, '');
      assert.ok(result.error);
      assert.strictEqual(result.error, 'Name cannot be empty');
    });

    it('returns error for name over 50 characters', async () => {
      const lobby = createPlaylist('host-1');
      const longName = 'a'.repeat(51);
      const result = await renamePlaylist(lobby.id, longName);
      assert.ok(result.error);
      assert.strictEqual(result.error, 'Name must be 50 characters or less');
    });

    it('returns error when name is already taken', async () => {
      createPlaylist('host-1', null, 'Taken Name');
      const lobby2 = createPlaylist('host-2');
      const result = await renamePlaylist(lobby2.id, 'Taken Name');
      assert.ok(result.error);
      assert.strictEqual(result.error, 'A playlist with that name already exists');
    });

    it('allows renaming to same name (own lobby)', async () => {
      const lobby = createPlaylist('host-1', null, 'My Name');
      const result = await renamePlaylist(lobby.id, 'My Name');
      assert.ok(result.playlist);
      assert.strictEqual(result.playlist.name, 'My Name');
    });

    it('trims whitespace from name', async () => {
      const lobby = createPlaylist('host-1');
      const result = await renamePlaylist(lobby.id, '  Trimmed  ');
      assert.ok(result.playlist);
      assert.strictEqual(result.playlist.name, 'Trimmed');
    });
  });

  describe('pinPlaylist', () => {
    it('pins a lobby', async () => {
      const lobby = createPlaylist('host-1');
      const result = await pinPlaylist(lobby.id, true);
      assert.ok(result);
      assert.strictEqual(result.playlist.pinned, true);
      // Verify in-memory state
      const found = getPlaylist(lobby.id);
      assert.strictEqual(found.pinned, true);
    });

    it('unpins a lobby', async () => {
      const lobby = createPlaylist('host-1');
      await pinPlaylist(lobby.id, true);
      const result = await pinPlaylist(lobby.id, false);
      assert.ok(result);
      assert.strictEqual(result.playlist.pinned, false);
    });

    it('returns null for non-existent lobby', async () => {
      const result = await pinPlaylist('nonexistent', true);
      assert.strictEqual(result, null);
    });

    it('includes pinned state in getAllPlaylists', async () => {
      const lobby = createPlaylist('host-1');
      await pinPlaylist(lobby.id, true);
      const all = getAllPlaylists();
      assert.strictEqual(all[0].pinned, true);
    });
  });

  describe('cleanupEmptyPlaylists', () => {
    // hq-9gvy: time-based expiry was removed. An idle/empty lobby older than the
    // old 24h timeout must NOT be deleted — it persists until explicitly deleted.
    it('does NOT delete idle empty lobbies even past the old timeout', async () => {
      const lobby = createPlaylist('host-1', 'cleanup-test');
      const lobbyId = lobby.id;

      // Set up queue state for this lobby
      getQueue(lobbyId);

      assert.ok(hasQueue(lobbyId), 'queue should exist before cleanup');

      // Make the lobby far older than the old 24h timeout
      const lobbyData = lobbies.get(lobbyId);
      lobbyData.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyPlaylists();

      // Lobby and its state must survive — no idle deletion anymore
      assert.ok(lobbies.has(lobbyId), 'idle lobby should NOT be removed');
      assert.ok(hasQueue(lobbyId), 'queue for idle lobby should NOT be removed');
    });

    it('does not clean up pinned lobbies', async () => {
      const lobby = createPlaylist('host-1', 'pinned-test');
      const lobbyId = lobby.id;

      getQueue(lobbyId);

      // Pin the lobby
      await pinPlaylist(lobbyId, true);

      // Make the lobby far older than the old 24h timeout
      const lobbyData = lobbies.get(lobbyId);
      lobbyData.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyPlaylists();

      // Pinned lobby should NOT be removed
      assert.ok(lobbies.has(lobbyId), 'pinned lobby should not be removed');
      assert.ok(hasQueue(lobbyId), 'queue for pinned lobby should not be removed');
    });

    it('does not clean up lobbies that are not expired', async () => {
      const lobby = createPlaylist('host-1', 'active-test');

      getQueue(lobby.id);

      await cleanupEmptyPlaylists();

      assert.ok(lobbies.has(lobby.id), 'active lobby should not be removed');
      assert.ok(hasQueue(lobby.id), 'queue for active lobby should not be removed');
    });

    it('sweeps orphaned queue entries for non-existent lobbies', async () => {
      // Create a real lobby that should survive
      const lobby = createPlaylist('host-1', 'active-test');
      getQueue(lobby.id);

      // Create orphaned queue entries (no corresponding lobby)
      getQueue('orphan-1');
      getQueue('orphan-2');

      assert.ok(hasQueue('orphan-1'), 'orphaned queue should exist before cleanup');

      await cleanupEmptyPlaylists();

      // Active lobby should survive
      assert.ok(lobbies.has(lobby.id), 'active lobby should remain');
      assert.ok(hasQueue(lobby.id), 'active queue should remain');

      // Orphaned entries should be cleaned up
      assert.strictEqual(hasQueue('orphan-1'), false, 'orphaned queue should be removed');
      assert.strictEqual(hasQueue('orphan-2'), false, 'orphaned queue should be removed');
    });
  });
});
