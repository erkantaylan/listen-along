import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SOUND, SOUND_SETTINGS_VERSION, normalizeSoundSettings, parseSoundSettings, serializeSoundSettings } from './sound-settings.ts';

test('missing or corrupt storage gives the defaults', () => {
  for (const raw of [null, undefined, '', '{', 'null', '42', '"x"', '[]', '{"speed":"turbo"}']) {
    assert.deepEqual(parseSoundSettings(raw), { ...DEFAULT_SOUND }, String(raw));
  }
});

test('a stored value round-trips', () => {
  const s = normalizeSoundSettings({ speed: 1.5 });
  assert.deepEqual(parseSoundSettings(serializeSoundSettings(s)), s);
  assert.equal(s.v, SOUND_SETTINGS_VERSION);
});

test('each field falls back on its own; unknown fields and versions are tolerated', () => {
  const s = parseSoundSettings(JSON.stringify({ v: 99, speed: 0.75, somethingNew: true }));
  assert.equal(s.speed, 0.75);
  assert.equal(s.v, SOUND_SETTINGS_VERSION);
  assert.equal('somethingNew' in s, false);
});
