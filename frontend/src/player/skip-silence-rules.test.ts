import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSilence, trimPoints, startAt, jumpToMusic, crossedTail, LEAD_MARGIN_S, TAIL_MARGIN_S } from './skip-silence-rules.ts';

const s = (leadMs: number | null, trailMs: number | null) => ({ leadMs, trailMs });
const on = { enabled: true, following: false };

test('the server answer, read defensively', () => {
  assert.deepEqual(readSilence({ lead_silence_ms: 4000, trail_silence_ms: 0 }), s(4000, 0));
  assert.deepEqual(readSilence({ lead_silence_ms: null, trail_silence_ms: null }), s(null, null));
  assert.deepEqual(readSilence({ lead_silence_ms: -1, trail_silence_ms: 'x' }), s(null, null));
  assert.deepEqual(readSilence(null), s(null, null));
});

test('trim points: a margin before the music and after it', () => {
  assert.deepEqual(trimPoints(s(4000, 5000), 17), { start: 4 - LEAD_MARGIN_S, end: 12 + TAIL_MARGIN_S });
  assert.deepEqual(trimPoints(s(4000, 0), 17), { start: 4 - LEAD_MARGIN_S, end: null });
  assert.deepEqual(trimPoints(s(0, 5000), 17), { start: 0, end: 12.5 });
  assert.deepEqual(trimPoints(s(4000, 5000), NaN), { start: 3.75, end: null }, 'length unknown: the start only');
});

test('nothing to trim: unmeasured, none, too short, or too little left', () => {
  assert.equal(trimPoints(null, 100), null);
  assert.equal(trimPoints(s(null, null), 100), null);
  assert.equal(trimPoints(s(0, 0), 100), null);
  assert.equal(trimPoints(s(800, 900), 100), null, 'under a second is the song\'s own');
  assert.equal(trimPoints(s(5000, 0), 6), null, 'a 6 s file that is mostly silence plays whole');
  assert.equal(trimPoints(s(0, 8000), 10), null);
});

test('a song started from the top starts at the music; anything else as asked', () => {
  assert.equal(startAt({ ...on, silence: s(4000, 0), position: 0 }), 3.75);
  assert.equal(startAt({ ...on, silence: s(4000, 0), position: 30 }), 30, 'a position of its own (a reload, listen along)');
  assert.equal(startAt({ ...on, silence: s(null, null), position: 0 }), 0);
  assert.equal(startAt({ enabled: false, following: false, silence: s(4000, 0), position: 0 }), 0);
  assert.equal(startAt({ enabled: true, following: true, silence: s(4000, 0), position: 0 }), 0, 'listening along: the leader decides');
});

test('a late answer jumps to the music only if the listener has not moved', () => {
  assert.equal(jumpToMusic({ ...on, silence: s(4000, 0), currentTime: 0.4, seekedByListener: false }), 3.75);
  assert.equal(jumpToMusic({ ...on, silence: s(4000, 0), currentTime: 0.4, seekedByListener: true }), null);
  assert.equal(jumpToMusic({ ...on, silence: s(4000, 0), currentTime: 3.8, seekedByListener: false }), null, 'already in the music');
  assert.equal(jumpToMusic({ ...on, silence: s(0, 4000), currentTime: 0.4, seekedByListener: false }), null);
  assert.equal(jumpToMusic({ enabled: true, following: true, silence: s(4000, 0), currentTime: 0, seekedByListener: false }), null);
});

test('playing into the tail ends the song; a seek into it does not', () => {
  const at = { ...on, silence: s(0, 5000), duration: 17 }; // tail from 12.5
  assert.equal(crossedTail({ ...at, prev: 12.3, cur: 12.55 }), true);
  assert.equal(crossedTail({ ...at, prev: 12.0, cur: 12.9 }), true, '2× playback');
  assert.equal(crossedTail({ ...at, prev: 5, cur: 14 }), false, 'a seek across it');
  assert.equal(crossedTail({ ...at, prev: null, cur: 14 }), false, 'just after a seek or a start');
  assert.equal(crossedTail({ ...at, prev: 13, cur: 13.25 }), false, 'already in the tail (the listener put it there)');
  assert.equal(crossedTail({ ...at, prev: 12.3, cur: 12.4 }), false, 'not yet');
  assert.equal(crossedTail({ ...at, enabled: false, prev: 12.3, cur: 12.55 }), false);
  assert.equal(crossedTail({ ...at, following: true, prev: 12.3, cur: 12.55 }), false);
  assert.equal(crossedTail({ ...on, silence: s(4000, 0), duration: 17, prev: 16.9, cur: 17 }), false, 'no tail');
});
