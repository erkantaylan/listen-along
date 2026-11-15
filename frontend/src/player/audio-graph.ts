// The equalizer and the volume boost: the player's <audio> through the Web
// Audio API (rules and the graph's shape: equalizer-rules.ts).
//
// Design: connect lazily, and only to a running context. Playback must never go
// silent, and the neutral state (equalizer off or flat, no boost) must be
// exactly today's player, so:
// - Nothing of Web Audio exists until an effect is wanted. Listeners who never
//   turn one on (and every page load until they do) play the plain element.
// - createMediaElementSource can be called once per element and reroutes it
//   for good, and an AudioContext starts suspended until a user gesture. The
//   source is created only once the context is RUNNING, so the reroute never
//   lands in a silent context. The context is created and resumed inside a
//   user gesture: the panel's own controls, or (effects saved from an earlier
//   visit) the first pointer / key press on the page. Until it runs, the
//   element keeps playing as it is; effects simply wait.
// - Once rerouted, the neutral state connects the source straight to the
//   output (no filters, no gain, no limiter: bit for bit the element's audio,
//   resampled as the browser does anyway). A context the browser suspends is
//   resumed on the next play, on the tab becoming visible and on a gesture.
// - Volume and mute stay on the element (one place): Chromium and Firefox
//   apply them before the source node, so volume × boost compose in that
//   order and mute is silence whatever the boost.
// - The limiter (DynamicsCompressor as a brick wall at -2 dBFS) is only in
//   the path with an effect. Chromium adds a fixed make-up gain (about +1 dB with
//   these settings) even below the threshold; a trim after it, measured once
//   with an OfflineAudioContext, takes that back out, so below the threshold
//   the chain is exactly the EQ and the boost.
// - Phones and tablets (isMobileBrowser): Web Audio output can stop when the
//   screen locks or the browser is in the background (iOS Safari above all).
//   There effects stay off until the listener opts in with the panel's
//   switch, so lock-screen playback is untouched for everyone else.
// - Same origin only: Web Audio outputs silence for cross-origin media without
//   CORS. Every source the element plays is this server's (/api/stream,
//   /api/library/:id/file); the failure probe's blob: copy plays in its own
//   muted element, never through this graph.
import { elements } from '../shared/state.ts';
import { soundSettings, onSoundChange } from './sound.ts';
import { EQ_BANDS, EQ_Q, LIMITER, bandType, graphPlan, isMobileBrowser } from './equalizer-rules.ts';
import type { GraphPlan } from './equalizer-rules.ts';

type Ctx = BaseAudioContext;

/** The effect chain's nodes, built in any context (the live one, or an OfflineAudioContext to measure it). */
export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  filters: BiquadFilterNode[];
  boost: GainNode;
  limiter: DynamicsCompressorNode;
  trim: GainNode;
}

/** Build the chain: bands -> boost -> limiter -> trim. */
export function buildEffectChain(ctx: Ctx): EffectChain {
  const filters = EQ_BANDS.map((hz, i) => {
    const f = ctx.createBiquadFilter();
    f.type = bandType(i);
    f.frequency.value = hz;
    if (f.type === 'peaking') f.Q.value = EQ_Q;
    f.gain.value = 0;
    return f;
  });
  for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i]);
  const boost = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  const trim = ctx.createGain();
  boost.connect(limiter);
  limiter.connect(trim);
  return { input: filters[0], output: trim, filters, boost, limiter, trim };
}

/**
 * Point the chain at a plan: the input is where the source connects (the
 * first band, or the boost when there are no bands). Returns that node, or
 * null for 'direct'.
 */
export function applyPlan(chain: EffectChain, plan: GraphPlan, trimGain: number): AudioNode | null {
  if (plan.route === 'direct') return null;
  const last = chain.filters[chain.filters.length - 1];
  try { last.disconnect(); } catch { /* not connected */ }
  chain.filters.forEach((f, i) => { f.gain.value = plan.gains ? plan.gains[i] : 0; });
  chain.boost.gain.value = plan.gain;
  chain.trim.gain.value = trimGain;
  if (plan.gains) { last.connect(chain.boost); return chain.filters[0]; }
  return chain.boost;
}

/**
 * The limiter's gain below its threshold in this browser (1 = none), from a
 * short offline render of a quiet tone. Its inverse is the trim.
 */
export async function measureLimiterMakeup(): Promise<number> {
  try {
    const rate = 48000;
    const oc = new OfflineAudioContext(1, rate / 2, rate);
    const osc = oc.createOscillator();
    osc.frequency.value = 1000;
    const level = oc.createGain();
    level.gain.value = 0.25; // -12 dBFS: well under the threshold
    const chain = buildEffectChain(oc);
    applyPlan(chain, { route: 'effects', gains: null, gain: 1 }, 1);
    osc.connect(level);
    level.connect(chain.boost);
    chain.output.connect(oc.destination);
    osc.start();
    const out = (await oc.startRendering()).getChannelData(0).subarray(rate / 4);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    const makeup = peak / 0.25;
    return Number.isFinite(makeup) && makeup > 0.5 && makeup < 2 ? makeup : 1;
  } catch {
    return 1;
  }
}

// ------------------------------------------------------------- live graph

let ctx: AudioContext | null = null;
let source: MediaElementAudioSourceNode | null = null;
let chain: EffectChain | null = null;
let trimGain = 1;
let connecting = false;
let route: 'none' | 'direct' | 'effects' = 'none';
const subscribers = new Set<() => void>();

const mobile = (): boolean => isMobileBrowser({
  coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints || 0,
  platform: navigator.platform || '',
});

export function isMobileDevice(): boolean { return mobile(); }

const supported = (): boolean => typeof window !== 'undefined' && typeof window.AudioContext === 'function';

/** Effects may run here: Web Audio exists, and on a phone the listener opted in. */
export function effectsAllowed(): boolean {
  return supported() && (!mobile() || soundSettings().effectsOnMobile);
}

/** The settings ask for an effect (whether or not it can run yet). */
function wanted(): boolean {
  return graphPlan(soundSettings()).route === 'effects';
}

/**
 * What the panel shows: 'off' (no effect asked for), 'blocked' (a phone, not
 * opted in), 'unsupported', 'waiting' (asked for, the context is not running
 * yet: a tap or key press starts it), 'on'.
 */
export function effectsStatus(): 'off' | 'blocked' | 'unsupported' | 'waiting' | 'on' {
  if (!wanted()) return 'off';
  if (!supported()) return 'unsupported';
  if (!effectsAllowed()) return 'blocked';
  return route === 'effects' && ctx && ctx.state === 'running' ? 'on' : 'waiting';
}

export function onGraphChange(fn: () => void): () => boolean { subscribers.add(fn); return () => subscribers.delete(fn); }
function changed(): void {
  for (const fn of subscribers) { try { fn(); } catch (err) { console.error('audio graph subscriber failed:', err); } }
}

/** For checks (and the tests' Playwright scripts): the live nodes, if any. */
export function audioGraphNodes(): { ctx: AudioContext | null; source: MediaElementAudioSourceNode | null; chain: EffectChain | null; route: string } {
  return { ctx, source, chain, route };
}

function connect(): void {
  if (!ctx || !source || !chain) return;
  const plan = effectsAllowed() ? graphPlan(soundSettings()) : { route: 'direct' as const };
  try { source.disconnect(); } catch { /* first time */ }
  try { chain.output.disconnect(); } catch { /* first time */ }
  const input = applyPlan(chain, plan, trimGain);
  if (input) {
    source.connect(input);
    chain.output.connect(ctx.destination);
    route = 'effects';
  } else {
    source.connect(ctx.destination);
    route = 'direct';
  }
  changed();
}

function resume(): void {
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
}

/**
 * Called from user gestures (the panel's controls, the first pointer or key
 * press): create / resume the context, and reroute the element once it runs.
 */
export function primeAudioGraph(): void {
  if (source) { resume(); return; }
  if (!wanted() || !effectsAllowed() || connecting) return;
  try {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'playback' });
      ctx.addEventListener('statechange', () => {
        // Suspended by the browser while music should play: ask again.
        if (ctx && ctx.state !== 'running' && !elements.audioPlayer.paused) resume();
        changed();
      });
    }
  } catch (err) {
    console.warn('Audio effects unavailable:', err);
    return;
  }
  connecting = true;
  const c = ctx;
  // resume() inside the gesture; route only once it runs.
  Promise.all([c.resume(), measureLimiterMakeup()]).then(([, makeup]) => {
    connecting = false;
    if (c.state !== 'running' || source || !wanted() || !effectsAllowed()) { changed(); return; }
    trimGain = 1 / makeup;
    source = c.createMediaElementSource(elements.audioPlayer);
    chain = buildEffectChain(c);
    connect();
  }).catch((err) => {
    connecting = false;
    console.warn('Audio effects could not start:', err);
    changed();
  });
  changed();
}

/** Call once at start-up. */
export function setupAudioGraph(): void {
  onSoundChange(() => {
    if (source) connect();
    else changed();
  });
  // Effects saved from an earlier visit start with the first gesture on the page.
  const gesture = () => { if (wanted() && effectsAllowed() && (!source || (ctx && ctx.state !== 'running'))) primeAudioGraph(); };
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);
  const audio = elements.audioPlayer;
  audio.addEventListener('play', resume);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
}
