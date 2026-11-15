// The sleep timer (sound panel): stop playback after a number of minutes, or
// at the end of the current song. Rules in sleep-timer-rules.ts.
//
// - Timed: the countdown runs in this page (it survives moving around the app;
//   a reload cancels it, nothing is stored). In the last FADE_MS the element's
//   volume goes down (the listener's own volume times the fade, so moving the
//   slider meanwhile still counts), then playback pauses and the volume is put
//   back. Due while nothing plays: it just ends.
// - End of song: the song's end (player.setEndHook) pauses instead of moving on.
//   Listening along, the leader's next song may arrive first; a song change
//   within the last seconds of the song counts as its end (endedByChange).
// - The pause is player.pause(), exactly the listener pausing: listening along
//   with someone ends (any own playback action does), and whoever listens along
//   with this listener pauses with them.
// - Pausing during the fade puts the volume back at once; the timer still runs
//   out (and then finds nothing to pause). Only Cancel (or another choice)
//   ends a timer early.
import { elements, state } from '../shared/state.ts';
import { showToast, t } from '../shared/ui.ts';
import { player } from './player.ts';
import { SLEEP_OFF, sleepAfter, sleepPhase, fadeFactor, endedByChange } from './sleep-timer-rules.ts';
import type { SleepTimer } from './sleep-timer-rules.ts';

const TICK_MS = 250;

let timer: SleepTimer = SLEEP_OFF;
let tick: ReturnType<typeof setInterval> | null = null;
let fading = false;
let lastTime = 0;
let lastDuration = 0;
const subscribers = new Set<() => void>();

function changed(): void {
  for (const fn of subscribers) { try { fn(); } catch (err) { console.error('sleep timer subscriber failed:', err); } }
}

export function sleepTimer(): SleepTimer { return timer; }
export function onSleepChange(fn: () => void): () => boolean { subscribers.add(fn); return () => subscribers.delete(fn); }

function restoreVolume(): void {
  if (!fading) return;
  fading = false;
  elements.audioPlayer.volume = state.volume;
}

function stopTick(): void {
  if (tick) clearInterval(tick);
  tick = null;
}

function set(next: SleepTimer): void {
  timer = next;
  stopTick();
  restoreVolume();
  if (timer.kind === 'at') tick = setInterval(onTick, TICK_MS);
  changed();
}

/** Stop after `minutes` from now (replaces any timer). */
export function sleepIn(minutes: number): void { set(sleepAfter(minutes, Date.now())); }
/** Stop when the current song ends. */
export function sleepAtEndOfSong(): void { set({ kind: 'end-of-song' }); }
export function cancelSleep(): void { set(SLEEP_OFF); }

function goToSleep({ songEnded = false }: { songEnded?: boolean } = {}): void {
  const wasPlaying = player.isPlaying || songEnded;
  timer = SLEEP_OFF;
  stopTick();
  if (wasPlaying) player.pause();
  // Back to the listener's volume once the pause has silenced the element.
  setTimeout(restoreVolume, 150);
  if (wasPlaying) showToast(t('sound.sleepDone', 'Sleep timer: playback paused'), 'info');
  changed();
}

let lastSecond = -1;
function onTick(): void {
  const now = Date.now();
  const phase = sleepPhase(timer, now);
  if (phase === 'due') { goToSleep(); return; }
  if (phase === 'fading' && player.isPlaying) {
    fading = true;
    elements.audioPlayer.volume = Math.max(0, Math.min(1, state.volume * fadeFactor(timer, now)));
  } else if (fading && !player.isPlaying) {
    restoreVolume();
  }
  // The countdown text changes once a second.
  const second = Math.floor(now / 1000);
  if (second !== lastSecond) { lastSecond = second; changed(); }
}

/** Call once at start-up, after the player is wired. */
export function setupSleepTimer(): void {
  player.setEndHook(() => {
    if (timer.kind !== 'end-of-song') return false;
    // Nothing moves on; pause() as the listener would (it ends listening along).
    goToSleep({ songEnded: true });
    return true;
  });
  player.on('time', ({ currentTime, duration }) => { lastTime = currentTime; lastDuration = duration; });
  player.on('track', (track) => {
    // Listening along: the leader's next song came before this one's 'ended'.
    if (track && timer.kind === 'end-of-song' && player.driver && endedByChange(lastTime, lastDuration)) goToSleep();
    lastTime = 0;
    lastDuration = 0;
  });
}
