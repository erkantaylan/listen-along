// The app-wide audio player. It is local to this browser and lives outside the
// views, so it keeps playing while the user moves around the SPA, and only one
// tab of the browser plays at a time (BroadcastChannel, see below).
//
// "Context" is what playback was last started from: a lobby queue
// ({ type: 'lobby', lobbyId, name }), the music library list
// ({ type: 'library' }), or another user while listening along
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
import { state, elements } from './state.js';
import { playAudioWithUnlock } from './audio.js';
import { showToast, t as tr } from './ui.js';
import { findTrackIndex, nextIndex, previousIndex, RESTART_THRESHOLD } from './player-queue.js';

const handlers = new Map();
let context = null;
let queue = [];
let track = null;
let driver = null;

const audio = () => elements.audioPlayer;

function emit(event, payload) {
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

export function streamUrl(t) {
  return t.src || `/api/stream?q=${encodeURIComponent(t.url)}`;
}

function normalizeContext(ctx) {
  if (!ctx) return null;
  if (ctx.type === 'library') return { type: 'library', name: ctx.name || null };
  if (ctx.type === 'listen') return ctx.leaderId ? { type: 'listen', leaderId: ctx.leaderId, name: ctx.name || null } : null;
  if (!ctx.lobbyId) return null;
  return { type: 'lobby', lobbyId: ctx.lobbyId, name: ctx.name || null };
}

function sameContext(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'listen') return a.leaderId === b.leaderId;
  return a.type === 'library' || a.lobbyId === b.lobbyId;
}

function isLobbyContext(lobbyId) {
  return !!context && context.type === 'lobby' && context.lobbyId === lobbyId;
}

function hasSource() {
  const a = audio();
  return !!a.getAttribute('src');
}

export const player = {
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event).delete(fn);
  },

  get context() { return context; },
  get queue() { return queue; },
  get track() { return track; },
  get index() { return findTrackIndex(queue, track); },
  get isPlaying() { return hasSource() && !audio().paused; },
  get currentTime() { return audio().currentTime || 0; },
  get duration() { return audio().duration || 0; },
  get driver() { return driver; },

  // keepDriver: the driver itself is switching the context (listen-along).
  setContext(ctx, songs = [], { keepDriver = false } = {}) {
    const next = normalizeContext(ctx);
    if (!next) return;
    const changed = !sameContext(context, next);
    if (changed && !keepDriver) takeover();
    context = next;
    queue = Array.isArray(songs) ? songs.slice() : [];
    emit('context', context);
    emit('queue', queue);
  },

  renameContext(lobbyId, name) {
    if (!isLobbyContext(lobbyId)) return;
    context = { ...context, name: name || null };
    emit('context', context);
  },

  updateQueue(lobbyId, songs) {
    if (!isLobbyContext(lobbyId)) return;
    queue = Array.isArray(songs) ? songs.slice() : [];
    emit('queue', queue);
  },

  // Play `index` of a context's songs; switches the context when it is another one.
  playFrom(ctx, songs, index) {
    takeover();
    if (!sameContext(context, normalizeContext(ctx))) this.setContext(ctx, songs);
    else { queue = songs.slice(); emit('queue', queue); }
    this.playIndex(index, { manual: false });
  },

  playIndex(i, { manual = true } = {}) {
    if (manual) takeover();
    const t = queue[i];
    if (t) this.playTrack(t);
  },

  // Load any track (it need not be in the queue) at `position`.
  playTrack(t, { position = 0, autoplay = true } = {}) {
    if (!t || !t.url) return;
    const changed = !track || track.id !== t.id || track.url !== t.url;
    track = t;
    state.currentTrack = t;
    playAudioWithUnlock(streamUrl(t), position, autoplay);
    if (changed) emit('track', track);
  },

  play({ keepDriver = false } = {}) {
    if (!keepDriver) takeover();
    if (!track) { if (queue.length) this.playIndex(0); return; }
    const a = audio();
    playAudioWithUnlock(a.getAttribute('src') ? a.src : streamUrl(track), a.currentTime, true);
  },

  pause({ keepDriver = false } = {}) {
    if (!keepDriver) takeover();
    audio().pause();
  },

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  },

  next({ auto = false } = {}) {
    if (!auto) takeover();
    const i = nextIndex({
      length: queue.length,
      current: this.index,
      repeat: state.repeatMode,
      shuffle: state.isShuffleEnabled,
      auto,
    });
    if (i < 0) { this.pause(); return; }
    this.playIndex(i, { manual: false });
  },

  previous() {
    takeover();
    if (track && this.currentTime > RESTART_THRESHOLD) { this.seek(0); this.play(); return; }
    const i = previousIndex({ length: queue.length, current: this.index, repeat: state.repeatMode });
    if (i < 0) { if (track) { this.seek(0); this.play(); } return; }
    this.playIndex(i, { manual: false });
  },

  seek(seconds, { keepDriver = false } = {}) {
    if (!keepDriver) takeover();
    const a = audio();
    if (!a.duration || !isFinite(seconds)) return;
    a.currentTime = Math.max(0, Math.min(seconds, a.duration));
  },

  // Unload everything (e.g. the context lobby was deleted).
  stop() {
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

  setDriver(d) { driver = d || null; },
};

// Wire the <audio> element and the Media Session (lock screen, headphone and
// Bluetooth buttons). Call once at start-up.
export function setupPlayer() {
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

function setupOneTabPlayback(a) {
  if (typeof BroadcastChannel !== 'function') return;
  let channel;
  try { channel = new BroadcastChannel('listen-along-player'); } catch { return; }
  a.addEventListener('play', () => {
    try { channel.postMessage({ type: 'playing', tab: TAB_ID }); } catch { /* closed */ }
  });
  channel.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'playing' || msg.tab === TAB_ID || a.paused) return;
    // The listener started something in another tab: that ends listening along here.
    player.pause();
    showToast(tr('player.playingElsewhere', 'Playing in another tab'), 'info');
  });
}
