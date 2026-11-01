// Radio's order rules (frontend/radio-order.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
const song = (id, extra = {}) => ({ libraryId: id, ...extra });
const ids = (list) => list.map((s) => s.libraryId);
const songs = (n) => Array.from({ length: n }, (_, i) => song(`s${i}`));

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'radio-order.js')).href);
});

describe('radio-order: shuffled', () => {
  it('keeps every song once and leaves the input alone', () => {
    const input = songs(200);
    const out = m.shuffled(input);
    assert.equal(new Set(ids(out)).size, 200);
    assert.deepEqual(ids(input), ids(songs(200)));
    assert.notDeepEqual(ids(out), ids(input));
  });
  it('handles empty and single lists', () => {
    assert.deepEqual(m.shuffled([]), []);
    assert.deepEqual(ids(m.shuffled(songs(1))), ['s0']);
  });
  it('is uniform enough: each song reaches the top', () => {
    const tops = new Set();
    for (let i = 0; i < 300; i++) tops.add(m.shuffled(songs(5))[0].libraryId);
    assert.equal(tops.size, 5);
  });
});

describe('radio-order: nextRound', () => {
  it('never starts with the song that just ended', () => {
    for (let i = 0; i < 300; i++) {
      const out = m.nextRound(songs(3), 's1');
      assert.notEqual(out[0].libraryId, 's1');
      assert.equal(new Set(ids(out)).size, 3);
    }
  });
  it('a single song can only follow itself', () => {
    assert.deepEqual(ids(m.nextRound(songs(1), 's0')), ['s0']);
  });
});

describe('radio-order: reshuffledAround', () => {
  it('keeps the playing song on top', () => {
    const out = m.reshuffledAround(songs(20), 's7');
    assert.equal(out[0].libraryId, 's7');
    assert.equal(new Set(ids(out)).size, 20);
  });
  it('without a playing song it is a plain shuffle', () => {
    assert.equal(new Set(ids(m.reshuffledAround(songs(5), null))).size, 5);
  });
});

describe('radio-order: reconcile', () => {
  it('keeps the order of what stays and drops what left', () => {
    const out = m.reconcile([song('c'), song('a'), song('b')], [song('a'), song('b')]);
    assert.deepEqual(ids(out), ['a', 'b']);
  });
  it('keeps the song playing even when it left, so the place is not lost', () => {
    const out = m.reconcile([song('a'), song('b'), song('c')], [song('a'), song('c')], 'b');
    assert.deepEqual(ids(out), ['a', 'b', 'c']);
  });
  it('puts new songs after the current one: heard this round, nothing replays', () => {
    const order = [song('a'), song('b'), song('c')];
    for (let i = 0; i < 100; i++) {
      const out = m.reconcile(order, [...order, song('new')], 'b');
      assert.ok(ids(out).indexOf('new') > 1, ids(out).join());
      assert.deepEqual(ids(out).filter((id) => id !== 'new'), ['a', 'b', 'c']);
    }
  });
  it('a new song can land anywhere when nothing plays', () => {
    const order = [song('a'), song('b')];
    const places = new Set();
    for (let i = 0; i < 200; i++) places.add(ids(m.reconcile(order, [...order, song('new')])).indexOf('new'));
    assert.deepEqual([...places].sort(), [0, 1, 2]);
  });
  it('takes the fresh metadata (a replaced song has a new src and title)', () => {
    const out = m.reconcile([song('a', { title: 'old' })], [song('a', { title: 'new' })]);
    assert.equal(out[0].title, 'new');
  });
  it('an emptied station leaves only the playing song', () => {
    assert.deepEqual(ids(m.reconcile(songs(3), [], 's1')), ['s1']);
    assert.deepEqual(m.reconcile(songs(3), []), []);
  });
});
