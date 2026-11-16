// Tests the frontend URL <-> view mapping (router.ts). It is a pure ES
// module with no DOM access, so it can be imported directly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, libraryPath, basePath, legacyRedirect, artistPath, LIBRARY_DEFAULTS } from './router.ts';

describe('frontend router: parseRoute', () => {
  it('maps the top-level views', () => {
    assert.deepEqual(parseRoute('/'), { view: 'landing', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/profile'), { view: 'profile', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/dashboard'), { view: 'dashboard', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/social'), { view: 'social', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/radio'), { view: 'radio', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/radio/'), { view: 'radio', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/app'), { view: 'app', playlistId: null, library: null });
    assert.equal(basePath({ view: 'app' }), '/app');
    assert.deepEqual(parseRoute('/playlist/abc-123'), { view: 'playlist', playlistId: 'abc-123', library: null });
  });

  it('maps the artist views, with encoded keys both ways', () => {
    assert.deepEqual(parseRoute('/artists'), { view: 'artists', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/artists/'), { view: 'artists', playlistId: null, library: null });
    assert.deepEqual(parseRoute('/artist/barismanco'), { view: 'artist', playlistId: null, library: null, artistKey: 'barismanco' });
    assert.deepEqual(parseRoute('/artist/%D0%BA%D0%B8%D0%BD%D0%BE/'), { view: 'artist', playlistId: null, library: null, artistKey: 'кино' });
    assert.equal(parseRoute('/artist/%E0%A4%A').view, 'landing');
    assert.equal(parseRoute('/artist/').view, 'landing');
    assert.equal(parseRoute('/artist/a/b').view, 'landing');
    assert.equal(basePath({ view: 'artists' }), '/artists');
    assert.equal(basePath({ view: 'artist', artistKey: 'кино' }), '/artist/%D0%BA%D0%B8%D0%BD%D0%BE');
    assert.equal(artistPath('barismanco'), '/artist/barismanco');
  });

  it('falls back to the landing page for unknown paths and bad playlist ids', () => {
    assert.equal(parseRoute('/nope').view, 'landing');
    assert.equal(parseRoute('/playlist/a%20b').playlistId, null);
    assert.equal(parseRoute('/playlist/x/y').playlistId, null);
  });

  it('opens the library with defaults, alone or over a playlist', () => {
    assert.deepEqual(parseRoute('/library'), { view: 'landing', playlistId: null, library: { ...LIBRARY_DEFAULTS } });
    const r = parseRoute('/playlist/xyz/library');
    assert.equal(r.view, 'playlist');
    assert.equal(r.playlistId, 'xyz');
    assert.deepEqual(r.library, { ...LIBRARY_DEFAULTS });
  });

  it('knows the Broken ("needs replacement") library tab', () => {
    assert.equal(parseRoute('/library', '?tab=broken').library?.tab, 'broken');
    assert.equal(libraryPath(null, { tab: 'broken', page: 1 }), '/library?tab=broken&page=2');
  });

  it('reads library params, ignoring invalid values', () => {
    assert.deepEqual(parseRoute('/library', '?q=%20daft%20punk%20&sort=artist&page=3&tab=requests&status=fulfilled').library,
      { tab: 'requests', query: 'daft punk', sort: 'artist', page: 2, requestStatus: 'fulfilled' });
    assert.deepEqual(parseRoute('/library', '?sort=drop&page=-4&tab=x&status=y').library, { ...LIBRARY_DEFAULTS });
    assert.equal(parseRoute('/library', '?page=abc').library?.page, 0);
  });
});

describe('frontend router: building URLs', () => {
  it('leaves defaults out of the library URL', () => {
    assert.equal(libraryPath(null, LIBRARY_DEFAULTS), '/library');
    assert.equal(libraryPath('xyz', {}), '/playlist/xyz/library');
    assert.equal(libraryPath(null, { query: 'a&b', sort: 'title', page: 1 }), '/library?q=a%26b&sort=title&page=2');
    assert.equal(libraryPath(null, { tab: 'requests', requestStatus: 'all' }), '/library?tab=requests&status=all');
  });

  it('round-trips library state through the URL', () => {
    const lib = { tab: 'requests', query: 'ünïcode ?&=', sort: 'artist', page: 4, requestStatus: 'dismissed' } as const;
    const url = new URL(libraryPath('lob-1', lib), 'http://x');
    const r = parseRoute(url.pathname, url.search);
    assert.equal(r.playlistId, 'lob-1');
    assert.deepEqual(r.library, lib);
  });

  it('builds base paths', () => {
    assert.equal(basePath({ view: 'landing' }), '/');
    assert.equal(basePath({ view: 'playlist', playlistId: 'q' }), '/playlist/q');
    assert.equal(basePath({ view: 'profile' }), '/profile');
    assert.equal(basePath({ view: 'radio' }), '/radio');
  });
});

describe('frontend router: old /lobby URLs', () => {
  it('maps /lobby/<id>[/library] to /playlist/... keeping the query', () => {
    assert.equal(legacyRedirect('/lobby/abc-123'), '/playlist/abc-123');
    assert.equal(legacyRedirect('/lobby/abc-123/'), '/playlist/abc-123');
    assert.equal(legacyRedirect('/lobby/abc/library', '?q=x&page=2'), '/playlist/abc/library?q=x&page=2');
  });

  it('leaves other paths alone and no longer routes /lobby itself', () => {
    assert.equal(legacyRedirect('/playlist/abc'), null);
    assert.equal(legacyRedirect('/library'), null);
    assert.equal(legacyRedirect('/lobby/a b'), null);
    assert.equal(parseRoute('/lobby/abc').view, 'landing');
  });
});
