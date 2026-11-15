// The listener's sound settings (the sound panel, sound-panel.ts): ONE versioned
// object in this browser's localStorage (`listen-sound`), next to the repeat and
// shuffle keys, never sent to the server or the account. Each listener hears
// their own; listening along uses the follower's own (speed aside, see
// speed-rules.ts). Pure: parse and normalise only, so a corrupt, partial, older
// or newer value never breaks the player — every field falls back to its
// default on its own. Tested in sound-settings.test.ts.
import { DEFAULT_SPEED, normalizeSpeed } from './speed-rules.ts';

export const SOUND_STORAGE_KEY = 'listen-sound';
export const SOUND_SETTINGS_VERSION = 1;

export interface SoundSettings {
  v: number;
  /** Playback speed, one of SPEED_STEPS. */
  speed: number;
}

export const DEFAULT_SOUND: Readonly<SoundSettings> = Object.freeze({
  v: SOUND_SETTINGS_VERSION,
  speed: DEFAULT_SPEED,
});

/** Anything (a parsed JSON value, a patch merged over the current settings) -> valid settings. */
export function normalizeSoundSettings(input: unknown): SoundSettings {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return {
    v: SOUND_SETTINGS_VERSION,
    speed: 'speed' in o ? normalizeSpeed(o.speed) : DEFAULT_SPEED,
  };
}

/** The stored string (or null when there is none / storage is blocked) -> settings. */
export function parseSoundSettings(raw: string | null | undefined): SoundSettings {
  if (!raw) return normalizeSoundSettings(null);
  try {
    return normalizeSoundSettings(JSON.parse(raw));
  } catch {
    return normalizeSoundSettings(null);
  }
}

export function serializeSoundSettings(settings: SoundSettings): string {
  return JSON.stringify(normalizeSoundSettings(settings));
}
