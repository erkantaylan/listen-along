import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EQ_BANDS, EQ_PRESETS, EQ_PRESET_IDS, EQ_MAX_DB, EQ_MIN_DB, bandType, normalizeGains, gainsFor, isFlat, withBand,
  normalizeBoost, boostGain, graphPlan, isNeutral, isMobileBrowser, formatDb, formatBand, isEqChoice, LIMITER,
} from './equalizer-rules.ts';

test('ten bands at the ISO octave centres, shelves at both ends', () => {
  assert.deepEqual([...EQ_BANDS], [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  assert.equal(bandType(0), 'lowshelf');
  assert.equal(bandType(9), 'highshelf');
  for (let i = 1; i < 9; i++) assert.equal(bandType(i), 'peaking');
});

test('every preset has ten moderate gains on the grid; flat is all zero', () => {
  for (const id of EQ_PRESET_IDS) {
    const g = EQ_PRESETS[id];
    assert.equal(g.length, 10, id);
    assert.deepEqual(normalizeGains(g), [...g], `${id} is already normalised`);
    assert.ok(Math.max(...g) <= 6 && Math.min(...g) >= -6, `${id} stays within ±6 dB`);
  }
  assert.ok(isFlat(EQ_PRESETS.flat));
  for (const id of EQ_PRESET_IDS.filter((p) => p !== 'flat')) assert.ok(!isFlat(EQ_PRESETS[id]), id);
  // Shapes, roughly: bass lifts the lows, treble the highs, vocal the middle.
  const lows = (g: readonly number[]) => g[0] + g[1] + g[2];
  const highs = (g: readonly number[]) => g[7] + g[8] + g[9];
  assert.ok(lows(EQ_PRESETS.bass) > 0 && highs(EQ_PRESETS.bass) === 0);
  assert.ok(highs(EQ_PRESETS.treble) > 0 && lows(EQ_PRESETS.treble) === 0);
  assert.ok(EQ_PRESETS.vocal[5] + EQ_PRESETS.vocal[6] > 0 && lows(EQ_PRESETS.vocal) < 0);
  assert.ok(EQ_PRESETS.laptop[0] < 0, 'small speakers: no sub bass they cannot play');
});

test('gains are clamped, put on the half-dB grid, and padded', () => {
  assert.deepEqual(normalizeGains([20, -30, 1.26, 'x', null]), [EQ_MAX_DB, EQ_MIN_DB, 1.5, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(normalizeGains('nope'), Array(10).fill(0));
  assert.ok(!Object.is(normalizeGains([-0.1])[0], -0), 'no negative zero');
});

test('dragging a band makes the curve custom, starting from the preset in use', () => {
  const r = withBand('bass', [], 9, 3);
  assert.equal(r.eqPreset, 'custom');
  assert.deepEqual(r.eqCustom, [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 3]);
  assert.deepEqual(gainsFor('custom', r.eqCustom), r.eqCustom);
  assert.deepEqual(gainsFor('treble', r.eqCustom), [...EQ_PRESETS.treble]);
  assert.ok(isEqChoice('custom') && isEqChoice('rock') && !isEqChoice('loud'));
});

test('boost: 0..100 % in steps of 5; +100 % doubles', () => {
  assert.equal(normalizeBoost(42), 40);
  assert.equal(normalizeBoost(250), 100);
  assert.equal(normalizeBoost(-5), 0);
  assert.equal(normalizeBoost('x'), 0);
  assert.equal(boostGain(0), 1);
  assert.equal(boostGain(100), 2);
  assert.equal(boostGain(50), 1.5);
});

test('the neutral state is no graph at all', () => {
  const base = { eqOn: false, eqPreset: 'flat' as const, eqCustom: [], boost: 0 };
  assert.deepEqual(graphPlan(base), { route: 'direct' });
  assert.ok(isNeutral(base));
  assert.ok(isNeutral({ ...base, eqOn: true }), 'EQ on but flat');
  assert.ok(isNeutral({ ...base, eqOn: false, eqPreset: 'rock' }), 'a preset with the EQ off');
  assert.ok(isNeutral({ ...base, eqOn: true, eqPreset: 'custom', eqCustom: Array(10).fill(0) }));
});

test('effects: bands only when the EQ is on and not flat; the boost gain', () => {
  assert.deepEqual(graphPlan({ eqOn: true, eqPreset: 'rock', eqCustom: [], boost: 0 }), { route: 'effects', gains: [...EQ_PRESETS.rock], gain: 1 });
  assert.deepEqual(graphPlan({ eqOn: false, eqPreset: 'rock', eqCustom: [], boost: 30 }), { route: 'effects', gains: null, gain: 1.3 });
  assert.deepEqual(graphPlan({ eqOn: true, eqPreset: 'flat', eqCustom: [], boost: 100 }), { route: 'effects', gains: null, gain: 2 });
});

test('the limiter is a brick wall just under full scale', () => {
  assert.ok(LIMITER.threshold < 0 && LIMITER.threshold >= -3);
  assert.ok(LIMITER.ratio >= 20 && LIMITER.knee === 0 && LIMITER.attack <= 0.003);
});

test('phones and tablets need the opt-in; desktops do not', () => {
  const desktop = { coarsePointer: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0' };
  assert.equal(isMobileBrowser(desktop), false);
  assert.equal(isMobileBrowser({ ...desktop, coarsePointer: true }), true);
  assert.equal(isMobileBrowser({ coarsePointer: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }), true);
  assert.equal(isMobileBrowser({ coarsePointer: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' }), true);
  assert.equal(isMobileBrowser({ coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS');
  assert.equal(isMobileBrowser({ coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 0 }), false);
});

test('labels', () => {
  assert.equal(formatDb(3), '+3 dB');
  assert.equal(formatDb(-2.5), '−2.5 dB');
  assert.equal(formatDb(-2.5, 'tr'), '−2,5 dB');
  assert.equal(formatDb(0), '0 dB');
  assert.deepEqual(EQ_BANDS.map(formatBand), ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
});
