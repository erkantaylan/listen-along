// The app-wide audio player. It is local to this browser and lives outside the
// views, so it keeps playing while the user moves around the SPA, and only one
// tab of the browser plays at a time (BroadcastChannel, see below).
//
// "Context" is what playback was last started from: a lobby queue
// ({ type: 'lobby', lobbyId, name }), the music library list
// ({ type: 'library' }), Radio ({ type: 'radio', stationId }), an artist's songs
// ({ type: 'artist', key, name }, artist-page.js), one song played from the
// search page ({ type: 'search', query }, search.js: it repeats that song until
// something else is chosen, player-queue.ts contextRepeat), or another user while listening along
// ({ type: 'listen', leaderId, name }, no songs), plus its songs. It stays current while other pages
// (and other lobbies) are shown, and changes only when play is pressed on a
// song somewhere else (playFrom).
//
// Tracks are queue entries ({ id, url, title, artist, thumbnail }) streamed
// from /api/stream?q=<url>, or carry their own `src` (library files).
//
// API (everything the UI and listen-along use):
//   player.playFrom(ctx, songs, index)   start playing a context's songs at index
//   player.setContext(ctx, songs, { keepDriver })  make a queue current without playing
//   player.updateQueue(lobbyId, songs)   live queue update (ignored unless that lobby is the context)
//   player.renameContext(lobbyId, name)
//   player.replaceQueue(ctx, songs)      new order for a context that is no lobby (ignored unless it is current)
//   player.setRefill(fn)                 fn(context, track) -> songs | null: what comes after the last song (Radio)
//   player.setSkip(fn)                   fn(track) -> true for a song next / previous go past (it failed to play, playback-failures.js)
//   player.playIndex(i) / playTrack(track, { position, autoplay })
//   player.play() / pause() / toggle() / next() / previous() / seek(seconds) / stop()
//     (these are the listener's own actions: each one ends a driver; the
//     driver itself passes { keepDriver: true } to play / pause / seek)
//   player.track / context / queue / index / isPlaying / currentTime / duration
//   player.on(event, fn) -> unsubscribe
//     'track'   (track | null)      a different track was loaded
//     'state'   ({ playing })       play / pause
//     'time'    ({ currentTime, duration })
//     'context' (context | null)
//     'queue'   (songs)
//     'seeked'  (currentTime)       any seek finished (also the driver's)
//   player.setDriver({ name, onTakeover, onEnded }) lets something else steer
//     playback (listen-along, listen-along.js) through playTrack and
//     play/pause/seek with { keepDriver: true }. The listener's first own
//     action (play/pause, seek, next/previous, a queue or library pick, a
//     context change, another tab of this browser starting to play) calls
//     onTakeover and drops it. While a driver is set, a track ending calls
//     onEnded instead of moving to the next song.
import { state, elements } from '../shared/state.ts';
import { playAudioWithUnlock } from '../shared/audio.ts';
import { showToast, t as tr } from '../shared/ui.ts';
import { findTrackIndex, nextIndex, previousIndex, contextRepeat, RESTART_THRESHOLD } from './player-queue.ts';
import type { LibrarySong, LibraryUpdatedPayload, Track } from '../shared/types.ts';

// The contexts playback can be started from (normalizeContext makes them).
export type LobbyContext = { type: 'lobby'; lobbyId: string; name: string | null };
export type LibraryContext = { type: 'library'; name: string | null };
export type RadioContext = { type: 'radio'; stationId: string | null; name: string | null };
export type ArtistContext = { type: 'artist'; key: string; name: string | null };
export type SearchContext = { type: 'search'; query: string; name: string | null };
export type ListenContext = { type: 'listen'; leaderId: string; name: string | null };
export type PlayerContext = LobbyContext | LibraryContext | RadioContext | ArtistContext | SearchContext | ListenContext;

// What callers hand in (setContext, playFrom, replaceQueue): a context or
// something like one; a lobby's comes without `type` (playback.js viewedContext).
export interface PlayerContextInput {
  type?: string;
  name?: string | null;
  lobbyId?: string | null;
  stationId?: string | null;
  key?: string | null;
  query?: unknown;
  leaderId?: string | null;
}

// player.on(event, fn): the payload of each event.
export interface PlayerEvents {
  track: Track | null;
  state: { playing: boolean };
  time: { currentTime: number; duration: number };
  context: PlayerContext | null;
  queue: Track[];
  seeked: number;
}
export type PlayerEvent = keyof PlayerEvents;
export type PlayerHandler<E extends PlayerEvent> = (payload: PlayerEvents[E]) => void;
type AnyPlayerHandler = (payload: PlayerEvents[PlayerEvent]) => void;

// player.setDriver: something else steering playback (listen-along).
export interface PlayerDriver {
  name: string;
  onTakeover?: () => void;
  onEnded?: () => void;
}

/** player.setRefill: what comes after the last song (Radio), or nothing. */
export type RefillFn = (context: PlayerContext | null, track: Track | null) => Track[] | null | undefined;
/** player.setSkip: true for a song next / previous go past. */
export type SkipFn = (track: Track) => boolean;

// socket library:updated { details } / { replaced } (types.ts LibraryUpdatedPayload).
type DetailsChange = Extract<LibraryUpdatedPayload, { details: unknown }>['details'];
type ReplacedChange = Extract<LibraryUpdatedPayload, { replaced: unknown }>['replaced'];

const handlers = new Map<PlayerEvent, Set<AnyPlayerHandler>>();
let context: PlayerContext | null = null;
let queue: Track[] = [];
let track: Track | null = null;
let driver: PlayerDriver | null = null;
let refill: RefillFn | null = null;
let skip: SkipFn | null = null;

const audio = () => elements.audioPlayer;

function emit<E extends PlayerEvent>(event: E, payload: PlayerEvents[E]): void {
  for (const fn of handlers.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(`player "${event}" handler failed:`, err); }
  }
}

function takeover() {
  if (!driver) return;
  const d = driver;
  driver = null;
  if (d.onTakeover) d.onTakeover();
}

// c=1: songs can now be replaced under the same url, and /api/stream used to
// be cached as immutable; the extra parameter keeps browsers from reusing
// such old cached copies (the server now answers no-cache + ETag).
export function streamUrl(t: Track): string {
  return t.src || `/api/stream?q=${encodeURIComponent(t.url)}&c=1`;
}

function normalizeContext(ctx: PlayerContextInput | null | undefined): PlayerContext | null {
  if (!ctx) return null;
  if (ctx.type === 'library') return { type: 'library', name: ctx.name || null };
  if (ctx.type === 'radio') return { type: 'radio', stationId: ctx.stationId || null, name: ctx.name || null };
  if (ctx.type === 'artist') return ctx.key ? { type: 'artist', key: ctx.key, name: ctx.name || null } : null;
  if (ctx.type === 'search') return { type: 'search', query: typeof ctx.query === 'string' ? ctx.query : '', name: ctx.name || null };
  if (ctx.type === 'listen') return ctx.leaderId ? { type: 'listen', leaderId: ctx.leaderId, name: ctx.name || null } : null;
  if (!ctx.lobbyId) return null;
  return { type: 'lobby', lobbyId: ctx.lobbyId, name: ctx.name || null };
}

// Past the first line b has a's type (TypeScript does not narrow b from a.type === b.type).
function sameContext(a: PlayerContext | null, b: PlayerContext | null): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'listen') return a.leaderId === (b as typeof a).leaderId;
  if (a.type === 'radio') return a.stationId === (b as typeof a).stationId;
  if (a.type === 'artist') return a.key === (b as typeof a).key;
  if (a.type === 'search') return a.query === (b as typeof a).query;
  return a.type === 'library' || a.lobbyId === (b as typeof a).lobbyId;
}

function isLobbyContext(lobbyId: string): boolean {
  return !!context && context.type === 'lobby' && context.lobbyId === lobbyId;
}

function hasSource(): boolean {
  const a = audio();
  return !!a.getAttribute('src');
}

export const player = {
  on<E extends PlayerEvent>(event: E, fn: PlayerHandler<E>): () => boolean {
    if (!handlers.has(event)) handlers.set(event, new Set());
    (handlers.get(event) as Set<AnyPlayerHandler>).add(fn as AnyPlayerHandler);
    return () => (handlers.get(event) as Set<AnyPlayerHandler>).delete(fn as AnyPlayerHandler);
  },

  get context(): PlayerContext | null { return context; },
  get queue(): Track[] { return queue; },
  get track(): Track | null { return track; },
  get index(): number { return findTrackIndex(queue, track); },
  get isPlaying(): boolean { return hasSource() && !audio().paused; },
  get currentTime(): number { return audio().currentTime || 0; },
  get duration(): number { return audio().duration || 0; },
  get driver(): PlayerDriver | null { return driver; },

  // keepDriver: the driver itself is switching the context (listen-along).
  setContext(ctx: PlayerContextInput | null | undefined, songs: Track[] = [], { keepDriver = false }: { keepDriver?: boolean } = {}): void {
    const next = normalizeContext(ctx);
    if (!next) return;
    const changed = !sameContext(context, next);
    if (changed && !keepDriver) takeover();
    context = next;
    queue = Array.isArray(songs) ? songs.slice() : [];
    emit('context', context);
    emit('queue', queue);
  },

  renameContext(lobbyId: string, name: string | null | undefined): void {
    if (!isLobbyContext(lobbyId)) return;
    context = { ...(context as LobbyContext), name: name || null };
    emit('context', context);
  },

  updateQueue(lobbyId: string, songs: Track[]): void {
    if (!isLobbyContext(lobbyId)) return;
    queue = Array.isArray(songs) ? songs.slice() : [];
    emit('queue', queue);
  },

  replaceQueue(ctx: PlayerContextInput | null | undefined, songs: Track[]): void {
    if (!sameContext(context, normalizeContext(ctx))) return;
    queue = Array.isArray(songs) ? songs.slice() : [];
    emit('queue', queue);
  },

  setRefill(fn: RefillFn | null | undefined): void { refill = fn || null; },

  setSkip(fn: SkipFn | null | undefined): void { skip = fn || null; },

  // Play `index` of a context's songs; switches the context when it is another one.
  playFrom(ctx: PlayerContextInput | null | undefined, songs: Track[], index: number): void {
    takeover();
    if (!sameContext(context, normalizeContext(ctx))) this.setContext(ctx, songs);
    else { queue = songs.slice(); emit('queue', queue); }
    this.playIndex(index, { manual: false });
  },

  playIndex(i: number, { manual = true }: { manual?: boolean } = {}): void {
    if (manual) takeover();
    const t = queue[i];
    if (t) this.playTrack(t);
  },

  // Load any track (it need not be in the queue) at `position`.
  playTrack(t: Track | null | undefined, { position = 0, autoplay = true }: { position?: number; autoplay?: boolean } = {}): void {
    if (!t || !t.url) return;
    const changed = !track || track.id !== t.id || track.url !== t.url;
    track = t;
    state.currentTrack = t;
    playAudioWithUnlock(streamUrl(t), position, autoplay);
    if (changed) emit('track', track);
  },

  play({ keepDriver = false }: { keepDriver?: boolean } = {}): void {
    if (!keepDriver) takeover();
    if (!track) { if (queue.length) this.playIndex(0); return; }
    const a = audio();
    playAudioWithUnlock(a.getAttribute('src') ? a.src : streamUrl(track), a.currentTime, true);
  },

  pause({ keepDriver = false }: { keepDriver?: boolean } = {}): void {
    if (!keepDriver) takeover();
    state.playRequested = false;
    audio().pause();
  },

  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  },

  next({ auto = false }: { auto?: boolean } = {}): void {
    if (!auto) takeover();
    // Radio is shuffled already and has its own next round: no random jumps
    // (they would repeat songs), and "repeat all" would replay the same order.
    // A song from the search page is one song: nothing to shuffle.
    const noShuffle = !!context && (context.type === 'radio' || context.type === 'search');
    let i = nextIndex({
      length: queue.length,
      current: this.index,
      repeat: contextRepeat(state.repeatMode, context),
      shuffle: state.isShuffleEnabled && !noShuffle,
      auto,
      blocked: skip && ((at) => (skip as SkipFn)(queue[at])),
    });
    if (i < 0 && refill) {
      const songs = refill(context, track);
      if (songs && songs.length) {
        queue = songs.slice();
        emit('queue', queue);
        i = skip ? queue.findIndex((t) => !(skip as SkipFn)(t)) : 0;
      }
    }
    if (i < 0) { this.pause(); return; }
    this.playIndex(i, { manual: false });
  },

  previous(): void {
    takeover();
    if (track && this.currentTime > RESTART_THRESHOLD) { this.seek(0); this.play(); return; }
    const i = previousIndex({ length: queue.length, current: this.index, repeat: contextRepeat(state.repeatMode, context), blocked: skip && ((at) => (skip as SkipFn)(queue[at])) });
    if (i < 0) { if (track) { this.seek(0); this.play(); } return; }
    this.playIndex(i, { manual: false });
  },

  seek(seconds: number, { keepDriver = false }: { keepDriver?: boolean } = {}): void {
    if (!keepDriver) takeover();
    const a = audio();
    if (!a.duration || !isFinite(seconds)) return;
    a.currentTime = Math.max(0, Math.min(seconds, a.duration));
  },

  // Unload everything (e.g. the context lobby was deleted).
  stop(): void {
    takeover();
    const a = audio();
    a.pause();
    a.removeAttribute('src');
    a.load();
    track = null;
    state.currentTrack = null;
    context = null;
    queue = [];
    emit('track', null);
    emit('context', null);
    emit('queue', queue);
    emit('state', { playing: false });
  },

  setDriver(d: PlayerDriver | null | undefined): void { driver = d || null; },

  // Only a library song's title, artist or album changed (socket library:updated
  // { details }): what is shown follows, the audio plays on untouched.
  updateDetails(details: DetailsChange | null | undefined, song: LibrarySong | null | undefined): void {
    if (!details || !details.id || !song) return;
    const urls = new Set([...(details.oldUrls || []), `library:${details.id}`]);
    const matches = (t: Track | null): t is Track => !!t && (t.libraryId === details.id || urls.has(t.url) || t.url === details.url);
    const patch = (t: Track): Track => ({
      ...t,
      title: t.libraryId ? song.title : (song.artist && song.artist !== 'Unknown' ? `${song.title} - ${song.artist}` : song.title),
      artist: t.libraryId ? (song.artist || '') : t.artist,
    });
    if (queue.some(matches)) { queue = queue.map((t) => (matches(t) ? patch(t) : t)); emit('queue', queue); }
    if (!matches(track)) return;
    track = patch(track);
    state.currentTrack = track;
    emit('track', track);
  },

  // A library song's audio was replaced (socket library:updated { replaced }):
  // { id, oldUrls, url, file_version } plus the new public song. If it is the
  // loaded track, load the new file (versioned url, so no stale cache) at the
  // same position and play state; matching tracks in the context's queue get
  // the new url too. Does not end a driver (listen-along).
  reloadReplaced(replaced: ReplacedChange | null | undefined, song: LibrarySong | null | undefined): void {
    if (!replaced || !replaced.id) return;
    const urls = new Set([...(replaced.oldUrls || []), `library:${replaced.id}`]);
    const matches = (t: Track | null): t is Track => !!t && (t.libraryId === replaced.id || urls.has(t.url) || t.url === replaced.url);
    const src = `/api/library/${encodeURIComponent(replaced.id)}/file${replaced.file_version ? `?v=${encodeURIComponent(replaced.file_version)}` : ''}`;
    const patch = (t: Track): Track => {
      const next = { ...t };
      // Library-page tracks carry a versioned src: give them the new one.
      // Queue entries stream by url; a listen-along driver compares its own
      // src, so those are left as they are (the <audio> still loads `src`).
      if (t.src && !driver) next.src = src;
      // Library tracks keep their library:<id> url; queue entries follow the song.
      if (!String(t.url || '').startsWith('library:') && replaced.url) next.url = replaced.url;
      if (song && song.title) next.title = t.libraryId ? song.title : (song.artist && song.artist !== 'Unknown' ? `${song.title} - ${song.artist}` : song.title);
      if (song && t.libraryId) next.artist = song.artist || '';
      return next;
    };
    if (queue.some(matches)) { queue = queue.map((t) => (matches(t) ? patch(t) : t)); emit('queue', queue); }
    if (!matches(track)) return;
    const a = audio();
    const wasPlaying = hasSource() && !a.paused;
    const position = a.currentTime || 0;
    track = patch(track);
    state.currentTrack = track;
    playAudioWithUnlock(src, position, wasPlaying);
    emit('track', track);
  },
};

// Wire the <audio> element and the Media Session (lock screen, headphone and
// Bluetooth buttons). Call once at start-up.
export function setupPlayer(): void {
  const a = audio();
  setupOneTabPlayback(a);
  a.addEventListener('ended', () => {
    if (driver && driver.onEnded) driver.onEnded();
    else if (!driver) player.next({ auto: true });
  });
  a.addEventListener('seeked', () => emit('seeked', a.currentTime));
  a.addEventListener('play', () => emit('state', { playing: true }));
  a.addEventListener('pause', () => emit('state', { playing: false }));
  a.addEventListener('timeupdate', () => emit('time', { currentTime: a.currentTime, duration: a.duration || 0 }));

  const ms = window.MediaSessionManager;
  if (!ms) return;
  ms.init({
    onPlay: () => player.play(),
    onPause: () => player.pause(),
    onNext: () => player.next(),
    onPrevious: () => player.previous(),
    onSeekTo: (time) => player.seek(time),
  });
  player.on('track', (t) => {
    if (t) ms.updateTrack({ title: t.title, artist: t.artist, thumbnail: t.thumbnail, songId: t.id });
    else ms.updatePlaybackState('none');
  });
  player.on('state', ({ playing }) => ms.updatePlaybackState(playing ? 'playing' : 'paused'));
  player.on('time', ({ currentTime, duration }) => {
    if (duration) ms.updatePositionState({ duration, position: currentTime });
  });
}

// One player per browser: when this tab starts playing it tells the other tabs
// of the same origin, and any of them that is playing pauses. Same browser
// only (no server involved); without BroadcastChannel this does nothing.
const TAB_ID = Math.random().toString(36).slice(2);

function setupOneTabPlayback(a: HTMLAudioElement): void {
  if (typeof BroadcastChannel !== 'function') return;
  let channel: BroadcastChannel;
  try { channel = new BroadcastChannel('listen-along-player'); } catch { return; }
  a.addEventListener('play', () => {
    try { channel.postMessage({ type: 'playing', tab: TAB_ID }); } catch { /* closed */ }
  });
  channel.addEventListener('message', (e: MessageEvent) => {
    const msg = (e.data || {}) as { type?: unknown; tab?: unknown };
    if (msg.type !== 'playing' || msg.tab === TAB_ID || a.paused) return;
    // The listener started something in another tab: that ends listening along here.
    player.pause();
    showToast(tr('player.playingElsewhere', 'Playing in another tab'), 'info');
  });
}
