// The global search's relevance order (songSearch.js), without a database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./songSearch');

const song = (id, title, artist) => ({ id, title, artist });

describe('songSearch: folding', () => {
  it('folds case, Turkish letters and accents to one letter each', () => {
    assert.equal(s.fold('ŞARKI Işık İstanbul'), 'sarki isik istanbul');
    assert.equal(s.fold('  Beyoncé   Knowles '), 'beyonce knowles');
    assert.equal(s.fold(null), '');
  });
  it('keeps the SQL translate() strings in step with fold()', () => {
    assert.equal([...s.FOLD_FROM].length, [...s.FOLD_TO].length);
    for (const [i, c] of [...s.FOLD_FROM].entries()) assert.equal(s.fold(c), [...s.FOLD_TO][i].toLowerCase(), c);
  });
  it('query words: folded, at most ten, punctuation-only words dropped', () => {
    assert.deepEqual(s.queryWords('Barış Manço - Gülpembe'), ['baris', 'manco', 'gulpembe']);
    assert.deepEqual(s.queryWords('a & b'), ['a', 'b']);
    assert.equal(s.queryWords('w '.repeat(30)).length, s.MAX_WORDS);
    assert.deepEqual(s.queryWords('   '), []);
  });
});

describe('songSearch: relevance order', () => {
  const songs = [
    song('1', 'Love Story', 'Taylor Swift'),
    song('2', 'Hello', 'Adele'),
    song('3', 'Hello from the Other Side (cover)', 'Someone'),
    song('4', 'Say Hello', 'Rosie Thomas'),
    song('5', 'Goodbye', 'Hello Band'),
    song('6', 'Yellow Hellos', 'X'),
    song('7', 'Ahelloz', 'Y'),
  ];

  it('exact title, then exact artist, then title prefix, artist prefix, word starts, substrings', () => {
    const ranked = s.rankSongs('hello', songs.filter((x) => x.id !== '1')).map((x) => x.id);
    // 2 exact title; 3 title prefix; 5 artist prefix; 4 + 6 a word starts with it; 7 contains it.
    assert.deepEqual(ranked, ['2', '3', '5', '4', '6', '7']);
  });

  it('is not the old alphabetical first-row-that-matches order', () => {
    const ranked = s.rankSongs('hello', [song('a', 'Ahelloz', 'Y'), song('b', 'Hello', 'Adele')]);
    assert.equal(ranked[0].id, 'b');
  });

  it('an exact artist and "artist title" beat a title that only starts with the words', () => {
    const list = [song('p', 'Adele Tribute Night', 'Various'), song('q', 'Rolling', 'Adele'), song('r', 'Hello', 'Adele')];
    assert.deepEqual(s.rankSongs('adele', list).map((x) => x.id), ['r', 'q', 'p'], 'the artist\'s songs A-Z, then the title that starts with it');
    assert.equal(s.rankSongs('adele hello', list)[0].id, 'r');
    assert.equal(s.rankSongs('hello adele', list)[0].id, 'r');
  });

  it('Turkish and punctuation do not get in the way', () => {
    const list = [song('x', 'Gülpembe', 'Barış Manço'), song('y', 'Gül Pembe Remix', 'DJ')];
    assert.equal(s.rankSongs('gulpembe', list)[0].id, 'x');
    assert.equal(s.tierOf('baris manco - gulpembe', list[0]), 1, '"artist - title" is the song');
    assert.equal(s.tierOf('AC/DC', song('z', 'T.N.T.', 'AC/DC')), 1);
  });

  it('ties go by title, artist (Turkish alphabet) and id, so the order is stable', () => {
    const list = [song('2', 'Çiçek', 'B'), song('1', 'Cicek', 'A'), song('3', 'Cicek', 'A')];
    assert.deepEqual(s.rankSongs('nothing here', list).map((x) => x.id), ['1', '3', '2']);
  });

  it('does not change what it is given', () => {
    const list = songs.slice();
    s.rankSongs('hello', list);
    assert.deepEqual(list, songs);
  });
});
