import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { playlist as store, access } from './index.ts';
import type { Playlist } from '../../shared/types.ts';
import { getQueue, hasQueue } from '../queue/index.ts';

const { createPlaylist, getPlaylist, joinPlaylist, leavePlaylist, getPlaylistUsers, deletePlaylist, isNameTaken, renamePlaylist, getAllPlaylists, pinPlaylist, setVisibility, playlists, cleanupEmptyPlaylists } = store;

// Either side of a rename's answer, read without narrowing first.
type Renamed = { playlist?: Playlist; error?: string } | null;

describe('Playlist System', () => {
  beforeEach(() => {
    // Clear all playlists before each test
    playlists.clear();
  });

  describe('createPlaylist', () => {
    it('creates a playlist with unique ID', () => {
      const playlist = createPlaylist('host-123');
      assert.ok(playlist.id);
      assert.strictEqual(playlist.id.length, 8);
      assert.strictEqual(playlist.ownerId, 'host-123');
      assert.ok(playlist.users instanceof Map);
      assert.strictEqual(playlist.users.size, 0);
    });

    it('creates playlists with different IDs', () => {
      const playlist1 = createPlaylist('host-1');
      const playlist2 = createPlaylist('host-2');
      assert.notStrictEqual(playlist1.id, playlist2.id);
    });

    it('defaults new playlists to public', () => {
      const playlist = createPlaylist('host-1');
      assert.strictEqual(playlist.visibility, 'public');
    });

    it('honors an explicit private visibility', () => {
      const playlist = createPlaylist('host-1', null, null, 'private');
      assert.strictEqual(playlist.visibility, 'private');
    });

    it('creates ownerless playlists public even when private is asked for', () => {
      const playlist = createPlaylist(null, null, null, 'private');
      assert.strictEqual(playlist.visibility, 'public');
    });

    it('normalizes a null host to null (anonymous, no owner)', () => {
      const playlist = createPlaylist(null);
      assert.strictEqual(playlist.ownerId, null);
    });
  });

  describe('visibility', () => {
    it('setVisibility switches visibility on the in-memory playlist', async () => {
      const playlist = createPlaylist('host-1', 'vis-test');
      assert.strictEqual(playlist.visibility, 'public');

      await setVisibility('vis-test', 'private');
      assert.strictEqual(playlists.get('vis-test')!.visibility, 'private');

      await setVisibility('vis-test', 'public');
      assert.strictEqual(playlists.get('vis-test')!.visibility, 'public');
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
    it('returns existing playlist', () => {
      const created = createPlaylist('host-1');
      const found = getPlaylist(created.id);
      assert.strictEqual(found!.id, created.id);
    });

    it('returns undefined for non-existent playlist', () => {
      const found = getPlaylist('nonexistent');
      assert.strictEqual(found, undefined);
    });
  });

  describe('joinPlaylist', () => {
    it('adds user to playlist', () => {
      const playlist = createPlaylist('host-1');
      const result = joinPlaylist(playlist.id, 'socket-123', 'Alice');

      assert.ok(result);
      assert.strictEqual(result.user.username, 'Alice');
      assert.strictEqual(result.user.socketId, 'socket-123');
      assert.strictEqual(result.playlist.users.size, 1);
    });

    it('generates default username if not provided', () => {
      const playlist = createPlaylist('host-1');
      const result = joinPlaylist(playlist.id, 'socket-123');

      assert.ok(result!.user.username.startsWith('User-'));
    });

    it('returns null for non-existent playlist', () => {
      const result = joinPlaylist('nonexistent', 'socket-123', 'Alice');
      assert.strictEqual(result, null);
    });

    it('allows multiple users to join', () => {
      const playlist = createPlaylist('host-1');
      joinPlaylist(playlist.id, 'socket-1', 'Alice');
      joinPlaylist(playlist.id, 'socket-2', 'Bob');
      joinPlaylist(playlist.id, 'socket-3', 'Charlie');

      assert.strictEqual(playlist.users.size, 3);
    });
  });

  describe('leavePlaylist', () => {
    it('removes user from playlist', () => {
      const playlist = createPlaylist('host-1');
      joinPlaylist(playlist.id, 'socket-123', 'Alice');
      const user = leavePlaylist(playlist.id, 'socket-123');

      assert.strictEqual(user!.username, 'Alice');
      assert.strictEqual(playlist.users.size, 0);
    });

    it('returns null for non-existent playlist', () => {
      const user = leavePlaylist('nonexistent', 'socket-123');
      assert.strictEqual(user, null);
    });

    it('returns undefined for non-existent user', () => {
      const playlist = createPlaylist('host-1');
      const user = leavePlaylist(playlist.id, 'nonexistent');
      assert.strictEqual(user, undefined);
    });
  });

  describe('getPlaylistUsers', () => {
    it('returns array of users', () => {
      const playlist = createPlaylist('host-1');
      joinPlaylist(playlist.id, 'socket-1', 'Alice');
      joinPlaylist(playlist.id, 'socket-2', 'Bob');

      const users = getPlaylistUsers(playlist.id);
      assert.strictEqual(users.length, 2);
      assert.ok(users.some(u => u.username === 'Alice'));
      assert.ok(users.some(u => u.username === 'Bob'));
    });

    it('returns empty array for non-existent playlist', () => {
      const users = getPlaylistUsers('nonexistent');
      assert.deepStrictEqual(users, []);
    });
  });


  describe('deletePlaylist', () => {
    it('removes playlist', () => {
      const playlist = createPlaylist('host-1');
      const deleted = deletePlaylist(playlist.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(getPlaylist(playlist.id), undefined);
    });

    it('returns false for non-existent playlist', () => {
      const deleted = deletePlaylist('nonexistent');
      assert.strictEqual(deleted, false);
    });
  });

  describe('playlist naming', () => {
    it('creates a playlist with a name', () => {
      const playlist = createPlaylist('host-1', null, 'My Playlist');
      assert.strictEqual(playlist.name, 'My Playlist');
    });

    it('creates a playlist without a name', () => {
      const playlist = createPlaylist('host-1');
      assert.strictEqual(playlist.name, null);
    });

    it('includes name in getAllPlaylists', () => {
      createPlaylist('host-1', null, 'Named Playlist');
      const all = getAllPlaylists();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].name, 'Named Playlist');
    });
  });

  describe('isNameTaken', () => {
    it('returns false when no playlists have names', () => {
      createPlaylist('host-1');
      assert.strictEqual(isNameTaken('Test'), false);
    });

    it('returns true when name is taken', () => {
      createPlaylist('host-1', null, 'My Playlist');
      assert.strictEqual(isNameTaken('My Playlist'), true);
    });

    it('is case-insensitive', () => {
      createPlaylist('host-1', null, 'My Playlist');
      assert.strictEqual(isNameTaken('my playlist'), true);
      assert.strictEqual(isNameTaken('MY PLAYLIST'), true);
    });

    it('excludes a specific playlist from the check', () => {
      const playlist = createPlaylist('host-1', null, 'My Playlist');
      assert.strictEqual(isNameTaken('My Playlist', playlist.id), false);
    });

    it("ignores playlists the caller cannot see (no leak of others' private names)", () => {
      createPlaylist('owner-a', null, 'Secret Mix', 'private');
      assert.strictEqual(isNameTaken('Secret Mix', null, l => access.canView(l, 'owner-b')), false);
      assert.strictEqual(isNameTaken('Secret Mix', null, l => access.canView(l, 'owner-a')), true);
    });

    it('returns false for null or empty name', () => {
      createPlaylist('host-1', null, 'My Playlist');
      assert.strictEqual(isNameTaken(null), false);
      assert.strictEqual(isNameTaken(''), false);
    });
  });

  describe('renamePlaylist', () => {
    it('renames an existing playlist', async () => {
      const playlist = createPlaylist('host-1', null, 'Old Name');
      const result: Renamed = await renamePlaylist(playlist.id, 'New Name');
      assert.ok(result!.playlist);
      assert.strictEqual(result!.playlist!.name, 'New Name');
      // Verify in-memory state updated
      const found = getPlaylist(playlist.id);
      assert.strictEqual(found!.name, 'New Name');
    });

    it('returns null for non-existent playlist', async () => {
      const result: Renamed = await renamePlaylist('nonexistent', 'Name');
      assert.strictEqual(result, null);
    });

    it('returns error for empty name', async () => {
      const playlist = createPlaylist('host-1');
      const result: Renamed = await renamePlaylist(playlist.id, '');
      assert.ok(result!.error);
      assert.strictEqual(result!.error, 'Name cannot be empty');
    });

    it('returns error for name over 50 characters', async () => {
      const playlist = createPlaylist('host-1');
      const longName = 'a'.repeat(51);
      const result: Renamed = await renamePlaylist(playlist.id, longName);
      assert.ok(result!.error);
      assert.strictEqual(result!.error, 'Name must be 50 characters or less');
    });

    it('returns error when name is already taken', async () => {
      createPlaylist('host-1', null, 'Taken Name');
      const playlist2 = createPlaylist('host-2');
      const result: Renamed = await renamePlaylist(playlist2.id, 'Taken Name');
      assert.ok(result!.error);
      assert.strictEqual(result!.error, 'A playlist with that name already exists');
    });

    it('allows renaming to same name (own playlist)', async () => {
      const playlist = createPlaylist('host-1', null, 'My Name');
      const result: Renamed = await renamePlaylist(playlist.id, 'My Name');
      assert.ok(result!.playlist);
      assert.strictEqual(result!.playlist!.name, 'My Name');
    });

    it('trims whitespace from name', async () => {
      const playlist = createPlaylist('host-1');
      const result: Renamed = await renamePlaylist(playlist.id, '  Trimmed  ');
      assert.ok(result!.playlist);
      assert.strictEqual(result!.playlist!.name, 'Trimmed');
    });
  });

  describe('pinPlaylist', () => {
    it('pins a playlist', async () => {
      const playlist = createPlaylist('host-1');
      const result = await pinPlaylist(playlist.id, true);
      assert.ok(result);
      assert.strictEqual(result.playlist.pinned, true);
      // Verify in-memory state
      const found = getPlaylist(playlist.id);
      assert.strictEqual(found!.pinned, true);
    });

    it('unpins a playlist', async () => {
      const playlist = createPlaylist('host-1');
      await pinPlaylist(playlist.id, true);
      const result = await pinPlaylist(playlist.id, false);
      assert.ok(result);
      assert.strictEqual(result.playlist.pinned, false);
    });

    it('returns null for non-existent playlist', async () => {
      const result = await pinPlaylist('nonexistent', true);
      assert.strictEqual(result, null);
    });

    it('includes pinned state in getAllPlaylists', async () => {
      const playlist = createPlaylist('host-1');
      await pinPlaylist(playlist.id, true);
      const all = getAllPlaylists();
      assert.strictEqual(all[0].pinned, true);
    });
  });

  describe('cleanupEmptyPlaylists', () => {
    // hq-9gvy: time-based expiry was removed. An idle/empty playlist older than the
    // old 24h timeout must NOT be deleted — it persists until explicitly deleted.
    it('does NOT delete idle empty playlists even past the old timeout', async () => {
      const playlist = createPlaylist('host-1', 'cleanup-test');
      const playlistId = playlist.id;

      // Set up queue state for this playlist
      getQueue(playlistId);

      assert.ok(hasQueue(playlistId), 'queue should exist before cleanup');

      // Make the playlist far older than the old 24h timeout
      const playlistData = playlists.get(playlistId);
      playlistData!.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyPlaylists();

      // Playlist and its state must survive — no idle deletion anymore
      assert.ok(playlists.has(playlistId), 'idle playlist should NOT be removed');
      assert.ok(hasQueue(playlistId), 'queue for idle playlist should NOT be removed');
    });

    it('does not clean up pinned playlists', async () => {
      const playlist = createPlaylist('host-1', 'pinned-test');
      const playlistId = playlist.id;

      getQueue(playlistId);

      // Pin the playlist
      await pinPlaylist(playlistId, true);

      // Make the playlist far older than the old 24h timeout
      const playlistData = playlists.get(playlistId);
      playlistData!.lastActivity = Date.now() - (25 * 60 * 60 * 1000);

      await cleanupEmptyPlaylists();

      // Pinned playlist should NOT be removed
      assert.ok(playlists.has(playlistId), 'pinned playlist should not be removed');
      assert.ok(hasQueue(playlistId), 'queue for pinned playlist should not be removed');
    });

    it('does not clean up playlists that are not expired', async () => {
      const playlist = createPlaylist('host-1', 'active-test');

      getQueue(playlist.id);

      await cleanupEmptyPlaylists();

      assert.ok(playlists.has(playlist.id), 'active playlist should not be removed');
      assert.ok(hasQueue(playlist.id), 'queue for active playlist should not be removed');
    });

    it('sweeps orphaned queue entries for non-existent playlists', async () => {
      // Create a real playlist that should survive
      const playlist = createPlaylist('host-1', 'active-test');
      getQueue(playlist.id);

      // Create orphaned queue entries (no corresponding playlist)
      getQueue('orphan-1');
      getQueue('orphan-2');

      assert.ok(hasQueue('orphan-1'), 'orphaned queue should exist before cleanup');

      await cleanupEmptyPlaylists();

      // Active playlist should survive
      assert.ok(playlists.has(playlist.id), 'active playlist should remain');
      assert.ok(hasQueue(playlist.id), 'active queue should remain');

      // Orphaned entries should be cleaned up
      assert.strictEqual(hasQueue('orphan-1'), false, 'orphaned queue should be removed');
      assert.strictEqual(hasQueue('orphan-2'), false, 'orphaned queue should be removed');
    });
  });
});
