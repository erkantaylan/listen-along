const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The playlist module requires database to be available.
// Since tests run without DATABASE_URL, all methods return null/empty/false.
// This tests the graceful degradation behavior.
const playlist = require('./playlist');

describe('Playlist module', () => {
  describe('createPlaylist', () => {
    it('returns null when database is unavailable', async () => {
      const result = await playlist.createPlaylist('user1', 'My Playlist');
      assert.equal(result, null);
    });
  });

  describe('getPlaylistsByUser', () => {
    it('returns empty array when database is unavailable', async () => {
      const result = await playlist.getPlaylistsByUser('user1');
      assert.deepEqual(result, []);
    });
  });

  describe('getPlaylist', () => {
    it('returns null when database is unavailable', async () => {
      const result = await playlist.getPlaylist('some-uuid');
      assert.equal(result, null);
    });
  });

  describe('deletePlaylist', () => {
    it('returns false when database is unavailable', async () => {
      const result = await playlist.deletePlaylist('some-uuid', 'user1');
      assert.equal(result, false);
    });
  });

  describe('renamePlaylist', () => {
    it('returns null when database is unavailable', async () => {
      const result = await playlist.renamePlaylist('some-uuid', 'user1', 'New Name');
      assert.equal(result, null);
    });
  });

  describe('addSong', () => {
    it('returns null when database is unavailable', async () => {
      const result = await playlist.addSong('some-uuid', {
        url: 'https://example.com/song',
        title: 'Test Song',
        duration: 180
      });
      assert.equal(result, null);
    });
  });

  describe('removeSong', () => {
    it('returns false when database is unavailable', async () => {
      const result = await playlist.removeSong('playlist-uuid', 'song-uuid');
      assert.equal(result, false);
    });
  });

  describe('reorderSong', () => {
    it('returns false when database is unavailable', async () => {
      const result = await playlist.reorderSong('playlist-uuid', 'song-uuid', 2);
      assert.equal(result, false);
    });
  });
});
