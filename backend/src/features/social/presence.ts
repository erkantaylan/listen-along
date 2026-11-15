/**
 * Who is online and what each user is playing. Pure in-memory state with no
 * Socket.IO or database access (social.ts wires it up), so it is unit tested
 * directly (features/social/socialServer.test.ts) and can be reused by listen-along (follow a user).
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
 *           playing, position, duration, rate, updatedAt }
 * rate = the playback speed (1 = normal; 0.25-4, anything else is 1): listen
 * along passes it to followers (the web's speed-rules.ts). Additive: a client
 * that sends none is at 1.
 * source = the track's queue url (`library:<uuid>` or a YouTube URL) so
 * listen-along can resolve the library file; kept out of `track` and never
 * sent to clients by viewNowPlaying(). updatedAt = server time of the report,
 * the anchor for `position`.
 * context = { type: 'library' } | { type: 'radio' } | { type: 'artist', key, name }
 *         | { type: 'lobby', lobbyId } | null
 * An artist context is public to every viewer (features/artists lists them for all
 * approved accounts): the key is checked, the name is the client's text, like
 * the track's own title and artist.
 *
 * A lobby context is the raw playlist id. Never send an entry to a client as
 * it is: viewNowPlaying() drops the playlist unless the viewer may see it.
 */

import { EventEmitter } from 'node:events';
import type { Playlist } from '../../shared/types.ts';

const MAX_FIELD = 300;
// features/artists keys: artistCredits.artistNameKey, letters and digits only.
const ARTIST_KEY_RE = /^[\p{L}\p{N}]{1,200}$/u;

/** Where a song is played from, as recorded (checked) from a client's report. */
export type PlayContext =
  | { type: 'library' }
  | { type: 'radio' }
  | { type: 'artist'; key: string; name: string | null }
  | { type: 'lobby'; lobbyId: string };

/** A client's report, checked. */
export interface NowPlayingReport {
  track: { id: string | null; title: string; artist: string | null; thumbnail: string | null };
  /** the queue url (`library:<uuid>` or a YouTube URL); never sent to clients */
  source: string | null;
  context: PlayContext | null;
  playing: boolean;
  position: number;
  duration: number;
  /** playback speed, 1 = normal */
  rate: number;
}

/** What presence keeps per user: the report, the socket that sent it, and when. */
export interface NowPlayingEntry extends NowPlayingReport {
  socketId: string;
  /** server time of the report: the anchor for `position` */
  updatedAt: number;
}

/** What a viewer may see of an entry (viewNowPlaying). */
export interface NowPlayingView {
  track: NowPlayingReport['track'];
  context:
    | { type: 'library' }
    | { type: 'radio' }
    | { type: 'artist'; key: string; name: string | null }
    | { type: 'lobby'; lobbyId: string; name: string | null; socketId: string }
    | null;
  playing: boolean;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface PresenceEvents {
  online: [userId: string];
  offline: [userId: string, lastSeen: number];
  'now-playing': [userId: string, entry: NowPlayingEntry | null];
}

export interface Presence {
  on<E extends keyof PresenceEvents>(event: E, listener: (...args: PresenceEvents[E]) => void): Presence;
  off<E extends keyof PresenceEvents>(event: E, listener: (...args: PresenceEvents[E]) => void): Presence;
  /** A socket of `userId` connected. Returns { online } (true = just came online). */
  connect(userId: string, socketId: string): { online: boolean };
  /** A socket went away. Returns { offline } (true = user is now offline, grace 0 only). */
  disconnect(userId: string, socketId: string): { offline: boolean };
  isOnline(userId: string): boolean;
  onlineUserIds(): string[];
  socketIds(userId: string): string[];
  lastSeen(userId: string): number | null;
  /** Seed from the database (users.last_seen). */
  setLastSeen(userId: string, ms: string | number | null | undefined): void;
  /**
   * Record what a socket of `userId` reports. Only connected sockets count.
   * Returns the new entry, null when cleared, or undefined when ignored.
   */
  setNowPlaying(userId: string, socketId: string, report: unknown): NowPlayingEntry | null | undefined;
  getNowPlaying(userId: string): NowPlayingEntry | null;
  /** Users whose now-playing context is this playlist. */
  usersPlayingFromLobby(lobbyId: string): string[];
  /** Stop all timers (tests, shutdown). */
  close(): void;
}

function str(v: unknown, max = MAX_FIELD): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// What a queue entry / library track carries as `url`.
function source(v: unknown): string | null {
  const s = str(v, 300);
  if (!s) return null;
  if (/^library:[0-9a-f-]{36}$/i.test(s)) return s;
  if (/^https:\/\/(www\.|music\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s)) return s;
  return null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** A client's report as it arrives: anything, read field by field. */
interface RawReport {
  track?: { id?: unknown; title?: unknown; artist?: unknown; thumbnail?: unknown; url?: unknown } | null;
  context?: { type?: unknown; key?: unknown; name?: unknown; lobbyId?: unknown } | null;
  playing?: unknown;
  position?: unknown;
  duration?: unknown;
  rate?: unknown;
}

/** Validate a client report. Returns null when nothing is playing. */
export function normalizeReport(input: unknown): NowPlayingReport | null {
  const report = input as RawReport | null | undefined;
  if (!report || typeof report !== 'object' || !report.track || typeof report.track !== 'object') return null;
  const t = report.track;
  const title = str(t.title);
  if (!title) return null;
  let context: PlayContext | null = null;
  const c = report.context;
  if (c && c.type === 'library') context = { type: 'library' };
  else if (c && c.type === 'radio') context = { type: 'radio' };
  else if (c && c.type === 'artist' && typeof c.key === 'string' && ARTIST_KEY_RE.test(c.key)) {
    context = { type: 'artist', key: c.key, name: str(c.name, 200) };
  } else if (c && c.type === 'lobby' && typeof c.lobbyId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(c.lobbyId)) {
    context = { type: 'lobby', lobbyId: c.lobbyId };
  }
  return {
    track: { id: str(t.id, 64), title, artist: str(t.artist), thumbnail: str(t.thumbnail, 1000) },
    source: source(t.url),
    context,
    playing: !!report.playing,
    position: num(report.position),
    duration: num(report.duration),
    rate: rateOf(report.rate),
  };
}

/** A reported playback speed: 0.25-4, rounded to 1/100; anything else is 1. */
function rateOf(v: unknown): number {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(4, Math.max(0.25, n)) * 100) / 100;
}

export function createPresence({ graceMs = 5000, now = Date.now }: { graceMs?: number; now?: () => number } = {}): Presence {
  const events = new EventEmitter();
  const sockets = new Map<string, Set<string>>();   // userId -> Set<socketId>
  const offlineTimers = new Map<string, NodeJS.Timeout>(); // userId -> timeout (in grace)
  const lastSeen = new Map<string, number>();  // userId -> ms
  const playing = new Map<string, NowPlayingEntry>();   // userId -> entry

  function goOffline(userId: string): void {
    offlineTimers.delete(userId);
    sockets.delete(userId);
    const t = now();
    lastSeen.set(userId, t);
    if (playing.delete(userId)) events.emit('now-playing', userId, null);
    events.emit('offline', userId, t);
  }

  const presence: Presence = {
    on: (event, listener) => { events.on(event, listener); return presence; },
    off: (event, listener) => { events.off(event, listener); return presence; },

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
    setLastSeen(userId, ms) { if (ms) lastSeen.set(userId, Number(ms)); },

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
      const entry: NowPlayingEntry = { socketId, ...r, updatedAt: now() };
      playing.set(userId, entry);
      events.emit('now-playing', userId, entry);
      return entry;
    },

    getNowPlaying(userId) { return playing.get(userId) || null; },

    usersPlayingFromLobby(lobbyId) {
      return [...playing.entries()]
        .filter(([, e]) => e.context && e.context.type === 'lobby' && e.context.lobbyId === lobbyId)
        .map(([u]) => u);
    },

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
export function viewNowPlaying(
  entry: NowPlayingEntry | null | undefined,
  lobbyFor: (lobbyId: string) => Pick<Playlist, 'id' | 'name'> | null | undefined,
): NowPlayingView | null {
  if (!entry) return null;
  let context: NowPlayingView['context'] = null;
  if (entry.context && entry.context.type === 'library') {
    context = { type: 'library' };
  } else if (entry.context && entry.context.type === 'radio') {
    context = { type: 'radio' };
  } else if (entry.context && entry.context.type === 'artist') {
    context = { type: 'artist', key: entry.context.key, name: entry.context.name || null };
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
