import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FADE_MS, SLEEP_OFF, SLEEP_PRESETS_MIN, sleepAfter, parseCustomMinutes, remainingMs, sleepPhase, fadeFactor, formatCountdown, endedByChange,
} from './sleep-timer-rules.ts';

test('presets are 15, 30, 45 and 60 minutes', () => {
  assert.deepEqual([...SLEEP_PRESETS_MIN], [15, 30, 45, 60]);
});

test('sleepAfter sets the deadline and clamps odd minutes', () => {
  assert.deepEqual(sleepAfter(15, 1000), { kind: 'at', endsAt: 1000 + 15 * 60_000, minutes: 15 });
  assert.equal((sleepAfter(0, 0) as { minutes: number }).minutes, 1);
  assert.equal((sleepAfter(10_000, 0) as { minutes: number }).minutes, 720);
});

test('custom minutes: whole minutes or h:mm, 1 minute to 12 hours', () => {
  assert.equal(parseCustomMinutes('20'), 20);
  assert.equal(parseCustomMinutes(' 90 '), 90);
  assert.equal(parseCustomMinutes('1:30'), 90);
  assert.equal(parseCustomMinutes('0:05'), 5);
  for (const bad of ['', '0', '0:00', '721', '13:00', '1:75', '-5', '1.5', 'abc', '20m', null, undefined]) {
    assert.equal(parseCustomMinutes(bad), null, String(bad));
  }
});

test('the phases: running, the fade in the last seconds, then due', () => {
  const t = sleepAfter(1, 0);
  assert.equal(sleepPhase(t, 0), 'running');
  assert.equal(sleepPhase(t, 60_000 - FADE_MS - 1), 'running');
  assert.equal(sleepPhase(t, 60_000 - FADE_MS), 'fading');
  assert.equal(sleepPhase(t, 59_999), 'fading');
  assert.equal(sleepPhase(t, 60_000), 'due');
  assert.equal(sleepPhase(t, 99_000), 'due');
  assert.equal(sleepPhase(SLEEP_OFF, 0), 'idle');
  assert.equal(sleepPhase({ kind: 'end-of-song' }, 0), 'idle');
  assert.equal(remainingMs({ kind: 'end-of-song' }, 0), Infinity);
  assert.equal(remainingMs(t, 30_000), 30_000);
  assert.equal(remainingMs(t, 70_000), 0);
});

test('the fade goes from full to nothing and never up', () => {
  const t = sleepAfter(1, 0);
  const start = 60_000 - FADE_MS;
  assert.equal(fadeFactor(t, 0), 1);
  assert.equal(fadeFactor(t, start), 1);
  assert.equal(fadeFactor(t, 60_000), 0);
  let last = 1;
  for (let now = start; now <= 60_000; now += 250) {
    const f = fadeFactor(t, now);
    assert.ok(f <= last + 1e-12 && f >= 0 && f <= 1);
    last = f;
  }
  assert.ok(fadeFactor(t, start + FADE_MS / 2) < 0.5, 'quieter than half way by the middle');
  assert.equal(fadeFactor(SLEEP_OFF, 0), 1);
});

test('countdown text', () => {
  assert.equal(formatCountdown(15 * 60_000), '15:00');
  assert.equal(formatCountdown(14 * 60_000 + 59_001), '15:00');
  assert.equal(formatCountdown(61_000), '1:01');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(3_723_000), '1:02:03');
  assert.equal(formatCountdown(Infinity), '');
});

test('a song change counts as the end only near the end', () => {
  assert.equal(endedByChange(178, 180), true);
  assert.equal(endedByChange(100, 180), false);
  assert.equal(endedByChange(10, 0), false);
  assert.equal(endedByChange(NaN, 180), false);
});
