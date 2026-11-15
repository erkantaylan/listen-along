// Playback speed on the <audio> element, pitch preserved. The rate is the
// saved speed, or 1× while listening along with someone (speed-rules.ts:
// the follower's position is the leader's). Setting defaultPlaybackRate too
// keeps the rate across loads (a new src resets playbackRate to it).
import { elements } from '../shared/state.ts';
import { soundSettings, onSoundChange } from './sound.ts';
import { playbackRateFor } from './speed-rules.ts';
import { listenState, onListenChange } from '../features/social/listen-along.ts';

type PitchAudio = HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

/** The rate playback runs at now. */
export function currentRate(): number {
  return playbackRateFor({ speed: soundSettings().speed, following: !!listenState().leader });
}

function apply(): void {
  const a = elements.audioPlayer as PitchAudio;
  const rate = currentRate();
  a.preservesPitch = true;
  a.webkitPreservesPitch = true;
  a.mozPreservesPitch = true;
  if (a.defaultPlaybackRate !== rate) a.defaultPlaybackRate = rate;
  if (a.playbackRate !== rate) a.playbackRate = rate;
}

/** Call once at start-up. */
export function setupSpeed(): void {
  apply();
  onSoundChange(apply);
  onListenChange(apply);
  // A load resets playbackRate to defaultPlaybackRate; make sure both are ours.
  elements.audioPlayer.addEventListener('loadedmetadata', apply);
}
