/**
 * Who is online and what each user is playing. Pure in-memory state with no
 * Socket.IO or database access (social.js wires it up), so it is unit tested
 * directly (social.test.js) and can be reused by listen-along (follow a user).
 *
 * Presence: a user is online while they have at least one connected socket;
 * several tabs/devices count once. When the last socket goes, the user stays
 * online for `graceMs` (a page reload must not flicker offline), then goes
 * offline and gets a lastSeen time. graceMs = 0 means immediately.
 *
 * Now playing: one entry per user, whatever the number of tabs. The last
 * report wins (except that a paused tab never overrides another tab that is
 * playing); it remembers which socket sent it. The entry is dropped when
 * that socket disconnects (that tab was the player) or the report says
 * nothing is loaded.
 *
 * Events (EventEmitter):
 *   'online'      (userId)
 *   'offline'     (userId, lastSeen)
 *   'now-playing' (userId, entry | null)
 *
 * entry = { socketId, track: { id, title, artist, thumbnail }, source, context,
 *           playing, position, duration, updatedAt }
 * source = the track's queue url (`library:<uuid>` or a YouTube URL) so
 * listen-along can resolve the library file; kept out of `track` and never
 * sent to clients by viewNowPlaying(). updatedAt = server time of the report,
 * the anchor for `position`.
 * context = { type: 'library' } | { type: 'lobby', lobbyId } | null
 *
 * A lobby context is the raw playlist id. Never send an entry to a client as
 * it is: viewNowPlaying() drops the playlist unless the viewer may see it.
 */

const { EventEmitter } = require('events');

const MAX_FIELD = 300;

function str(v, max = MAX_FIELD) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// What a queue entry / library track carries as `url`.
function source(v) {
  const s = str(v, 300);
  if (!s) return null;
  if (/^library:[0-9a-f-]{36}$/i.test(s)) return s;
  if (/^https:\/\/(www\.|music\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s)) return s;
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Validate a client report. Returns null when nothing is playing. */
function normalizeReport(report) {
  if (!report || typeof report !== 'object' || !report.track || typeof report.track !== 'object') return null;
  const t = report.track;
  const title = str(t.title);
  if (!title) return null;
  let context = null;
  const c = report.context;
  if (c && c.type === 'library') context = { type: 'library' };
  else if (c && c.type === 'lobby' && typeof c.lobbyId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(c.lobbyId)) {
    context = { type: 'lobby', lobbyId: c.lobbyId };
  }
  return {
    track: { id: str(t.id, 64), title, artist: str(t.artist), thumbnail: str(t.thumbnail, 1000) },
    source: source(t.url),
    context,
    playing: !!report.playing,
    position: num(report.position),
    duration: num(report.duration),
  };
}

function createPresence({ graceMs = 5000, now = Date.now } = {}) {
  const events = new EventEmitter();
  const sockets = new Map();   // userId -> Set<socketId>
  const offlineTimers = new Map(); // userId -> timeout (in grace)
  const lastSeen = new Map();  // userId -> ms
  const playing = new Map();   // userId -> entry

  function goOffline(userId) {
    offlineTimers.delete(userId);
    sockets.delete(userId);
    const t = now();
    lastSeen.set(userId, t);
    if (playing.delete(userId)) events.emit('now-playing', userId, null);
    events.emit('offline', userId, t);
  }

  const presence = {
    on: (...a) => { events.on(...a); return presence; },
    off: (...a) => { events.off(...a); return presence; },

    /** A socket of `userId` connected. Returns { online } (true = just came online). */
    connect(userId, socketId) {
      if (!userId || !socketId) return { online: false };
      const timer = offlineTimers.get(userId);
      if (timer) { clearTimeout(timer); offlineTimers.delete(userId); }
      let set = sockets.get(userId);
      const wasOnline = !!set || !!timer;
      if (!set) { set = new Set(); sockets.set(userId, set); }
      set.add(socketId);
      if (!wasOnline) events.emit('online', userId);
      return { online: !wasOnline };
    },

    /** A socket went away. Returns { offline } (true = user is now offline, grace 0 only). */
    disconnect(userId, socketId) {
      const set = sockets.get(userId);
      if (!set || !set.delete(socketId)) return { offline: false };
      const entry = playing.get(userId);
      if (entry && entry.socketId === socketId) {
        playing.delete(userId);
        events.emit('now-playing', userId, null);
      }
      if (set.size > 0) return { offline: false };
      if (graceMs <= 0) { goOffline(userId); return { offline: true }; }
      const timer = setTimeout(() => {
        if ((sockets.get(userId) || new Set()).size === 0) goOffline(userId);
      }, graceMs);
      if (timer.unref) timer.unref();
      offlineTimers.set(userId, timer);
      return { offline: false };
    },

    isOnline(userId) {
      return (sockets.get(userId)?.size || 0) > 0 || offlineTimers.has(userId);
    },
    onlineUserIds() {
      return [...new Set([...[...sockets.entries()].filter(([, s]) => s.size > 0).map(([u]) => u), ...offlineTimers.keys()])];
    },
    socketIds(userId) { return [...(sockets.get(userId) || [])]; },

    lastSeen(userId) { return lastSeen.get(userId) || null; },
    /** Seed from the database (users.last_seen). */
    setLastSeen(userId, ms) { if (ms) lastSeen.set(userId, Number(ms)); },

    /**
     * Record what a socket of `userId` reports. Only connected sockets count.
     * Returns the new entry, null when cleared, or undefined when ignored.
     */
    setNowPlaying(userId, socketId, report) {
      if (!sockets.get(userId)?.has(socketId)) return undefined;
      const r = normalizeReport(report);
      if (!r) {
        if (!playing.has(userId)) return null;
        playing.delete(userId);
        events.emit('now-playing', userId, null);
        return null;
      }
      // A tab pausing because another tab took over playback (one player per
      // browser) must not override the tab that is now playing.
      const current = playing.get(userId);
      if (current && current.socketId !== socketId && current.playing && !r.playing) return undefined;
      const entry = { socketId, ...r, updatedAt: now() };
      playing.set(userId, entry);
      events.emit('now-playing', userId, entry);
      return entry;
    },

    getNowPlaying(userId) { return playing.get(userId) || null; },

    /** Users whose now-playing context is this playlist. */
    usersPlayingFromLobby(lobbyId) {
      return [...playing.entries()]
        .filter(([, e]) => e.context && e.context.type === 'lobby' && e.context.lobbyId === lobbyId)
        .map(([u]) => u);
    },

    /** Stop all timers (tests, shutdown). */
    close() {
      for (const t of offlineTimers.values()) clearTimeout(t);
      offlineTimers.clear();
    },
  };
  return presence;
}

/**
 * What a viewer may see of a now-playing entry. `lobbyFor(lobbyId)` returns
 * the playlist when the viewer may see it, else null; a playlist the viewer
 * cannot see (someone else's private one, or deleted) is dropped entirely:
 * no name, no id, just the song.
 */
function viewNowPlaying(entry, lobbyFor) {
  if (!entry) return null;
  let context = null;
  if (entry.context && entry.context.type === 'library') {
    context = { type: 'library' };
  } else if (entry.context && entry.context.type === 'lobby') {
    const l = lobbyFor(entry.context.lobbyId);
    if (l) context = { type: 'lobby', lobbyId: l.id, name: l.name || null, socketId: entry.socketId };
  }
  return {
    track: { ...entry.track },
    context,
    playing: entry.playing,
    position: entry.position,
    duration: entry.duration,
    updatedAt: entry.updatedAt,
  };
}

module.exports = { createPresence, viewNowPlaying, normalizeReport };
