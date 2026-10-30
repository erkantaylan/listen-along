// Tests the frontend URL <-> view mapping (frontend/router.js). It is a pure ES
// module with no DOM access, so it can be imported directly.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let parseRoute, libraryPath, basePath, LIBRARY_DEFAULTS;

before(async () => {
  const routerPath = path.join(__dirname, '..', '..', 'frontend', 'router.js');
  ({ parseRoute, libraryPath, basePath, LIBRARY_DEFAULTS } = await import(pathToFileURL(routerPath).href));
});

describe('frontend router: parseRoute', () => {
  it('maps the top-level views', () => {
    assert.deepEqual(parseRoute('/'), { view: 'landing', lobbyId: null, library: null });
    assert.deepEqual(parseRoute('/profile'), { view: 'profile', lobbyId: null, library: null });
    assert.deepEqual(parseRoute('/dashboard'), { view: 'dashboard', lobbyId: null, library: null });
    assert.deepEqual(parseRoute('/lobby/abc-123'), { view: 'lobby', lobbyId: 'abc-123', library: null });
  });

  it('falls back to the landing page for unknown paths and bad lobby ids', () => {
    assert.equal(parseRoute('/nope').view, 'landing');
    assert.equal(parseRoute('/lobby/a%20b').lobbyId, null);
    assert.equal(parseRoute('/lobby/x/y').lobbyId, null);
  });

  it('opens the library with defaults, alone or over a lobby', () => {
    assert.deepEqual(parseRoute('/library'), { view: 'landing', lobbyId: null, library: { ...LIBRARY_DEFAULTS } });
    const r = parseRoute('/lobby/xyz/library');
    assert.equal(r.view, 'lobby');
    assert.equal(r.lobbyId, 'xyz');
    assert.deepEqual(r.library, { ...LIBRARY_DEFAULTS });
  });

  it('reads library params, ignoring invalid values', () => {
    assert.deepEqual(parseRoute('/library', '?q=%20daft%20punk%20&sort=artist&page=3&tab=requests&status=fulfilled').library,
      { tab: 'requests', query: 'daft punk', sort: 'artist', page: 2, requestStatus: 'fulfilled' });
    assert.deepEqual(parseRoute('/library', '?sort=drop&page=-4&tab=x&status=y').library, { ...LIBRARY_DEFAULTS });
    assert.equal(parseRoute('/library', '?page=abc').library.page, 0);
  });
});

describe('frontend router: building URLs', () => {
  it('leaves defaults out of the library URL', () => {
    assert.equal(libraryPath(null, LIBRARY_DEFAULTS), '/library');
    assert.equal(libraryPath('xyz', {}), '/lobby/xyz/library');
    assert.equal(libraryPath(null, { query: 'a&b', sort: 'title', page: 1 }), '/library?q=a%26b&sort=title&page=2');
    assert.equal(libraryPath(null, { tab: 'requests', requestStatus: 'all' }), '/library?tab=requests&status=all');
  });

  it('round-trips library state through the URL', () => {
    const lib = { tab: 'requests', query: 'ünïcode ?&=', sort: 'artist', page: 4, requestStatus: 'dismissed' };
    const url = new URL(libraryPath('lob-1', lib), 'http://x');
    const r = parseRoute(url.pathname, url.search);
    assert.equal(r.lobbyId, 'lob-1');
    assert.deepEqual(r.library, lib);
  });

  it('builds base paths', () => {
    assert.equal(basePath({ view: 'landing' }), '/');
    assert.equal(basePath({ view: 'lobby', lobbyId: 'q' }), '/lobby/q');
    assert.equal(basePath({ view: 'profile' }), '/profile');
  });
});
