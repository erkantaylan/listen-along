// Equalizer and volume boost: bands, presets, limits and the shape of the
// audio graph (audio-graph.ts builds it). Pure (no DOM, no Web Audio), tested
// in equalizer-rules.test.ts.
//
// Ten bands at the ISO octave centres; the lowest is a low shelf and the
// highest a high shelf, the rest peaking filters one octave wide (Q 1.41).
// Gains are -12..+12 dB in half-dB steps. Presets are moderate, published-style
// curves (no band over +6 dB), defined here as data.
//
// Volume boost is a gain of 1 + boost% (up to +100% = 2×, +6 dB). Anything
// that can push the signal over full scale (a boost, a band above 0 dB) goes
// through a limiter (a DynamicsCompressor set as a brick wall at -2 dBFS).
// The neutral state (equalizer off or flat, no boost) is no graph at all:
// audio plays exactly as it does without effects (graphPlan 'direct').

export const EQ_BANDS: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_STEP_DB = 0.5;
export const EQ_Q = 1.41;

export type BandType = 'lowshelf' | 'peaking' | 'highshelf';
export function bandType(index: number): BandType {
  if (index === 0) return 'lowshelf';
  if (index === EQ_BANDS.length - 1) return 'highshelf';
  return 'peaking';
}

export const EQ_PRESET_IDS = ['flat', 'bass', 'treble', 'vocal', 'rock', 'electronic', 'acoustic', 'laptop'] as const;
export type EqPresetId = typeof EQ_PRESET_IDS[number];
export type EqChoice = EqPresetId | 'custom';

//                                    31   62  125  250  500   1k   2k   4k   8k  16k
export const EQ_PRESETS: Readonly<Record<EqPresetId, readonly number[]>> = Object.freeze({
  flat:       [0,   0,   0,   0,   0,   0,   0,   0,   0,   0],
  bass:       [6,   5,   4, 2.5,   1,   0,   0,   0,   0,   0],
  treble:     [0,   0,   0,   0,   0,   1, 2.5,   4,   5,   6],
  vocal:      [-4, -3, -1.5,  0,   2, 3.5,   4,   3,   1,   0],
  rock:       [5,   4, 2.5,   0, -1.5, -1,   1,   3,   4, 4.5],
  electronic: [5.5, 4.5, 2,   0, -1.5,  1,   0, 1.5,   4,   5],
  acoustic:   [3, 2.5, 1.5,   1,   0,   0,   0, 1.5, 2.5,   3],
  laptop:     [-6, -3,   3,   4,   2,   0,   1, 2.5,   2,   0],
});

export const FLAT_GAINS: readonly number[] = EQ_PRESETS.flat;

export function isPresetId(v: unknown): v is EqPresetId {
  return typeof v === 'string' && (EQ_PRESET_IDS as readonly string[]).includes(v);
}

export function isEqChoice(v: unknown): v is EqChoice {
  return v === 'custom' || isPresetId(v);
}

function clampDb(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const stepped = Math.round(n / EQ_STEP_DB) * EQ_STEP_DB;
  return Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, stepped)) || 0; // no -0
}

/** Anything -> ten gains in range and on the half-dB grid (missing bands are 0). */
export function normalizeGains(v: unknown): number[] {
  const list = Array.isArray(v) ? v : [];
  return EQ_BANDS.map((_, i) => clampDb(list[i]));
}

/** The curve in use: a preset's, or the listener's own. */
export function gainsFor(choice: EqChoice, custom: readonly number[]): number[] {
  return choice === 'custom' ? normalizeGains(custom) : [...EQ_PRESETS[choice]];
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((g) => g === 0);
}

/** One band dragged: the curve becomes the listener's own ('custom'), starting from what was in use. */
export function withBand(choice: EqChoice, custom: readonly number[], index: number, db: number): { eqPreset: EqChoice; eqCustom: number[] } {
  const gains = gainsFor(choice, custom);
  if (index >= 0 && index < gains.length) gains[index] = clampDb(db);
  return { eqPreset: 'custom', eqCustom: gains };
}

export const BOOST_MAX = 100;
export const BOOST_STEP = 5;

/** Boost in percent: 0..100 in steps of 5; anything else 0. */
export function normalizeBoost(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(BOOST_MAX, Math.round(n / BOOST_STEP) * BOOST_STEP);
}

/** The boost's linear gain: +100% is 2× (+6 dB). */
export function boostGain(boost: number): number {
  return 1 + normalizeBoost(boost) / 100;
}

/** The limiter: a brick wall at -2 dBFS (attack 1 ms; the browser looks ahead a few ms), so even a +12 dB overshoot peaks under 0 dBFS. */
export const LIMITER = Object.freeze({ threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });

export interface EffectSettings {
  eqOn: boolean;
  eqPreset: EqChoice;
  eqCustom: readonly number[];
  boost: number;
}

/**
 * The graph for these settings. 'direct': no effect, the element's own output
 * (a graph that already exists connects its source straight to the output,
 * no nodes in between). 'effects': EQ bands (null when the EQ is off or flat),
 * then the boost gain, then the limiter.
 */
export type GraphPlan =
  | { route: 'direct' }
  | { route: 'effects'; gains: number[] | null; gain: number };

export function graphPlan(s: EffectSettings): GraphPlan {
  const gains = s.eqOn ? gainsFor(s.eqPreset, s.eqCustom) : null;
  const eq = gains && !isFlat(gains) ? gains : null;
  const gain = boostGain(s.boost);
  if (!eq && gain === 1) return { route: 'direct' };
  return { route: 'effects', gains: eq, gain };
}

export function isNeutral(s: EffectSettings): boolean {
  return graphPlan(s).route === 'direct';
}

/**
 * A phone or tablet browser (coarse pointer, or a mobile user agent). There,
 * audio routed through Web Audio can stop or stutter when the screen locks or
 * the browser goes to the background (iOS Safari above all), so effects need
 * the listener's opt-in.
 */
export function isMobileBrowser({ coarsePointer, userAgent, maxTouchPoints = 0, platform = '' }: { coarsePointer: boolean; userAgent: string; maxTouchPoints?: number; platform?: string }): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(userAgent || '')) return true;
  if (platform === 'MacIntel' && maxTouchPoints > 1) return true; // iPadOS reports a Mac
  return !!coarsePointer;
}

/** "+3 dB", "−2.5 dB", "0 dB" (a real minus sign). */
export function formatDb(db: number, locale = 'en'): string {
  const n = clampDb(db);
  let text: string;
  try { text = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(n)); } catch { text = String(Math.abs(n)); }
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${text} dB`;
}

/** "31", "125", "1k", "16k" */
export function formatBand(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}
