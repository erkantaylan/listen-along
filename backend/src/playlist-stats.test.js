// The playlist page's stats strip (frontend/playlist-stats.js, pure).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'playlist-stats.js')).href);
});

const song = (over = {}) => ({ duration: 100, addedBy: 'Ayşe', artistName: 'Band', ...over });

describe('playlistStats', () => {
  it('an empty playlist has a known length of zero and nothing else', () => {
    const s = m.playlistStats([]);
    assert.equal(s.songs, 0);
    assert.equal(s.lengthKnown, true);
    assert.equal(s.lengthPartial, false);
    assert.equal(s.artists, 0);
    assert.equal(s.topArtist, null);
    assert.equal(s.topAdder, null);
  });

  it('sums durations and marks a partly known total', () => {
    const s = m.playlistStats([song({ duration: 60 }), song({ duration: 90.5 }), song({ duration: 0 }), song({ duration: null })]);
    assert.equal(s.songs, 4);
    assert.equal(s.totalSeconds, 150.5);
    assert.equal(s.timed, 2);
    assert.equal(s.lengthPartial, true);
  });

  it('hides the length when no song has one', () => {
    const s = m.playlistStats([song({ duration: 0 })]);
    assert.equal(s.lengthKnown, false);
    assert.equal(s.lengthPartial, false);
  });

  it('counts artists without case, keeping Turkish letters apart, ignoring unknowns', () => {
    const s = m.playlistStats([
      song({ artistName: 'Ayşe' }), song({ artistName: 'AYŞE ' }), song({ artistName: 'Ayse' }),
      song({ artistName: null }), song({ artistName: '' }),
    ]);
    assert.equal(s.artists, 2);
    assert.deepEqual(s.topArtist, { name: 'Ayşe', count: 2 });
  });

  it('needs a contest for a top artist or adder, and a tie goes to the first in the list', () => {
    assert.equal(m.playlistStats([song(), song()]).topArtist, null, 'one artist');
    assert.equal(m.playlistStats([song(), song()]).topAdder, null, 'one adder');
    assert.equal(m.playlistStats([song({ artistName: 'A' }), song({ artistName: 'B' })]).topArtist, null, 'nobody twice');
    const tied = m.playlistStats([song({ artistName: 'B' }), song({ artistName: 'A' }), song({ artistName: 'A' }), song({ artistName: 'B' })]);
    assert.equal(tied.topArtist.name, 'B');
  });

  it('does not count the anonymous placeholder as someone', () => {
    const s = m.playlistStats([song({ addedBy: 'anonymous' }), song({ addedBy: 'anonymous' }), song({ addedBy: 'Mert' }), song({ addedBy: 'Mert' })]);
    assert.equal(s.topAdder, null);
  });
});

describe('lengthParts', () => {
  it('seconds below a minute, rounded minutes above, hours from 60 minutes', () => {
    assert.deepEqual(m.lengthParts(0), { hours: 0, minutes: 0, seconds: 0 });
    assert.deepEqual(m.lengthParts(45), { hours: 0, minutes: 0, seconds: 45 });
    assert.deepEqual(m.lengthParts(89), { hours: 0, minutes: 1, seconds: 0 });
    assert.deepEqual(m.lengthParts(3580), { hours: 1, minutes: 0, seconds: 0 });
    assert.deepEqual(m.lengthParts(6 * 3600 + 12 * 60 + 10), { hours: 6, minutes: 12, seconds: 0 });
  });
});
