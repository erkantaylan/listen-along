import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SOUND, SOUND_SETTINGS_VERSION, normalizeSoundSettings, parseSoundSettings, serializeSoundSettings } from './sound-settings.ts';

test('missing or corrupt storage gives the defaults', () => {
  for (const raw of [null, undefined, '', '{', 'null', '42', '"x"', '[]', '{"speed":"turbo"}', '{"eqOn":"yes","eqPreset":"loud","eqCustom":"x","boost":-4}']) {
    assert.deepEqual(parseSoundSettings(raw), { ...DEFAULT_SOUND }, String(raw));
  }
});

test('a stored value round-trips', () => {
  const s = normalizeSoundSettings({ speed: 1.5, eqOn: true, eqPreset: 'custom', eqCustom: [1, 2, 3], boost: 35, effectsOnMobile: true });
  assert.deepEqual(s.eqCustom, [1, 2, 3, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.boost, 35);
  assert.deepEqual(parseSoundSettings(serializeSoundSettings(s)), s);
  assert.equal(s.v, SOUND_SETTINGS_VERSION);
});

test('each field falls back on its own; unknown fields and versions are tolerated', () => {
  const s = parseSoundSettings(JSON.stringify({ v: 99, speed: 0.75, somethingNew: true }));
  assert.equal(s.speed, 0.75);
  assert.equal(s.v, SOUND_SETTINGS_VERSION);
  assert.equal('somethingNew' in s, false);
});

test('the defaults are neutral: equalizer off and flat, no boost, effects not opted in on phones', () => {
  assert.equal(DEFAULT_SOUND.eqOn, false);
  assert.equal(DEFAULT_SOUND.eqPreset, 'flat');
  assert.deepEqual(DEFAULT_SOUND.eqCustom, Array(10).fill(0));
  assert.equal(DEFAULT_SOUND.boost, 0);
  assert.equal(DEFAULT_SOUND.effectsOnMobile, false);
});
