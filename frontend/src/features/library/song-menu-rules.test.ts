// The song menu's pure rules (song-menu-rules.ts): Source ▸ and Remove from playlist.
// (Moved from backend/src/song-menu-rules.test.js.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as m from './song-menu-rules.ts';
import type { SongMenuPage, SongMenuRow, SourceLink, SourceSubmenu } from './song-menu-rules.ts';

describe('song-menu-rules: songSourceLink', () => {
  it('builds a watch url from a YouTube id', () => {
    assert.deepEqual(m.songSourceLink({ youtubeId: 'dQw4w9WgXcQ' }), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', host: 'YouTube' });
  });
  it('takes an http(s) source or queue url, naming YouTube hosts YouTube', () => {
    assert.deepEqual((m.songSourceLink({ url: 'https://music.youtube.com/watch?v=abc' }) as SourceLink).host, 'YouTube');
    assert.deepEqual(m.songSourceLink({ sourceUrl: 'https://soundcloud.com/x/y' }), { url: 'https://soundcloud.com/x/y', host: 'soundcloud.com' });
  });
  it('has nothing for library: urls, bad ids or other schemes', () => {
    assert.equal(m.songSourceLink({ url: 'library:42' }), null);
    assert.equal(m.songSourceLink({ youtubeId: 'short' }), null);
    assert.equal(m.songSourceLink({ sourceUrl: 'javascript:alert(1)' }), null);
    assert.equal(m.songSourceLink(), null);
  });
});

describe('song-menu-rules: sourceSubmenu', () => {
  it('opens and copies the YouTube link, labelled as such', () => {
    const plan = m.sourceSubmenu(m.songSourceLink({ youtubeId: 'dQw4w9WgXcQ' })) as SourceSubmenu;
    assert.equal(plan.openUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(plan.copyUrl, plan.openUrl);
    assert.equal(plan.copyKey, 'songMenu.copyYoutubeLink');
  });
  it('says plain "Copy link" for another host', () => {
    assert.equal((m.sourceSubmenu({ url: 'https://soundcloud.com/x', host: 'soundcloud.com' }) as SourceSubmenu).copyKey, 'songMenu.copyLink');
  });
  it('is no submenu at all without a link', () => {
    assert.equal(m.sourceSubmenu(null), null);
    assert.equal(m.sourceSubmenu({ host: 'YouTube' }), null);
  });
});

describe('song-menu-rules: canRemoveFromPlaylist', () => {
  const page: SongMenuPage = { lobbyId: 'p1', queueLobbyId: 'p1', canEdit: true };
  const row: SongMenuRow = { context: 'playlist', entryId: 'e1' };
  it('is offered on a playlist row the viewer may edit', () => {
    assert.equal(m.canRemoveFromPlaylist(row, page), true);
  });
  it('is not offered to someone who cannot edit', () => {
    assert.equal(m.canRemoveFromPlaylist(row, { ...page, canEdit: false }), false);
  });
  it('is not offered outside a playlist', () => {
    for (const context of ['library', 'radio', 'artist', 'player'] as const) {
      assert.equal(m.canRemoveFromPlaylist({ ...row, context }, page), false, context);
    }
  });
  it('is not offered while the queue on screen belongs to another playlist, or without an entry', () => {
    assert.equal(m.canRemoveFromPlaylist(row, { ...page, queueLobbyId: 'p2' }), false);
    assert.equal(m.canRemoveFromPlaylist({ context: 'playlist' }, page), false);
    assert.equal(m.canRemoveFromPlaylist(row, null), false);
  });
});
