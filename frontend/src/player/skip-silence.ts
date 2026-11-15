// Skip silence (sound panel, on by default): start songs after their silent
// lead-in and end them where their silent tail begins. The numbers are the
// server's (GET /api/stream/silence?q=<the track's url>, asked when a song
// starts and kept for this page load); the decisions are skip-silence-rules.ts.
//
// - A known lead-in: the song starts at the music (player.setStartAt). Not
//   known yet: it starts at 0 and jumps once the answer is here, unless the
//   listener has moved meanwhile (it is silence they would be skipping anyway).
// - The tail: playing into it ends the song through player.finishTrack, the
//   same path as the 'ended' event, so repeat, the search page's loop, Radio's
//   next round and the sleep timer's "end of song" behave as at a natural end.
// - Listening along (a driver): nothing is trimmed; positions are the leader's.
import { elements } from '../shared/state.ts';
import { player } from './player.ts';
import { soundSettings } from './sound.ts';
import { readSilence, startAt, jumpToMusic, crossedTail } from './skip-silence-rules.ts';
import type { Silence } from './skip-silence-rules.ts';
import type { Track } from '../shared/types.ts';

// track url -> silence; unmeasured answers are asked again after a while.
const cache = new Map<string, { silence: Silence; at: number }>();
const UNMEASURED_TTL_MS = 5 * 60_000;
const inflight = new Map<string, Promise<Silence | null>>();

let current: { track: Track; silence: Silence | null; seeked: boolean; ended: boolean } | null = null;
let prevTime: number | null = null;
let ownSeek = false;
// playTrack itself sets the position of a song it starts: that seek is not the listener's.
let startedAt = 0;

const enabled = (): boolean => soundSettings().skipSilence;
const following = (): boolean => !!player.driver;

function cached(t: Track): Silence | null {
  const hit = cache.get(t.url);
  if (!hit) return null;
  const unmeasured = hit.silence.leadMs === null && hit.silence.trailMs === null;
  if (unmeasured && Date.now() - hit.at > UNMEASURED_TTL_MS) { cache.delete(t.url); return null; }
  return hit.silence;
}

function lookup(t: Track): Promise<Silence | null> {
  const known = cached(t);
  if (known) return Promise.resolve(known);
  const running = inflight.get(t.url);
  if (running) return running;
  const p = fetch(`/api/stream/silence?q=${encodeURIComponent(t.url)}`, { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return null; // not in the library, signed out, a server problem: play it whole
      const silence = readSilence(await res.json());
      if (cache.size > 2000) cache.clear();
      cache.set(t.url, { silence, at: Date.now() });
      return silence;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(t.url); });
  inflight.set(t.url, p);
  return p;
}

/** library:updated { replaced }: a song's file changed, so did its silence. */
export function forgetSilence(): void {
  cache.clear();
}

/** Call once at start-up, after the player is wired. */
export function setupSkipSilence(): void {
  player.setStartAt((track, position) => startAt({ enabled: enabled(), following: following(), silence: cached(track), position }));

  player.on('start', ({ track }) => {
    current = { track, silence: cached(track), seeked: false, ended: false };
    prevTime = null;
    startedAt = performance.now();
    if (!enabled() || following() || current.silence) return;
    const mine = current;
    lookup(track).then((silence) => {
      if (current !== mine || !silence) return;
      mine.silence = silence;
      // A position can be set only once the element knows the length.
      const jump = () => {
        if (current !== mine) return;
        const to = jumpToMusic({ enabled: enabled(), following: following(), silence, currentTime: player.currentTime, seekedByListener: mine.seeked });
        if (to !== null) { ownSeek = true; player.seek(to, { keepDriver: true }); }
      };
      if (player.duration) jump();
      else elements.audioPlayer.addEventListener('loadedmetadata', jump, { once: true });
    });
  });

  // A seek (the listener's, or the jump above) is not playback: no crossing counts across it.
  elements.audioPlayer.addEventListener('seeking', () => {
    if (current && !ownSeek && performance.now() - startedAt > 500) current.seeked = true;
    ownSeek = false;
    prevTime = null;
  });

  player.on('time', ({ currentTime, duration }) => {
    const c = current;
    if (!c || c.ended || !player.track || player.track.url !== c.track.url) { prevTime = currentTime; return; }
    if (player.isPlaying && crossedTail({ enabled: enabled(), following: following(), silence: c.silence, duration, prev: prevTime, cur: currentTime })) {
      c.ended = true;
      prevTime = null;
      player.finishTrack();
      return;
    }
    prevTime = currentTime;
  });
}
