// Listen along with another user, Spotify-style (server: backend/src/listenAlong.js).
//
// Follower: "Listen along" on someone in the people panel. The server answers
// with whom we actually hear (the root of their chain: if they are listening
// along with someone, we attach to that person) and then sends `listen:sync`
// whenever the leader's now-playing changes: song, playing/paused, position
// and the server time of that report. This module drives player.ts (as its
// driver, so the listener's own play/pause, seek, next/previous or picking a
// song ends listening along) and corrects drift: it seeks only when more
// than DRIFT_S seconds off. A song that cannot be loaded here shows a notice
// and we wait for the leader's next song.
//
// Leader: `listen:followers` says who is listening along ("Ayşe and 2 others
// are listening along", player bar); while someone is, playback is
// re-reported every few seconds so their position anchor stays fresh.
//
// The follow lives in this socket (the tab that plays). After a reconnect it
// is requested again; if that fails, listening along ends.
import { player } from '../../player/player.ts';
import { showToast, t } from '../../shared/ui.ts';
import { state } from '../../shared/state.ts';
import { maybeById } from '../../shared/dom.ts';
import type {
  ListenEndPayload, ListenFollowAck, ListenFollowersPayload, ListenFollowingPayload, ListenPerson,
  ListenSyncPayload, PresenceEntry, Track,
} from '../../shared/types.ts';

const DRIFT_S = 2;
const CHECK_MS = 2000;
const HEARTBEAT_MS = 10000;

// The song of a listen:sync (what the leader plays).
type SyncTrack = NonNullable<ListenSyncPayload['track']>;
// Someone in the people panel (social.ts): only id and name are read here.
export type ListenTarget = Pick<PresenceEntry, 'id' | 'name'>;

/** listenState(): what the player bar and the people panel show. */
export interface ListenState {
  leader: ListenPerson | null;
  chosen: string | null;
  ending: boolean;
  followers: ListenFollowersPayload;
}

const L: {
  sock: AppSocket | null;
  leader: ListenPerson | null;
  chosen: string | null;
  sync: ListenSyncPayload | null;
  offset: number;
  ending: boolean;
  missing: string | null;
  followers: ListenFollowersPayload;
  report: (() => void) | null;
} = {
  sock: null,
  leader: null,     // { id, name } we hear
  chosen: null,     // userId we picked (may be listening along with `leader`)
  sync: null,       // last listen:sync
  offset: 0,        // server clock - local clock (ms)
  ending: false,    // leader went offline: stop after this song
  missing: null,    // title of a song we could not load (notice shown once)
  followers: { count: 0, names: [] },
  report: null,     // () => void, re-report now-playing (social.ts)
};
const subscribers = new Set<() => void>();
let checkTimer: ReturnType<typeof setInterval> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

function changed(): void {
  for (const fn of subscribers) { try { fn(); } catch (err) { console.error('listen-along subscriber failed:', err); } }
}

export function onListenChange(fn: () => void): () => boolean { subscribers.add(fn); return () => subscribers.delete(fn); }

export function listenState(): ListenState {
  return { leader: L.leader, chosen: L.chosen, ending: L.ending, followers: L.followers };
}

export function isListeningWith(person: ListenTarget | null | undefined): boolean {
  return !!L.leader && !!person && (L.leader.id === person.id || L.chosen === person.id);
}

// "Ayşe is listening along" / "Ayşe and Bob are…" / "Ayşe and 2 others are…"
export function followersText({ count, names }: ListenFollowersPayload): string {
  if (!count) return '';
  const first = names[0] || t('listen.someone', 'Someone');
  if (count === 1) return tf('listen.oneFollower', '{name} is listening along', { name: first });
  if (count === 2 && names[1]) return tf('listen.twoFollowers', '{name} and {other} are listening along', { name: first, other: names[1] });
  return tf('listen.manyFollowers', '{name} and {count} others are listening along', { name: first, count: count - 1 });
}

// Only listen:follow is asked (with an ack); null on no socket or a 10s timeout.
function ask(event: 'listen:follow', arg: { userId: string }): Promise<ListenFollowAck | null> {
  return new Promise((resolve) => {
    if (!L.sock) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 10000);
    L.sock.emit(event, arg, (res) => { clearTimeout(timer); resolve(res); });
  });
}

// ------------------------------------------------------------ follower

function targetPosition(s: ListenSyncPayload | null = L.sync): number {
  if (!s) return 0;
  const elapsed = s.playing ? (Date.now() + L.offset - s.updatedAt) / 1000 : 0;
  return Math.max(0, (s.position || 0) + elapsed);
}

// Called only for a song with a src, which the server sets only with a libraryId.
function trackFrom(st: SyncTrack): Track {
  return {
    libraryId: st.libraryId as string,
    url: `library:${st.libraryId}`,
    src: st.src as string,
    title: st.title,
    artist: st.artist || '',
    thumbnail: st.thumbnail || null,
  };
}

const sameSong = (st: SyncTrack | null | undefined): boolean => !!player.track && !!st && player.track.libraryId === st.libraryId && player.track.src === st.src;

// Bring the local player in line with the last sync (play state, then position).
function correct(): void {
  const s = L.sync;
  if (!L.leader || L.ending || !s || !s.track || !s.track.src || !sameSong(s.track)) return;
  const duration = player.duration;
  const target = targetPosition(s);
  // At / past the end: the leader is moving on, their next song is on its way
  // (and playing again would restart this one).
  if (duration && (target >= duration - 0.25 || (s.playing && player.currentTime >= duration - 0.25))) return;
  if (s.playing && !player.isPlaying) player.play({ keepDriver: true });
  else if (!s.playing && player.isPlaying) player.pause({ keepDriver: true });
  if (!duration) return; // not loaded yet; checked again shortly
  if (Math.abs(player.currentTime - target) > DRIFT_S) player.seek(target, { keepDriver: true });
}

function applySync(sync: ListenSyncPayload | null | undefined): void {
  if (!sync || !L.leader || sync.leaderId !== L.leader.id) return;
  L.offset = (sync.serverNow || Date.now()) - Date.now();
  L.sync = sync;
  const st = sync.track;
  if (!st) {
    // The leader stopped playback: pause and wait for them to play again.
    if (player.isPlaying) player.pause({ keepDriver: true });
    changed();
    return;
  }
  if (!st.src) {
    if (L.missing !== st.title) {
      L.missing = st.title;
      showToast(tf('listen.cannotPlay', 'Cannot play “{title}” here. Waiting for the next song.', { title: st.title }), 'error');
    }
    if (player.isPlaying) player.pause({ keepDriver: true });
    changed();
    return;
  }
  L.missing = null;
  if (!sameSong(st)) player.playTrack(trackFrom(st), { position: targetPosition(sync), autoplay: !!sync.playing });
  else correct();
  changed();
}

function clear(): void {
  state.listeningAlong = false;
  L.leader = null;
  L.chosen = null;
  L.sync = null;
  L.ending = false;
  L.missing = null;
  clearInterval(checkTimer ?? undefined);
  checkTimer = null;
  if (player.driver && player.driver.name === 'listen') player.setDriver(null);
}

function finish({ tellServer = true, toast = true, message }: { tellServer?: boolean; toast?: boolean; message?: string } = {}): void {
  if (!L.leader) return;
  clear();
  if (tellServer && L.sock) L.sock.emit('listen:stop', {});
  if (toast) showToast(message || t('listen.stopped', 'Stopped listening along'), 'info');
  changed();
}

function onEnded(): void {
  if (!L.ending) return; // the leader's next song arrives as a sync
  const name = L.leader ? L.leader.name : '';
  finish({ tellServer: false, message: tf('listen.endedOffline', '{name} went offline. Listening along ended.', { name }) });
}

function begin(leader: ListenPerson, chosen: string | null): void {
  state.listeningAlong = true;
  L.leader = leader;
  L.chosen = chosen;
  L.ending = false;
  L.missing = null;
  player.setDriver({ name: 'listen', onTakeover: () => finish(), onEnded });
  player.setContext({ type: 'listen', leaderId: leader.id, name: leader.name }, [], { keepDriver: true });
  clearInterval(checkTimer ?? undefined);
  checkTimer = setInterval(correct, CHECK_MS);
}

/** People panel: start listening along with `person` (or whoever they listen along with). */
export async function listenAlongWith(person: ListenTarget | null | undefined): Promise<void> {
  if (!person || !person.id) return;
  const res = await ask('listen:follow', { userId: person.id });
  if (!res || 'error' in res) {
    showToast((res && res.error) || t('listen.failed', 'Could not listen along'), 'error');
    return;
  }
  // An ok follow always names its leader (the root of the chain).
  const leader = res.leader as ListenPerson;
  begin(leader, res.chosen);
  showToast(leader.id === person.id
    ? tf('listen.started', 'Listening along with {name}', { name: leader.name })
    : tf('listen.startedRoot', 'Listening along with {name} ({via} is listening along with them)', { name: leader.name, via: person.name }), 'info');
  applySync(res.sync);
  changed();
}

/** Player bar / people panel: stop listening along (playback continues locally). */
export function stopListenAlong(): void { finish(); }

function onFollowing({ leader, chosen }: Partial<ListenFollowingPayload> = {}): void {
  if (!L.leader) return;
  if (!leader) { finish({ tellServer: false }); return; }
  const moved = leader.id !== L.leader.id;
  L.leader = leader;
  L.chosen = chosen || L.chosen;
  if (moved) {
    player.setContext({ type: 'listen', leaderId: leader.id, name: leader.name }, [], { keepDriver: true });
    showToast(tf('listen.nowWith', 'Now listening along with {name}', { name: leader.name }), 'info');
  }
  changed();
}

function onEnd({ leader }: Partial<ListenEndPayload> = {}): void {
  if (!L.leader) return;
  const name = (leader && leader.name) || L.leader.name;
  if (!player.isPlaying) {
    finish({ tellServer: false, message: tf('listen.endedOffline', '{name} went offline. Listening along ended.', { name }) });
    return;
  }
  L.ending = true;
  showToast(tf('listen.leaderOffline', '{name} went offline. Playback stops after this song.', { name }), 'info');
  changed();
}

// After a reconnect the server has forgotten this socket's follow.
async function onReconnect(): Promise<void> {
  if (!L.leader) return;
  const res = await ask('listen:follow', { userId: L.chosen || L.leader.id });
  if (!res || 'error' in res) { finish({ tellServer: false, message: t('listen.lost', 'Listening along ended') }); return; }
  L.leader = res.leader;
  L.chosen = res.chosen;
  applySync(res.sync);
}

// --------------------------------------------------------------- leader

function onFollowers(payload: Partial<ListenFollowersPayload> = {}): void {
  L.followers = { count: Number(payload.count) || 0, names: Array.isArray(payload.names) ? payload.names : [] };
  clearInterval(heartbeat ?? undefined);
  heartbeat = null;
  if (L.followers.count > 0 && L.report) {
    heartbeat = setInterval(() => { if (player.isPlaying) (L.report as () => void)(); }, HEARTBEAT_MS);
  }
  changed();
}

/**
 * Call once with the app socket. `report` re-sends this browser's
 * now-playing (social.ts), used as the leader heartbeat.
 */
export function setupListenAlong(sock: AppSocket, { report }: { report?: (() => void) | null } = {}): void {
  L.sock = sock;
  L.report = report || null;
  let connectedBefore = sock.connected;
  sock.on('connect', () => {
    if (connectedBefore) onReconnect();
    connectedBefore = true;
  });
  sock.on('listen:sync', applySync);
  sock.on('listen:following', onFollowing);
  sock.on('listen:end', onEnd);
  sock.on('listen:followers', onFollowers);
  // A song that fails to load while listening along: say so, wait for the next.
  const audio = maybeById<HTMLAudioElement>('audio-player');
  if (audio) {
    audio.addEventListener('loadedmetadata', () => { if (L.leader) correct(); });
    audio.addEventListener('error', () => {
      if (!L.leader || !L.sync || !L.sync.track || !sameSong(L.sync.track)) return;
      const st = L.sync.track;
      if (L.missing !== st.title) {
        L.missing = st.title;
        showToast(tf('listen.cannotPlay', 'Cannot play “{title}” here. Waiting for the next song.', { title: st.title }), 'error');
      }
    });
  }
}
