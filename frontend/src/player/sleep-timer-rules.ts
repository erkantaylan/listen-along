// The sleep timer's rules: what can be chosen, the countdown, and the fade at
// the end. Pure (no DOM), tested in sleep-timer-rules.test.ts; sleep-timer.ts
// runs it. The timer lives in the page only (a reload cancels it).

export const SLEEP_PRESETS_MIN: readonly number[] = [15, 30, 45, 60];
export const MIN_CUSTOM_MIN = 1;
export const MAX_CUSTOM_MIN = 12 * 60;
/** The fade before the pause. */
export const FADE_MS = 8000;

export type SleepTimer =
  | { kind: 'off' }
  | { kind: 'at'; endsAt: number; minutes: number }
  | { kind: 'end-of-song' };

export const SLEEP_OFF: SleepTimer = Object.freeze({ kind: 'off' });

export function sleepAfter(minutes: number, now: number): SleepTimer {
  const m = Math.min(MAX_CUSTOM_MIN, Math.max(MIN_CUSTOM_MIN, Math.round(minutes)));
  return { kind: 'at', endsAt: now + m * 60_000, minutes: m };
}

/**
 * What a listener typed in the custom field -> minutes, or null. Accepts
 * whole minutes ("20", " 90 ") and hours:minutes ("1:30"); 1 minute to 12 hours.
 */
export function parseCustomMinutes(input: unknown): number | null {
  const s = String(input ?? '').trim();
  let m: number;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (hm) m = Number(hm[1]) * 60 + Number(hm[2]);
  else if (/^\d{1,4}$/.test(s)) m = Number(s);
  else return null;
  return m >= MIN_CUSTOM_MIN && m <= MAX_CUSTOM_MIN ? m : null;
}

/** ms until the timer goes off (0 when due; Infinity when it waits for the song's end or is off). */
export function remainingMs(timer: SleepTimer, now: number): number {
  if (timer.kind !== 'at') return Infinity;
  return Math.max(0, timer.endsAt - now);
}

/**
 * Where a timed sleep is: 'running' (counting down), 'fading' (the last
 * FADE_MS: the volume goes down), 'due' (pause now). Off and end-of-song are 'idle'.
 */
export function sleepPhase(timer: SleepTimer, now: number): 'idle' | 'running' | 'fading' | 'due' {
  if (timer.kind !== 'at') return 'idle';
  const left = remainingMs(timer, now);
  if (left <= 0) return 'due';
  return left <= FADE_MS ? 'fading' : 'running';
}

/**
 * The volume factor during the fade: 1 at its start, 0 at the end. Squared, so
 * the loudness falls evenly to the ear rather than lingering and then dropping.
 */
export function fadeFactor(timer: SleepTimer, now: number): number {
  if (sleepPhase(timer, now) !== 'fading') return sleepPhase(timer, now) === 'due' ? 0 : 1;
  const x = remainingMs(timer, now) / FADE_MS;
  return Math.max(0, Math.min(1, x * x));
}

/** "14:59", "1:02:03" (rounded up, so 0:01 shows until it goes off). */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Listening along, the leader's next song may arrive before this one ended
 * here. With "end of song" armed, a song change counts as the end when the
 * last position seen was within `slackS` of the song's end.
 */
export function endedByChange(lastTime: number, lastDuration: number, slackS = 4): boolean {
  return Number.isFinite(lastDuration) && lastDuration > 0 && Number.isFinite(lastTime) && lastTime >= lastDuration - slackS;
}
