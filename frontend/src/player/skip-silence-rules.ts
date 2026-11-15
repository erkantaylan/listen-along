// Skip silence: where a song starts and where it counts as ended, from the
// server's measurements (GET /api/stream/silence: lead_silence_ms /
// trail_silence_ms, backend/src/core/library/silence.ts). Pure (no DOM), tested
// in skip-silence-rules.test.ts; skip-silence.ts applies it.
//
// - Start: a song started from its beginning starts at the end of its lead-in
//   (a quarter second before the music, so nothing of it is clipped).
// - End: playback that runs into the tail (half a second after the music
//   stops) ends the song exactly as the 'ended' event would (player.finishTrack:
//   repeat, the search page's one-song loop, Radio's next round, the sleep
//   timer's "end of song" all apply). Only a crossing made by playing counts:
//   a seek into the tail, or anywhere in the lead-in, is the listener's choice
//   and plays as it is.
// - Never while listening along: the follower's position is the leader's
//   (whose own setting decides), so there is nothing to trim and no loop.
// - Unmeasured songs (null), and songs that would keep less than MIN_KEEP_S,
//   play whole.

export const LEAD_MARGIN_S = 0.25;
export const TAIL_MARGIN_S = 0.5;
/** Shorter silences are not trimmed (the server's own minimum is 1 s). */
export const MIN_TRIM_S = 1;
/** Never trim a file down to less than this (a file of almost nothing but silence plays whole). */
export const MIN_KEEP_S = 5;
/** timeupdate fires about every 250 ms; at 2× that is 0.5 s of media. A larger step is a seek. */
export const MAX_PLAY_STEP_S = 1.5;

export interface Silence {
  leadMs: number | null;
  trailMs: number | null;
}

/** GET /api/stream/silence's answer -> Silence (anything odd = not measured). */
export function readSilence(body: unknown): Silence {
  const o = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return { leadMs: ms(o.lead_silence_ms), trailMs: ms(o.trail_silence_ms) };
}

/**
 * Where the music is: { start, end } in seconds, end null when the length is
 * not known yet. null = nothing to trim.
 */
export function trimPoints(silence: Silence | null | undefined, duration: number): { start: number; end: number | null } | null {
  if (!silence) return null;
  const lead = silence.leadMs !== null && silence.leadMs / 1000 >= MIN_TRIM_S ? silence.leadMs / 1000 : 0;
  const trail = silence.trailMs !== null && silence.trailMs / 1000 >= MIN_TRIM_S ? silence.trailMs / 1000 : 0;
  if (!lead && !trail) return null;
  const known = Number.isFinite(duration) && duration > 0;
  const start = lead ? Math.max(0, lead - LEAD_MARGIN_S) : 0;
  const end = known && trail ? Math.min(duration, duration - trail + TAIL_MARGIN_S) : null;
  if (known && (end ?? duration) - start < MIN_KEEP_S) return null;
  if (!start && end === null) return null;
  return { start, end };
}

/** Where a song that is started at `position` begins. */
export function startAt({ enabled, following, silence, position }: { enabled: boolean; following: boolean; silence: Silence | null | undefined; position: number }): number {
  if (!enabled || following || position > 0.05) return position;
  const t = trimPoints(silence, NaN);
  return t ? t.start : position;
}

/**
 * The measurement arrived after the song began: jump to the music if the
 * listener has not moved and is still in the lead-in.
 */
export function jumpToMusic({ enabled, following, silence, currentTime, seekedByListener }: { enabled: boolean; following: boolean; silence: Silence | null | undefined; currentTime: number; seekedByListener: boolean }): number | null {
  if (!enabled || following || seekedByListener) return null;
  const t = trimPoints(silence, NaN);
  return t && t.start > 0 && currentTime < t.start - 0.1 ? t.start : null;
}

/** Playback ran from `prev` to `cur` across the start of the tail: the song is over. */
export function crossedTail({ enabled, following, silence, duration, prev, cur }: { enabled: boolean; following: boolean; silence: Silence | null | undefined; duration: number; prev: number | null; cur: number }): boolean {
  if (!enabled || following || prev === null) return false;
  const t = trimPoints(silence, duration);
  if (!t || t.end === null || t.end >= duration) return false;
  return prev < t.end && cur >= t.end && cur - prev <= MAX_PLAY_STEP_S;
}
