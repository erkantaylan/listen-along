// Radio's search rules (radio-search.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstShown, matchingPositions, queryWords, searchStatus, songHaystack } from './radio-search.ts';
import { reconcile } from './radio-order.ts';

interface TestSong { libraryId: string; title: string; artist?: string; album?: string | null }
const song = (id: string, title: string, artist = '', album: string | null = null): TestSong => ({ libraryId: id, title, artist, album });
const hay = (s: TestSong) => songHaystack(s, s.album);

const order: TestSong[] = [
  song('a', 'Kırık Kalpler', 'Barış Manço', '2023'),
  song('b', 'Road Trip', 'Ayşe'),
  song('c', 'İstanbul Hatırası', 'Zeki Müren', 'Şarkılar'),
  song('d', 'Gülpembe', 'Barış Manço', 'Sözüm Meclisten Dışarı'),
  song('e', 'Nothing', ''),
];

describe('radio search: matching', () => {
  it('shows everything, in order, without a query', () => {
    assert.deepEqual(matchingPositions(order, '', hay), [0, 1, 2, 3, 4]);
    assert.deepEqual(matchingPositions(order, '   ', hay), [0, 1, 2, 3, 4]);
    assert.deepEqual(matchingPositions(order, null, hay), [0, 1, 2, 3, 4]);
  });
  it('matches the title, the artist and the album', () => {
    assert.deepEqual(matchingPositions(order, 'road', hay), [1]);
    assert.deepEqual(matchingPositions(order, 'manço', hay), [0, 3]);
    assert.deepEqual(matchingPositions(order, 'meclisten', hay), [3]);
  });
  it('folds Turkish letters the way the sidebar and the global search do', () => {
    assert.deepEqual(matchingPositions(order, 'kirik', hay), [0]);
    assert.deepEqual(matchingPositions(order, 'KIRIK', hay), [0]);
    assert.deepEqual(matchingPositions(order, 'istanbul', hay), [2]);
    assert.deepEqual(matchingPositions(order, 'İSTANBUL', hay), [2]);
    assert.deepEqual(matchingPositions(order, 'barıs manco', hay), [0, 3]);
    assert.deepEqual(matchingPositions(order, 'sarkilar', hay), [2]);
    assert.deepEqual(matchingPositions(order, 'ayse', hay), [1]);
  });
  it('needs every word, across fields, in any order', () => {
    assert.deepEqual(matchingPositions(order, 'manco gulpembe', hay), [3]);
    assert.deepEqual(matchingPositions(order, 'gulpembe road', hay), []);
  });
  it('keeps the station order (positions ascend), never a relevance order', () => {
    const many = Array.from({ length: 50 }, (_, i) => song(`s${i}`, i % 7 === 0 ? `Match ${i}` : `Other ${i}`));
    const shown = matchingPositions(many, 'match', hay);
    assert.deepEqual(shown, [0, 7, 14, 21, 28, 35, 42, 49]);
  });
  it('works without an album (the default haystack) and with missing artists', () => {
    assert.deepEqual(matchingPositions([{ title: 'X', libraryId: '1' }, { title: 'Y', artist: 'Xavier', libraryId: '2' }], 'x'), [0, 1]);
  });
  it('does not change the order it was given', () => {
    const copy = order.slice();
    matchingPositions(order, 'manco', hay);
    assert.deepEqual(order, copy);
  });
  it('follows a reconciled order: a song that left disappears from the results, a new one appears in place', () => {
    const fresh = [order[0], order[2], order[3], song('f', 'Manço Live', 'Barış Manço')];
    const next = reconcile(order, fresh, 'a', () => 0);
    const shown = matchingPositions(next, 'manco', hay).map((i) => next[i].libraryId);
    assert.deepEqual(new Set(shown), new Set(['a', 'd', 'f']));
  });
  it('is quick enough per keystroke for a big station', () => {
    const big = Array.from({ length: 5000 }, (_, i) => song(`s${i}`, `Title ${i}`, `Artist ${i % 300}`, `Album ${i % 40}`));
    const cache = new Map(big.map((s) => [s.libraryId, hay(s)]));
    const started = performance.now();
    for (const q of ['a', 'ar', 'art', 'arti', 'artist 1', 'artist 12']) matchingPositions(big, q, (s) => cache.get(s.libraryId) as string);
    assert.ok(performance.now() - started < 200);
  });
});

describe('radio search: words, start and status', () => {
  it('splits and folds the query', () => {
    assert.deepEqual(queryWords('  Barış   MANÇO '), ['baris', 'manco']);
    assert.deepEqual(queryWords(''), []);
  });
  it('Play starts at the first song shown', () => {
    assert.equal(firstShown([0, 1, 2]), 0);
    assert.equal(firstShown([4, 9]), 4);
    assert.equal(firstShown([]), -1);
  });
  it('says nothing without a query, "n of m" with matches, and empty with none', () => {
    assert.deepEqual(searchStatus('', 5, 5), { kind: 'none' });
    assert.deepEqual(searchStatus(' ', 5, 5), { kind: 'none' });
    assert.deepEqual(searchStatus('man', 2, 5), { kind: 'some', shown: 2, total: 5 });
    assert.deepEqual(searchStatus('zzz', 0, 5), { kind: 'empty', total: 5 });
  });
});
