const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The playlist module requires database to be available.
// Since tests run without DATABASE_URL, all methods return null/empty/'not_found'.
// This tests the graceful degradation behavior.
const playlist = require('./playlist');

describe('Playlist module (DB unavailable — graceful degradation)', () => {
  it('createPlaylist returns null', async () => {
    assert.equal(await playlist.createPlaylist('user1', 'My Playlist'), null);
  });

  it('getPlaylistsByUser returns empty array', async () => {
    assert.deepEqual(await playlist.getPlaylistsByUser('user1'), []);
  });

  it('getVisiblePlaylists returns empty array', async () => {
    assert.deepEqual(await playlist.getVisiblePlaylists('user1'), []);
  });

  it('getPlaylist returns null', async () => {
    assert.equal(await playlist.getPlaylist('some-uuid'), null);
  });

  it('getPlaylistVisible returns null', async () => {
    assert.equal(await playlist.getPlaylistVisible('some-uuid', 'user1'), null);
  });

  it('deletePlaylist returns "not_found"', async () => {
    assert.equal(await playlist.deletePlaylist('some-uuid', 'user1'), 'not_found');
  });

  it('renamePlaylist returns "not_found"', async () => {
    assert.equal(await playlist.renamePlaylist('some-uuid', 'user1', 'New Name'), 'not_found');
  });

  it('setVisibility returns "not_found"', async () => {
    assert.equal(await playlist.setVisibility('some-uuid', 'user1', false), 'not_found');
  });

  it('addSong returns "not_found"', async () => {
    const result = await playlist.addSong('some-uuid', 'user1', {
      url: 'https://example.com/song',
      title: 'Test Song',
      duration: 180
    });
    assert.equal(result, 'not_found');
  });

  it('removeSong returns "not_found"', async () => {
    assert.equal(await playlist.removeSong('playlist-uuid', 'song-uuid', 'user1'), 'not_found');
  });

  it('reorderSong returns "not_found"', async () => {
    assert.equal(await playlist.reorderSong('playlist-uuid', 'song-uuid', 2, 'user1'), 'not_found');
  });
});
