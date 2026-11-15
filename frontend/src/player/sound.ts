// The listener's sound settings as the page uses them: loaded once from
// localStorage (sound-settings.ts parses), changed by the sound panel, saved
// at once, and announced to whoever applies them (speed.ts, ...).
import { storageGet, storageSet } from '../shared/state.ts';
import { SOUND_STORAGE_KEY, normalizeSoundSettings, parseSoundSettings, serializeSoundSettings } from './sound-settings.ts';
import type { SoundSettings } from './sound-settings.ts';

let settings: SoundSettings = parseSoundSettings(storageGet(SOUND_STORAGE_KEY));
const subscribers = new Set<(s: SoundSettings) => void>();

export function soundSettings(): SoundSettings {
  return settings;
}

/** Merge a change in, normalise, save and tell everyone. */
export function updateSound(patch: Partial<SoundSettings>): void {
  const next = normalizeSoundSettings({ ...settings, ...patch });
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  settings = next;
  storageSet(SOUND_STORAGE_KEY, serializeSoundSettings(settings));
  for (const fn of subscribers) {
    try { fn(settings); } catch (err) { console.error('sound settings subscriber failed:', err); }
  }
}

export function onSoundChange(fn: (s: SoundSettings) => void): () => boolean {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
