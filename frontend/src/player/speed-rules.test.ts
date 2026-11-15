import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEED_STEPS, normalizeSpeed, leaderJumped, speedIndex, speedAt, playbackRateFor, leaderRate, followsPosition, leaderPosition, formatSpeed,
} from './speed-rules.ts';

test('speed steps run from 0.5× to 2× with 1× among them', () => {
  assert.equal(SPEED_STEPS[0], 0.5);
  assert.equal(SPEED_STEPS[SPEED_STEPS.length - 1], 2);
  assert.ok(SPEED_STEPS.includes(1));
  for (let i = 1; i < SPEED_STEPS.length; i++) assert.ok(SPEED_STEPS[i] > SPEED_STEPS[i - 1]);
});

test('normalizeSpeed snaps to the nearest step and falls back to 1', () => {
  assert.equal(normalizeSpeed(1.25), 1.25);
  assert.equal(normalizeSpeed(1.3), 1.25);
  assert.equal(normalizeSpeed('1.5'), 1.5);
  assert.equal(normalizeSpeed(2), 2);
  for (const bad of [0, 0.2, 3, -1, NaN, Infinity, null, undefined, '', 'fast', {}, []]) assert.equal(normalizeSpeed(bad), 1, String(bad));
});

test('slider index and speed map both ways', () => {
  SPEED_STEPS.forEach((s, i) => { assert.equal(speedIndex(s), i); assert.equal(speedAt(i), s); });
  assert.equal(speedAt(-3), 0.5);
  assert.equal(speedAt(99), 2);
  assert.equal(speedAt('x'), 1);
});

test('a follower plays at 1×; otherwise the saved speed', () => {
  assert.equal(playbackRateFor({ speed: 1.5, following: true }), 1);
  assert.equal(playbackRateFor({ speed: 1.5, following: false }), 1.5);
  assert.equal(playbackRateFor({ speed: 7, following: false }), 1);
});

test('leaderRate: missing or odd is 1, extremes are clamped', () => {
  assert.equal(leaderRate(undefined), 1);
  assert.equal(leaderRate(null), 1);
  assert.equal(leaderRate('abc'), 1);
  assert.equal(leaderRate(0), 1);
  assert.equal(leaderRate(-2), 1);
  assert.equal(leaderRate(1.5), 1.5);
  assert.equal(leaderRate(100), 4);
  assert.equal(leaderRate(0.01), 0.25);
});

test('positions are corrected only while the leader plays at 1×', () => {
  assert.equal(followsPosition(1), true);
  assert.equal(followsPosition(undefined as unknown as number), true); // an older leader
  assert.equal(followsPosition(1.25), false);
  assert.equal(followsPosition(0.75), false);
});

test('the leader position moves at the leader rate while playing', () => {
  assert.equal(leaderPosition({ position: 10, elapsedS: 4, playing: true }), 14);
  assert.equal(leaderPosition({ position: 10, elapsedS: 4, playing: true, rate: 1.5 }), 16);
  assert.equal(leaderPosition({ position: 10, elapsedS: 4, playing: false, rate: 2 }), 10);
  assert.equal(leaderPosition({ position: -5, elapsedS: -1, playing: true }), 0);
});

test('formatSpeed reads naturally in both languages', () => {
  assert.equal(formatSpeed(1), '1×');
  assert.equal(formatSpeed(1.25), '1.25×');
  assert.equal(formatSpeed(0.75, 'tr'), '0,75×');
});

test('a leader seek is told apart from a leader moving on at their speed', () => {
  const prev = { position: 10, updatedAt: 0, playing: true, rate: 1.5 };
  assert.equal(leaderJumped(prev, { position: 25, updatedAt: 10000, playing: true, rate: 1.5 }), false); // 10 + 10*1.5
  assert.equal(leaderJumped(prev, { position: 80, updatedAt: 10000, playing: true, rate: 1.5 }), true);
  assert.equal(leaderJumped(prev, { position: 0, updatedAt: 10000, playing: true, rate: 1.5 }), true);
  assert.equal(leaderJumped({ position: 10, updatedAt: 0, playing: false, rate: 2 }, { position: 10, updatedAt: 60000, playing: true, rate: 2 }), false);
  assert.equal(leaderJumped(null, prev), false);
});
