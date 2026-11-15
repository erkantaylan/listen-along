// The global search's rules (frontend/search-rules.js), plus the pieces of
// other rule modules it relies on: the search route (router.js), the repeat
// of a song played from search (player-queue.js) and the playlist import's
// ticks (pick-rules.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const front = (name) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', name)).href);
let m;
let router;
let pq;
let pick;

const vid = (n) => `video${String(n).padStart(6, '0')}`;
const video = (n, extra = {}) => ({ youtube_id: vid(n), title: `Title ${n}`, channel: 'Ch', duration_sec: 200, in_library: null, ...extra });

before(async () => {
  m = await front('search-rules.js');
  router = await front('router.js');
  pq = await front('player-queue.js');
  pick = await front('pick-rules.js');
});

describe('search: the shortcut and the add key', () => {
  const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });
  it('Ctrl+K elsewhere, Cmd+K on a Mac, also from another input', () => {
    assert.equal(m.isSearchShortcut(key('k', { ctrlKey: true })), true);
    assert.equal(m.isSearchShortcut(key('K', { ctrlKey: true })), true);
    assert.equal(m.isSearchShortcut(key('k', { metaKey: true }), true), true);
    assert.equal(m.isSearchShortcut(key('k', { metaKey: true })), false, 'Cmd is not Ctrl off a Mac');
    assert.equal(m.isSearchShortcut(key('k', { ctrlKey: true }), true), false, 'Ctrl is not Cmd on a Mac');
  });
  it('not with other modifiers, other keys or while an IME composes', () => {
    assert.equal(m.isSearchShortcut(key('k', { ctrlKey: true, shiftKey: true })), false);
    assert.equal(m.isSearchShortcut(key('k', { ctrlKey: true, altKey: true })), false);
    assert.equal(m.isSearchShortcut(key('j', { ctrlKey: true })), false);
    assert.equal(m.isSearchShortcut(key('k', { ctrlKey: true, isComposing: true })), false);
    assert.equal(m.isSearchShortcut(null), false);
  });
  it('the add key is a plain "a"', () => {
    assert.equal(m.isAddKey(key('a')), true);
    assert.equal(m.isAddKey(key('A')), true);
    assert.equal(m.isAddKey(key('a', { ctrlKey: true })), false, 'Ctrl+A selects');
    assert.equal(m.isAddKey(key('a', { isComposing: true })), false);
    assert.equal(m.isAddKey(key('b')), false);
  });
});

describe('search: what is a link (exact, never fuzzy)', () => {
  it('http(s) addresses as they are', () => {
    assert.equal(m.linkInput(' https://www.youtube.com/watch?v=dQw4w9WgXcQ '), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(m.linkInput('https://open.spotify.com/album/abc'), 'https://open.spotify.com/album/abc');
    assert.equal(m.linkInput('http://example.com/x'), 'http://example.com/x', 'the server says it is unsupported');
  });
  it('YouTube and Spotify without the scheme', () => {
    assert.equal(m.linkInput('youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(m.linkInput('www.youtube.com/playlist?list=PLx'), 'https://www.youtube.com/playlist?list=PLx');
    assert.equal(m.linkInput('music.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(m.linkInput('open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  });
  it('a bare video id only when it cannot be an ordinary word', () => {
    assert.equal(m.linkInput('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(m.linkInput('abc_def-ghi'), 'abc_def-ghi');
    assert.equal(m.linkInput('despacitooo'), null, 'eleven letters is a word');
    assert.equal(m.linkInput('12345678901'), null, 'digits only');
  });
  it('words are searches', () => {
    for (const text of ['', '  ', 'daft punk', 'youtube', 'tarkan şımarık', 'https://x y']) assert.equal(m.linkInput(text), null, text);
  });
  it('knows a Spotify link', () => {
    assert.equal(m.isSpotifyLink('https://open.spotify.com/track/x'), true);
    assert.equal(m.isSpotifyLink('https://youtu.be/x'), false);
  });
});

describe('search: what the server said about a link', () => {
  it('the library has it', () => {
    assert.deepEqual(m.linkOutcome(200, { kind: 'library', song: { id: 's1' } }), { kind: 'song', song: { id: 's1' } });
  });
  it('one video', () => {
    assert.deepEqual(m.linkOutcome(200, { kind: 'video', results: [video(1)] }), { kind: 'video', video: video(1) });
  });
  it('a bare id YouTube cannot name is taken as words; a link is not', () => {
    const unnamed = { kind: 'video', results: [video(1, { title: null })] };
    assert.deepEqual(m.linkOutcome(200, unnamed, { bare: true }), { kind: 'text' });
    assert.equal(m.linkOutcome(200, unnamed).kind, 'video');
    assert.equal(m.linkOutcome(200, { kind: 'video', results: [video(2)] }, { bare: true }).kind, 'video');
  });
  it('a Spotify track resolves to the top hit, the library\'s copy when it has one', () => {
    const top = m.linkOutcome(200, { kind: 'search', query: 'A - B', results: [video(1), video(2)] }, { spotify: true });
    assert.deepEqual(top, { kind: 'video', video: video(1), query: 'A - B' });
    const have = m.linkOutcome(200, { kind: 'search', query: 'A - B', results: [video(3, { in_library: { id: 'lib3', title: 'B', artist: 'A' } })] }, { spotify: true });
    assert.equal(have.kind, 'song');
    assert.equal(have.song.id, 'lib3');
    assert.equal(have.song.youtube_id, vid(3));
    assert.deepEqual(m.linkOutcome(200, { kind: 'search', query: 'A - B', results: [] }, { spotify: true }), { kind: 'none', query: 'A - B' });
  });
  it('a YouTube playlist: name, count, how many the library has', () => {
    const o = m.linkOutcome(200, { kind: 'playlist', title: ' Road mix ', total: 250, results: [video(1, { in_library: { id: 'a' } }), video(2), { youtube_id: 'bad' }] });
    assert.equal(o.kind, 'playlist');
    assert.equal(o.title, 'Road mix');
    assert.equal(o.total, 250);
    assert.equal(o.videos.length, 2);
    assert.equal(o.inLibrary, 1);
    assert.equal(m.linkOutcome(200, { kind: 'playlist', results: [video(1)] }).title, null);
  });
  it('the server\'s refusal is shown in its own words', () => {
    assert.deepEqual(m.linkOutcome(400, { error: 'Only Spotify track links are supported. Paste the link of a single song.', code: 'BAD_INPUT' }),
      { kind: 'unsupported', message: 'Only Spotify track links are supported. Paste the link of a single song.' });
  });
  it('rate limited, failed, offline', () => {
    assert.deepEqual(m.linkOutcome(429, { error: 'x' }), { kind: 'rate' });
    assert.equal(m.linkOutcome(502, { error: 'down' }).kind, 'error');
    assert.equal(m.linkOutcome(0, null).kind, 'error');
  });
  it('anything else is searched as words', () => {
    assert.deepEqual(m.linkOutcome(200, { kind: 'search', results: [video(1)] }), { kind: 'text' });
  });
});

describe('search: the YouTube section', () => {
  it('results, nothing, rate limited, failed', () => {
    assert.deepEqual(m.youtubeOutcome(200, { kind: 'search', results: [video(1), { youtube_id: 'x' }] }), { kind: 'results', videos: [video(1)] });
    assert.deepEqual(m.youtubeOutcome(200, { kind: 'search', results: [] }), { kind: 'empty' });
    assert.deepEqual(m.youtubeOutcome(429, {}), { kind: 'rate' });
    assert.equal(m.youtubeOutcome(502, { error: 'The YouTube search failed' }).kind, 'error');
    assert.equal(m.youtubeOutcome(0, null).kind, 'error');
  });
});

describe('search: "Similar in the library" words from a video title', () => {
  it('the title part of "Artist - Title", without the video words', () => {
    assert.equal(m.similarQuery('TARKAN - Şımarık (Official Music Video)'), 'Şımarık');
    assert.equal(m.similarQuery('Nova Lane - Paper Moons [Lyrics] ft. Kiraz'), 'Paper Moons');
    assert.equal(m.similarQuery('Adele – Hello (Official Video) | 4K'), 'Hello');
  });
  it('a title with no dash keeps its words', () => {
    assert.equal(m.similarQuery('Bohemian Rhapsody (Remastered 2011)'), 'Bohemian Rhapsody');
    assert.equal(m.similarQuery('Song Name | Channel'), 'Song Name');
    assert.equal(m.similarQuery(null), '');
  });
});

describe('search: the current playlist (where a one-step add goes)', () => {
  const pls = [
    { id: 'road', name: 'Road trip', canEdit: true },
    { id: 'theirs', name: 'Theirs', canEdit: false },
    { id: 'mine', name: 'Mine', canEdit: true },
  ];
  it('the playlist last played from', () => {
    assert.deepEqual(m.addTarget({ lastPlayedId: 'road', playlists: pls }), { playlist: pls[0], session: false });
  });
  it('the playlist page the search was started on wins for that search', () => {
    assert.deepEqual(m.addTarget({ sessionId: 'mine', lastPlayedId: 'road', playlists: pls }), { playlist: pls[2], session: true });
  });
  it('gone, not visible (not in the list) or not editable: none', () => {
    assert.equal(m.addTarget({ lastPlayedId: 'deleted', playlists: pls }), null);
    assert.equal(m.addTarget({ lastPlayedId: 'theirs', playlists: pls }), null);
    assert.equal(m.addTarget({ lastPlayedId: null, playlists: pls }), null);
    assert.equal(m.addTarget({ lastPlayedId: 'road', playlists: [] }), null, 'nothing known yet');
    assert.deepEqual(m.addTarget({ sessionId: 'theirs', lastPlayedId: 'road', playlists: pls }), { playlist: pls[0], session: false }, 'a session target that went read-only falls back');
  });
  it('an editable playlist page on screen is a target; anything else is not', () => {
    assert.equal(m.pageTarget({ view: 'lobby', lobbyId: 'road', canEdit: true }), 'road');
    assert.equal(m.pageTarget({ view: 'lobby', lobbyId: 'theirs', canEdit: false }), null, 'read-only');
    assert.equal(m.pageTarget({ view: 'lobby', lobbyId: 'road', canEdit: true, libraryOpen: true }), null, 'under the library overlay');
    assert.equal(m.pageTarget({ view: 'lobby', lobbyId: null, canEdit: true }), null, 'not joined yet');
    for (const view of ['landing', 'radio', 'artists', 'artist', 'search', 'profile', null]) {
      assert.equal(m.pageTarget({ view, lobbyId: 'road', canEdit: true }), null, String(view));
    }
    assert.equal(m.pageTarget(), null);
  });
  it('starting a search on that page makes it the target; elsewhere the target stays', () => {
    assert.equal(m.startTarget(null, 'road'), 'road');
    assert.equal(m.startTarget('mine', 'road'), 'road', 'the page on screen wins');
    assert.equal(m.startTarget('road', null), 'road', 'focusing again on the search page keeps it');
    assert.equal(m.startTarget(null, null), null, 'elsewhere: the last-played rule applies');
    assert.deepEqual(m.addTarget({ sessionId: m.startTarget(null, 'mine'), lastPlayedId: 'road', playlists: pls }), { playlist: pls[2], session: true });
    assert.deepEqual(m.addTarget({ sessionId: m.startTarget(null, null), lastPlayedId: 'road', playlists: pls }), { playlist: pls[0], session: false });
  });
  it('the target lasts while its search does', () => {
    assert.equal(m.keepTarget('road', { view: 'search' }), 'road');
    assert.equal(m.keepTarget('road', { view: 'lobby', lobbyId: 'road' }), 'road', 'back on its page');
    assert.equal(m.keepTarget('road', { view: 'lobby', lobbyId: 'road', library: 'library' }), null, 'its library');
    assert.equal(m.keepTarget('road', { view: 'lobby', lobbyId: 'mine' }), null, 'another playlist');
    for (const view of ['landing', 'radio', 'artists', 'profile', 'social']) assert.equal(m.keepTarget('road', { view }), null, view);
    assert.equal(m.keepTarget(null, { view: 'search' }), null);
  });
  it('the placeholder names the page\'s (or the search\'s) playlist, never the last played', () => {
    assert.equal(m.placeholderTarget({ pageId: 'road', playlists: pls }), pls[0]);
    assert.equal(m.placeholderTarget({ sessionId: 'mine', playlists: pls }), pls[2]);
    assert.equal(m.placeholderTarget({ pageId: 'theirs', playlists: pls }), null, 'not editable');
    assert.equal(m.placeholderTarget({ pageId: 'road', playlists: [] }), null, 'list not loaded yet');
    assert.equal(m.placeholderTarget({ playlists: pls }), null);
  });
  it('only a playlist context is remembered as last played (not opened)', () => {
    assert.equal(m.lastPlayedFrom({ type: 'lobby', lobbyId: 'road' }), 'road');
    for (const ctx of [null, { type: 'radio' }, { type: 'artist', key: 'x' }, { type: 'search', query: 'x' }, { type: 'library' }, { type: 'lobby' }]) {
      assert.equal(m.lastPlayedFrom(ctx), null, JSON.stringify(ctx));
    }
  });
});

describe('search: duplicates (the same video / library song in that playlist)', () => {
  it('adding a library song', () => {
    assert.equal(m.addOutcome(200, { results: [{ status: 'added' }] }), 'added');
    assert.equal(m.addOutcome(200, { results: [{ status: 'already_in_playlist' }] }), 'duplicate');
    assert.equal(m.addOutcome(200, { results: [{ status: 'not_in_library' }] }), 'notInLibrary');
    assert.equal(m.addOutcome(404, { error: 'Playlist not found' }), 'missing');
    assert.equal(m.addOutcome(500, {}), 'error');
    assert.equal(m.addOutcome(200, {}), 'error');
  });
  it('requesting a video', () => {
    const id = vid(1);
    assert.equal(m.requestOutcome(201, { jobs: [{ id: 'j' }], existing: [], added_to_playlist: 0, already_in_playlist: [], playlist_id: 'p' }, id), 'requested');
    assert.equal(m.requestOutcome(200, { jobs: [], existing: [{ id: 's' }], added_to_playlist: 1, already_in_playlist: [], playlist_id: 'p' }, id), 'added');
    assert.equal(m.requestOutcome(200, { jobs: [], existing: [{ id: 's' }], added_to_playlist: 0, already_in_playlist: [id], playlist_id: 'p' }, id), 'duplicate');
    assert.equal(m.requestOutcome(200, { jobs: [], existing: [{ id: 's' }], added_to_playlist: 0, playlist_id: null }, id), 'library');
    assert.equal(m.requestOutcome(201, { jobs: [], failed: [id], error: '1 of 1' }, id), 'error');
    assert.equal(m.requestOutcome(404, { code: 'PLAYLIST_NOT_FOUND' }, id), 'missing');
    assert.equal(m.requestOutcome(500, null, id), 'error');
  });
});

describe('search: keyboard over the results', () => {
  it('arrows walk every row; up from the first goes back to the field', () => {
    assert.equal(m.rowStep(0, 'ArrowDown', 3), 1);
    assert.equal(m.rowStep(2, 'ArrowDown', 3), 2);
    assert.equal(m.rowStep(1, 'ArrowUp', 3), 0);
    assert.equal(m.rowStep(0, 'ArrowUp', 3), -1);
    assert.equal(m.rowStep(1, 'Home', 3), 0);
    assert.equal(m.rowStep(0, 'End', 3), 2);
    assert.equal(m.rowStep(0, 'PageDown', 30, 10), 10);
    assert.equal(m.rowStep(0, 'Enter', 3), null);
    assert.equal(m.rowStep(0, 'ArrowDown', 0), null);
  });
});

describe('search: artists and playlists', () => {
  const artists = [
    { key: 'novalane', name: 'Nova Lane', count: 2 },
    { key: 'lanenova', name: 'Lane Nova', count: 9 },
    { key: 'barismanco', name: 'Barış Manço', count: 5 },
    { key: 'nova', name: 'Nova', count: 1 },
  ];
  it('artists: the name, then names that start with it, then any word; then most songs', () => {
    assert.deepEqual(m.rankArtists(artists, 'nova').map((a) => a.key), ['nova', 'novalane', 'lanenova']);
    assert.deepEqual(m.rankArtists(artists, 'baris').map((a) => a.key), ['barismanco'], 'Turkish-aware');
    assert.deepEqual(m.rankArtists(artists, ''), []);
    assert.equal(m.rankArtists(artists, 'a', 2).length, 2);
  });
  it('playlists: only those listed for this viewer, by name or owner, best name first', () => {
    const pls = [
      { id: '1', name: 'Summer hits', ownerName: 'Bora' },
      { id: '2', name: 'Late summer', ownerName: 'Ada', pinnedByMe: true },
      { id: '3', name: 'Workout', ownerName: 'Summer Smith' },
      { id: '4', name: 'Jazz', ownerName: 'Ada' },
    ];
    assert.deepEqual(m.rankPlaylists(pls, 'summer').map((p) => p.id), ['1', '2', '3']);
    assert.deepEqual(m.rankPlaylists(pls, 'ada').map((p) => p.id), ['2', '4']);
    assert.deepEqual(m.rankPlaylists(pls, ''), []);
  });
});

describe('search: the route', () => {
  it('/search?q= is a page of its own, deep-linkable', () => {
    assert.deepEqual(router.parseRoute('/search', '?q=daft%20punk'), { view: 'search', lobbyId: null, library: null, searchQuery: 'daft punk' });
    assert.deepEqual(router.parseRoute('/search/'), { view: 'search', lobbyId: null, library: null, searchQuery: '' });
    assert.equal(router.parseRoute('/search', `?q=${'x'.repeat(500)}`).searchQuery.length, router.SEARCH_MAX);
    assert.equal(router.parseRoute('/search', '?q=%20%20a%20%20%20b%20').searchQuery, 'a b');
  });
  it('builds the path back', () => {
    assert.equal(router.searchPath(''), '/search');
    assert.equal(router.searchPath('  '), '/search');
    assert.equal(router.searchPath('a & b'), '/search?q=a+%26+b');
    assert.equal(router.parseRoute('/search', router.searchPath('çay ırmak').slice('/search'.length)).searchQuery, 'çay ırmak');
    assert.equal(router.basePath({ view: 'search' }), '/search');
  });
});

describe('search: a song played from search repeats', () => {
  const ctx = { type: 'search', query: 'x' };
  it('whatever the saved repeat mode, and without changing it', () => {
    for (const saved of ['off', 'all', 'one']) assert.equal(pq.contextRepeat(saved, ctx), 'all', saved);
    assert.equal(pq.contextRepeat('off', { type: 'lobby', lobbyId: 'p' }), 'off', 'other contexts keep the saved mode');
  });
  it('it ends: the same song again; Next and Previous restart it', () => {
    const repeat = pq.contextRepeat('off', ctx);
    assert.equal(pq.nextIndex({ length: 1, current: 0, repeat, auto: true }), 0);
    assert.equal(pq.nextIndex({ length: 1, current: 0, repeat, auto: false }), 0);
    assert.equal(pq.previousIndex({ length: 1, current: 0, repeat }), 0);
  });
  it('a song that failed to play is not looped forever: it ends, Next and Previous stop too', () => {
    const repeat = pq.contextRepeat('all', ctx);
    const blocked = () => true;
    assert.equal(pq.nextIndex({ length: 1, current: 0, repeat, auto: true, blocked }), -1, 'the player pauses');
    assert.equal(pq.nextIndex({ length: 1, current: 0, repeat, auto: false, blocked }), -1);
    assert.equal(pq.previousIndex({ length: 1, current: 0, repeat, blocked }), -1, 'nothing to restart');
  });
  it('Next and Previous restart it whatever the saved mode, shuffle or not', () => {
    for (const saved of ['off', 'all', 'one']) {
      const repeat = pq.contextRepeat(saved, ctx);
      assert.equal(pq.nextIndex({ length: 1, current: 0, repeat }), 0, saved);
      assert.equal(pq.nextIndex({ length: 1, current: 0, repeat, shuffle: true, random: () => 0.99 }), 0, `${saved}, shuffle`);
      assert.equal(pq.previousIndex({ length: 1, current: 0, repeat }), 0, saved);
    }
    assert.equal(pq.nextIndex({ length: 1, current: -1, repeat: pq.contextRepeat('off', ctx) }), 0, 'not found in its queue: from the top');
  });
});

describe('import: which rows start ticked', () => {
  const lib = (n) => video(n, { in_library: { id: `lib${n}` } });
  it('the destination\'s keys: its videos and its library songs', () => {
    const keys = pick.destinationKeys([{ youtube_id: vid(1), library_id: 'lib1' }, { youtube_id: null, library_id: 'lib9' }, { youtube_id: 'bad', library_id: null }, null]);
    assert.deepEqual([...keys].sort(), ['lib:lib1', 'lib:lib9', `yt:${vid(1)}`].sort());
  });
  it('a new playlist: everything ticked', () => {
    const items = pick.withDestination(pick.playlistItems([lib(1), video(2)]), new Set());
    assert.deepEqual(items.map((it) => [it.checked, it.already]), [[true, false], [true, false]]);
  });
  it('rows already in the destination start unticked (the same video, or the same library song)', () => {
    const keys = pick.destinationKeys([{ youtube_id: vid(1), library_id: 'lib1' }, { youtube_id: vid(7), library_id: 'lib3' }]);
    const items = pick.withDestination(pick.playlistItems([lib(1), video(2), lib(3)]), keys);
    assert.deepEqual(items.map((it) => [it.checked, it.already]), [[false, true], [true, false], [false, true]]);
  });
  it('another destination re-decides the automatic ticks, never the user\'s', () => {
    const inA = pick.destinationKeys([{ youtube_id: vid(1) }, { youtube_id: vid(2) }]);
    const inB = pick.destinationKeys([{ youtube_id: vid(3) }]);
    let items = pick.withDestination(pick.playlistItems([video(1), video(2), video(3), video(4)]), inA);
    items = pick.toggled(items, 1); // the user ticks an "already" row: theirs now
    items = pick.toggled(items, 3); // and unticks another
    items = pick.withDestination(items, inB);
    assert.deepEqual(items.map((it) => [it.checked, it.already]), [[true, false], [true, false], [false, true], [false, false]]);
    items = pick.withDestination(items, new Set());
    assert.deepEqual(items.map((it) => it.checked), [true, true, true, false]);
  });
  it('after "Select none", another destination re-ticks nothing', () => {
    const inA = pick.destinationKeys([{ youtube_id: vid(1) }]);
    const inB = pick.destinationKeys([{ youtube_id: vid(2) }]);
    let items = pick.withDestination(pick.playlistItems([video(1), video(2), video(3)]), inA);
    items = pick.allChecked(items, false);
    items = pick.withDestination(items, inB);
    assert.deepEqual(items.map((it) => it.checked), [false, false, false]);
    items = pick.withDestination(items, new Set());
    assert.deepEqual(items.map((it) => it.checked), [false, false, false], 'not even for a new playlist');
  });
  it('after "Select all", the user\'s ticks hold; only a row new to the destination is unticked', () => {
    const inA = pick.destinationKeys([{ youtube_id: vid(1) }]);
    const inB = pick.destinationKeys([{ youtube_id: vid(1) }, { youtube_id: vid(2) }]);
    let items = pick.withDestination(pick.playlistItems([video(1), video(2), video(3)]), inA);
    items = pick.allChecked(items, true);
    assert.deepEqual(items.map((it) => it.checked), [true, true, true]);
    items = pick.withDestination(items, inB);
    assert.deepEqual(items.map((it) => [it.checked, it.already]), [[true, true], [false, true], [true, false]]);
    items = pick.withDestination(items, new Set());
    assert.deepEqual(items.map((it) => it.checked), [true, true, true], 'the automatic untick comes back');
  });
  it('the confirm button\'s numbers: added now (library), requested (the rest), each video once', () => {
    let items = pick.withDestination(pick.playlistItems([lib(1), lib(2), video(3), video(4), video(3)]), pick.destinationKeys([{ youtube_id: vid(2) }]));
    assert.deepEqual(pick.importCounts(items), { now: 1, request: 2, chosen: 3, already: 1 });
    items = pick.toggled(items, 1);
    assert.deepEqual(pick.importCounts(items), { now: 2, request: 2, chosen: 4, already: 1 });
  });
});

describe('search: which library changes refetch the songs', () => {
  it('a new song, new details or new audio do', () => {
    assert.equal(m.libraryChangeMatters({ song: { id: 'n' } }), true);
    assert.equal(m.libraryChangeMatters({ song: { id: 'a' }, details: { id: 'a' } }), true);
    assert.equal(m.libraryChangeMatters({ song: { id: 'a' }, replaced: { id: 'a' } }), true);
  });
  it('a removal only when the song is on screen', () => {
    assert.equal(m.libraryChangeMatters({ removed: 'a' }, ['a', 'b']), true);
    assert.equal(m.libraryChangeMatters({ removed: 'z' }, ['a', 'b']), false);
  });
  it('reports alone, or nothing, do not', () => {
    assert.equal(m.libraryChangeMatters({ reports: { id: 'a' } }, ['a']), false);
    assert.equal(m.libraryChangeMatters(null), false);
    assert.equal(m.libraryChangeMatters({}), false);
  });
});
