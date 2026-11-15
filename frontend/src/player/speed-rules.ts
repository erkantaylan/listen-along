// Playback speed: the steps the sound panel offers and how speed meets listen
// along. Pure (no DOM), tested in speed-rules.test.ts.
//
// The rule with listen along (CLAUDE.md "Listen along"): a follower's position
// is kept on the leader's, so a follower always plays at 1× (their own saved
// speed is set aside while following and applies again afterwards). The leader
// keeps their speed; their now-playing report carries it (`rate`, additive) and
// listen:sync passes it on. A follower uses it to place the leader correctly
// when a song starts (the leader's position moves `rate` seconds per second),
// and corrects drift only while the leader plays at 1×: at another speed a
// follower at 1× would drift on purpose, and pulling them back every few
// seconds would be worse than letting the song play. Song changes, play /
// pause and the leader's own seeks (leaderJumped) stay in step whatever the
// speed.

export const SPEED_STEPS: readonly number[] = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const DEFAULT_SPEED = 1;
export const MIN_SPEED = SPEED_STEPS[0];
export const MAX_SPEED = SPEED_STEPS[SPEED_STEPS.length - 1];

/** A stored or chosen speed as one of SPEED_STEPS (the nearest); 1 for anything else. */
export function normalizeSpeed(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < MIN_SPEED - 0.001 || n > MAX_SPEED + 0.001) return DEFAULT_SPEED;
  let best = SPEED_STEPS[0];
  for (const step of SPEED_STEPS) if (Math.abs(step - n) < Math.abs(best - n)) best = step;
  return best;
}

/** The slider position of a speed (index into SPEED_STEPS). */
export function speedIndex(speed: number): number {
  return SPEED_STEPS.indexOf(normalizeSpeed(speed));
}

/** The speed at a slider position (clamped). */
export function speedAt(index: unknown): number {
  const i = Math.round(Number(index));
  if (!Number.isFinite(i)) return DEFAULT_SPEED;
  return SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, i))];
}

/** The rate the <audio> element plays at: 1 while following someone, else the saved speed. */
export function playbackRateFor({ speed, following }: { speed: number; following: boolean }): number {
  return following ? 1 : normalizeSpeed(speed);
}

/**
 * The leader's rate as a follower reads it from listen:sync. Older servers and
 * clients send none: that is 1. Anything odd is 1 too.
 */
export function leaderRate(value: unknown): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

/** Does a follower keep its position on the leader's? Only while the leader plays at 1×. */
export function followsPosition(rate: number): boolean {
  return Math.abs(leaderRate(rate) - 1) < 0.001;
}

/** Where the leader is now: their reported position, moved on at their rate while playing. */
export function leaderPosition({ position, elapsedS, playing, rate }: { position: number; elapsedS: number; playing: boolean; rate?: number }): number {
  const base = Number.isFinite(position) && position > 0 ? position : 0;
  const elapsed = playing && Number.isFinite(elapsedS) && elapsedS > 0 ? elapsedS : 0;
  return base + elapsed * leaderRate(rate);
}

/** A leader's report as speed rules read it (listen:sync). */
export interface LeaderReport {
  position: number;
  updatedAt: number;
  playing: boolean;
  rate?: number;
}

/**
 * Did the leader jump (seek) between two reports of the same song? The new
 * position is compared with where the earlier report says they would be by
 * then. Used while the leader is not at 1×, when drift is not corrected but a
 * seek of theirs is still followed.
 */
export function leaderJumped(prev: LeaderReport | null | undefined, next: LeaderReport, toleranceS = 3): boolean {
  if (!prev) return false;
  const predicted = leaderPosition({ position: prev.position, elapsedS: (next.updatedAt - prev.updatedAt) / 1000, playing: prev.playing, rate: prev.rate });
  return Math.abs((Number(next.position) || 0) - predicted) > toleranceS;
}

/** "1.25×" (Turkish "1,25×"). */
export function formatSpeed(speed: number, locale = 'en'): string {
  let text: string;
  try {
    text = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(normalizeSpeed(speed));
  } catch {
    text = String(normalizeSpeed(speed));
  }
  return `${text}×`;
}
