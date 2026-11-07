// Artists' pure rules (frontend/artist-rules.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
const artist = (name, count) => ({ key: name.toLowerCase(), name, count });
const song = (id) => ({ libraryId: id });
const ids = (list) => list.map((s) => s.libraryId);

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'artist-rules.js')).href);
});

describe('artist-rules: shelfArtists', () => {
  it('keeps the server order, drops one-song artists and caps the count', () => {
    const list = [artist('A', 9), artist('B', 3), artist('C', 1), artist('D', 2), artist('E', 1)];
    assert.deepEqual(m.shelfArtists(list).map((a) => a.name), ['A', 'B', 'D']);
    assert.deepEqual(m.shelfArtists(list, { limit: 2 }).map((a) => a.name), ['A', 'B']);
  });
  it('shows the one-song artists when nobody has more', () => {
    assert.deepEqual(m.shelfArtists([artist('A', 1), artist('B', 1)]).map((a) => a.name), ['A', 'B']);
  });
  it('copes with nothing', () => {
    assert.deepEqual(m.shelfArtists([]), []);
    assert.deepEqual(m.shelfArtists(null), []);
  });
  it('caps hundreds at the shelf limit', () => {
    const many = Array.from({ length: 500 }, (_, i) => artist(`X${i}`, 500 - i));
    assert.equal(m.shelfArtists(many).length, m.SHELF_LIMIT);
  });
});

describe('artist-rules: sortByName and filterArtists', () => {
  it('sorts in the Turkish alphabet, numbers as numbers', () => {
    const list = ['Zeynep', 'Çelik', 'cem', 'İlhan', 'Işık', '10 Numara', '9 Numara'].map((n) => artist(n, 1));
    assert.deepEqual(m.sortByName(list).map((a) => a.name), ['9 Numara', '10 Numara', 'cem', 'Çelik', 'Işık', 'İlhan', 'Zeynep']);
  });
  it('matches every word, ignoring case, accents and Turkish dots', () => {
    const list = [artist('Barış Manço', 3), artist('Sezen Aksu', 2), artist('İlhan İrem', 1)];
    assert.deepEqual(m.filterArtists(list, 'baris').map((a) => a.name), ['Barış Manço']);
    assert.deepEqual(m.filterArtists(list, 'ilhan irem').map((a) => a.name), ['İlhan İrem']);
    assert.deepEqual(m.filterArtists(list, 'aksu sezen').map((a) => a.name), ['Sezen Aksu']);
    assert.deepEqual(m.filterArtists(list, 'xyz'), []);
    assert.equal(m.filterArtists(list, '  ').length, 3);
  });
});

describe('artist-rules: keepCurrent', () => {
  it('takes the fresh list when the song on air is in it', () => {
    assert.deepEqual(ids(m.keepCurrent([song('a'), song('c')], [song('a'), song('b'), song('c')], 'c')), ['a', 'c']);
  });
  it('keeps a song on air that left, in its old place', () => {
    assert.deepEqual(ids(m.keepCurrent([song('a'), song('c')], [song('a'), song('b'), song('c')], 'b')), ['a', 'b', 'c']);
    assert.deepEqual(ids(m.keepCurrent([song('a')], [song('a'), song('b'), song('c')], 'c')), ['a', 'c']);
    assert.deepEqual(ids(m.keepCurrent([], [song('x')], 'x')), ['x']);
  });
  it('does nothing special without a song on air, and never touches its inputs', () => {
    const fresh = [song('a')];
    const out = m.keepCurrent(fresh, [song('b')], null);
    assert.deepEqual(ids(out), ['a']);
    assert.notEqual(out, fresh);
    assert.deepEqual(ids(m.keepCurrent(fresh, [song('b')], 'zz')), ['a']);
  });
});
