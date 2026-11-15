// What a playlist row shows (queue-format.ts, pure).
// (Moved from backend/src/queue-rows.test.js.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as f from './queue-format.ts';

describe('row text (queue-format.ts)', () => {
  it('splits only on the known artist, never guessing at " - "', () => {
    assert.deepEqual(f.songParts({ title: 'Yağmur - Live - Ayşe', artistName: 'Ayşe' }), { title: 'Yağmur - Live', artist: 'Ayşe' });
    assert.deepEqual(f.songParts({ title: 'Queen - Bohemian', artistName: null }), { title: 'Queen - Bohemian', artist: '' });
    assert.deepEqual(f.songParts({ title: 'Renamed', artistName: 'Ayşe' }), { title: 'Renamed', artist: 'Ayşe' });
    assert.deepEqual(f.songParts({ title: ' - Ayşe', artistName: 'Ayşe' }), { title: ' - Ayşe', artist: 'Ayşe' });
  });

  it('leaves the placeholder name and missing dates blank', () => {
    assert.equal(f.addedByLabel('anonymous'), '');
    assert.equal(f.addedByLabel('Anonymous'), '');
    assert.equal(f.addedByLabel(null), '');
    assert.equal(f.addedByLabel(' Ayşe '), 'Ayşe');
    // 'x': not a timestamp at all (old or damaged data).
    for (const bad of [null, undefined, 0, NaN, 'x' as unknown as number]) assert.equal(f.addedDateLabel(bad, 'en'), '');
    assert.match(f.addedDateLabel(Date.UTC(2026, 5, 15, 12), 'en'), /2026/);
  });
});
