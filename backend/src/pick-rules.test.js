// The pick dialog's rules (frontend/pick-rules.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
const id = (n) => `video${String(n).padStart(6, '0')}`;
const video = (n, extra = {}) => ({ youtube_id: id(n), title: `Title ${n}`, channel: 'Ch', duration_sec: 200, in_library: null, ...extra });

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'pick-rules.js')).href);
});

describe('pick-rules: selection keys', () => {
  it('arrows move by one and stop at the ends', () => {
    assert.equal(m.moveIndex(0, 'ArrowDown', 5), 1);
    assert.equal(m.moveIndex(4, 'ArrowDown', 5), 4);
    assert.equal(m.moveIndex(0, 'ArrowUp', 5), 0);
    assert.equal(m.moveIndex(3, 'ArrowUp', 5), 2);
  });
  it('Home, End and the page keys', () => {
    assert.equal(m.moveIndex(3, 'Home', 5), 0);
    assert.equal(m.moveIndex(1, 'End', 5), 4);
    assert.equal(m.moveIndex(1, 'PageDown', 50, 10), 11);
    assert.equal(m.moveIndex(45, 'PageDown', 50, 10), 49);
    assert.equal(m.moveIndex(3, 'PageUp', 50, 10), 0);
  });
  it('other keys and an empty list are not ours', () => {
    assert.equal(m.moveIndex(0, 'Enter', 5), null);
    assert.equal(m.moveIndex(0, 'a', 5), null);
    assert.equal(m.moveIndex(0, 'ArrowDown', 0), null);
  });
});

describe('pick-rules: a playlist\'s picks', () => {
  it('starts with every video ticked, in order', () => {
    const items = m.playlistItems([video(1), video(2), video(3)]);
    assert.deepEqual(items.map((it) => it.checked), [true, true, true]);
    assert.deepEqual(m.chosenIds(items), [id(1), id(2), id(3)]);
    assert.deepEqual(items.map((it) => it.key), [0, 1, 2]);
  });
  it('leaves out what is not a video', () => {
    assert.equal(m.playlistItems([video(1), null, { youtube_id: 'nope' }, { title: 'x' }]).length, 1);
    assert.deepEqual(m.playlistItems(undefined), []);
  });
  it('unticking leaves a video out, without touching the others', () => {
    const items = m.playlistItems([video(1), video(2), video(3)]);
    const next = m.toggled(items, 1);
    assert.deepEqual(m.chosenIds(next), [id(1), id(3)]);
    assert.equal(items[1].checked, true, 'the old list is not changed');
    assert.deepEqual(m.chosenIds(m.toggled(next, 1)), [id(1), id(2), id(3)]);
  });
  it('select all / none', () => {
    const items = m.toggled(m.playlistItems([video(1), video(2)]), 0);
    assert.deepEqual(m.chosenIds(m.allChecked(items, false)), []);
    assert.deepEqual(m.chosenIds(m.allChecked(items, true)), [id(1), id(2)]);
  });
  it('a swap replaces the video at its place and ticks it', () => {
    let items = m.toggled(m.playlistItems([video(1), video(2), video(3)]), 1);
    items = m.swapped(items, 1, video(9));
    assert.deepEqual(m.chosenIds(items), [id(1), id(9), id(3)]);
    assert.equal(m.isSwapped(items[1]), true);
    assert.equal(m.isSwapped(items[0]), false);
    assert.equal(items[1].original.youtube_id, id(2), 'the playlist\'s own video is remembered');
    assert.equal(m.isSwapped(m.swapped(items, 1, video(2))[1]), false, 'swapping back');
  });
  it('a swap with something that is not a video changes nothing', () => {
    const items = m.playlistItems([video(1)]);
    assert.equal(m.swapped(items, 0, null), items);
    assert.equal(m.swapped(items, 0, { youtube_id: 'bad id' }), items);
  });
  it('the same video twice is sent once', () => {
    const items = m.swapped(m.playlistItems([video(1), video(2)]), 1, video(1));
    assert.deepEqual(m.chosenIds(items), [id(1)]);
  });
  it('counts what is ticked and what the library already has', () => {
    let items = m.playlistItems([video(1, { in_library: { id: 's' } }), video(2), video(3)]);
    assert.deepEqual(m.counts(items), { total: 3, ticked: 3, chosen: 3, inLibrary: 1, toDownload: 2 });
    items = m.toggled(items, 0);
    assert.deepEqual(m.counts(items), { total: 3, ticked: 2, chosen: 2, inLibrary: 0, toDownload: 2 });
  });
  it('counts a video once, as it is sent once: the same video twice, or two rows swapped to one', () => {
    const twice = m.playlistItems([video(1), video(2), video(1)]);
    assert.deepEqual(m.counts(twice), { total: 3, ticked: 3, chosen: 2, inLibrary: 0, toDownload: 2 });
    assert.equal(m.counts(twice).chosen, m.chosenIds(twice).length);
    let items = m.playlistItems([video(1), video(2), video(3)]);
    items = m.swapped(m.swapped(items, 0, video(9, { in_library: { id: 's' } })), 2, video(9, { in_library: { id: 's' } }));
    assert.deepEqual(m.counts(items), { total: 3, ticked: 3, chosen: 2, inLibrary: 1, toDownload: 1 });
    assert.equal(m.counts(m.toggled(items, 0)).chosen, m.chosenIds(m.toggled(items, 0)).length);
  });
});

describe('pick-rules: swap choices', () => {
  it('searches for the playlist\'s own title, also after a swap', () => {
    const items = m.swapped(m.playlistItems([video(1, { title: '  My   Song ' })]), 0, video(9));
    assert.equal(m.swapQuery(items[0]), 'My Song');
    assert.equal(m.swapQuery(m.playlistItems([video(1, { title: null })])[0]), '');
  });
  it('lists the playlist\'s own video first, without repeats, and selects the current one', () => {
    const item = m.playlistItems([video(1)])[0];
    const first = m.swapChoices(item, [video(2), video(1), video(3)]);
    assert.deepEqual(first.videos.map((v) => v.youtube_id), [id(1), id(2), id(3)]);
    assert.equal(first.selected, 0);
    const after = m.swapChoices(m.swapped([item], 0, video(3))[0], [video(2), video(1), video(3)]);
    assert.equal(after.selected, 2);
  });
  it('keeps the current pick in the list when the search no longer returns it', () => {
    const item = m.swapped(m.playlistItems([video(1)]), 0, video(7))[0];
    const c = m.swapChoices(item, [video(2)]);
    assert.deepEqual(c.videos.map((v) => v.youtube_id), [id(1), id(2), id(7)]);
    assert.equal(c.selected, 2);
  });
});

describe('pick-rules: what is sent', () => {
  it('the Download box', () => {
    assert.deepEqual(m.jobPayload([id(1)], undefined), { picks: [id(1)] });
    assert.deepEqual(m.jobPayload([id(1), id(2)], 'abc123'), { picks: [id(1), id(2)], playlist_id: 'abc123' });
  });
  it('the playlist box', () => {
    assert.deepEqual(m.queuePayload('abc123', [id(1)]), { lobbyId: 'abc123', picks: [id(1)] });
  });
  it('thumbnail and watch links', () => {
    assert.equal(m.thumbUrl('dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
    assert.equal(m.watchUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(m.isVideoId('dQw4w9WgXcQ'), true);
    assert.equal(m.isVideoId('short'), false);
    assert.equal(m.isVideoId(null), false);
  });
});

describe('pick-rules: what a lookup answer means', () => {
  it('results open the dialog; a library song does not', () => {
    assert.equal(m.lookupOutcome(200, { kind: 'search', results: [] }), 'pick');
    assert.equal(m.lookupOutcome(200, { kind: 'playlist', results: [video(1)], total: 1 }), 'pick');
    assert.equal(m.lookupOutcome(200, { kind: 'library', song: { id: 's' } }), 'library');
  });
  it('a failed or refused lookup is an error to retry', () => {
    for (const status of [0, 429, 500, 502, 503]) assert.equal(m.lookupOutcome(status, { error: 'x' }), 'error', String(status));
  });
  it('anything else goes the way it went without a dialog', () => {
    assert.equal(m.lookupOutcome(400, { error: 'Unsupported link', code: 'BAD_INPUT' }), 'passthrough');
    assert.equal(m.lookupOutcome(404, null), 'passthrough');
    assert.equal(m.lookupOutcome(200, { unexpected: true }), 'passthrough');
    assert.equal(m.lookupOutcome(200, null), 'passthrough');
  });
});
