/**
 * The global chat and the people panel over Socket.IO.
 *
 * Who takes part: every socket whose login (auth/userAuth.ts) names a user
 * (socket.data.userId, set in app/sockets.ts from the handshake — never an id the
 * client sends) whose account is not 'denied' / 'rejected'. Pending users take
 * part fully (read, write, appear in the list). Denied and rejected accounts
 * are left out of the people list and cannot use the chat; anonymous sockets
 * get nothing.
 *
 * Rooms: 'social' (everyone taking part) and 'user:<id>' (one user's sockets,
 * used to show a private playlist's name to its owner only).
 *
 * Client -> server
 *   social:hello { name, emoji }            only without a database: the display name
 *   people:list  (ack) -> { me, isAdmin, people: [person] }
 *   chat:history { before, limit } (ack) -> { messages, hasMore }
 *   chat:send    { text } (ack) -> { ok, message } | { error }
 *   chat:delete  { id } (ack) -> { ok } | { error }          admin cookie only
 *   presence:now-playing { track, context, playing, position, duration }  (null track = stopped)
 * Server -> client ('social' room)
 *   chat:message  message
 *   chat:deleted  { id }
 *   people:presence { user: person }        came online / went offline (lastSeen)
 *   people:now-playing { userId, nowPlaying }
 *   people:user   { user: person }          name/avatar changed, or a new account
 *   people:removed { userId }               account denied / rejected
 *
 *   people:listeners { userId, count }       how many listen along (features/listen-along)
 *
 * person = { id, name, emoji, avatarUrl, pending, online, lastSeen, nowPlaying, listeners }
 * listeners = how many people listen along with them (a count, no names).
 */

import { access } from '../../core/playlists/index.ts';
import * as chat from './chat.ts';
import type { ChatStore, RateLimiter } from './chat.ts';
import { viewNowPlaying } from './presence.ts';
import type { NowPlayingView, Presence } from './presence.ts';
import type { AppSocket, Db, Playlist, UserRow } from '../../shared/types.ts';

const BLOCKED_STATUSES = new Set(['denied', 'rejected']);
const ROOM = 'social';
const userRoom = (id: string) => `user:${id}`;

/** One user as social keeps them (from the users row, or from social:hello without a database). */
interface Profile {
  id: string;
  name: string;
  emoji: string | null;
  avatarUrl: string | null;
  status: string;
}

/** A user in the people panel (people:list, people:presence, people:user). */
export interface Person {
  id: string;
  name: string;
  emoji: string | null;
  avatarUrl: string | null;
  pending: boolean;
  online: boolean;
  lastSeen: number | null;
  /** undefined in people:presence / people:user (now playing has its own event) */
  nowPlaying: NowPlayingView | null | undefined;
  /** how many listen along with them (a count, no names) */
  listeners: number;
}

/** The users columns social reads. */
type ProfileRow = Pick<UserRow, 'id' | 'display_name' | 'name' | 'username' | 'emoji' | 'avatar_url' | 'status' | 'last_seen'>;

/** What social uses of the Socket.IO server (the real one fits). */
interface Broadcast {
  emit(event: string, payload: unknown): unknown;
  except(room: string): Broadcast;
}
export interface SocialIo {
  to(room: string): Broadcast;
  in(room: string): { socketsLeave(room: string): void };
}

/** What attach uses of a connection. */
export type SocialSocket = Pick<AppSocket, 'id' | 'data' | 'request' | 'connected' | 'join' | 'on'>;

export interface SocialDeps {
  /** Socket.IO server */
  io: SocialIo;
  /** db module (isAvailable/query); null or unavailable = in memory */
  db: Db | null;
  /** createPresence() instance */
  presence: Presence;
  /** chat store (createPgStore / createMemoryStore) */
  store: ChatStore;
  /** (lobbyId) -> lobby | undefined (in-memory lookup, sync) */
  getLobby: (lobbyId: string) => Playlist | null | undefined;
  /** (headers) -> boolean (admin cookie) */
  isAdmin: (headers: Record<string, string | string[] | undefined>) => boolean;
  /** chat rate limiter (createRateLimiter) */
  limiter?: RateLimiter;
  /** (userId) -> how many listen along with them */
  listenerCount?: (userId: string) => number;
}

export interface Social {
  /** Registers this connection's social handlers (app/sockets.ts); sets socket.data.socialReady. */
  attach(socket: SocialSocket): void;
  listPeople(viewerId: string | null): Promise<Person[]>;
  /** Admin moderation: removes a message and tells everyone. */
  deleteMessage(id: unknown): Promise<boolean>;
  /** A playlist was renamed, changed visibility or was deleted. */
  lobbyChanged(lobbyId: string): void;
  /** Name/avatar/status changed (profile page, admin approve/reject). */
  profileChanged(userId: string): Promise<void>;
  /** Shutdown: whoever is online was last seen now. */
  flushLastSeen(): Promise<void>;
  /** Display name of a user taking part (listen-along). */
  nameOf(userId: string): string | null;
  presence: Presence;
  store: ChatStore;
}

type Ack = (payload: unknown) => void;

export function isEligible(status: unknown): boolean {
  return !BLOCKED_STATUSES.has(status as string);
}

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 30) : '';
}

function safeAvatar(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return /^https:\/\//i.test(url) ? url.slice(0, 1000) : null;
}

export function createSocial({ io, db, presence, store, getLobby, isAdmin, limiter = chat.createRateLimiter(), listenerCount = () => 0 }: SocialDeps): Social {
  // userId -> { id, name, emoji, avatarUrl, status }
  const profiles = new Map<string, Profile>();

  const dbOn = () => db && db.isAvailable();
  // Only called after dbOn().
  const database = () => db as Db;

  function profileFromRow(r: ProfileRow): Profile {
    return {
      id: String(r.id),
      name: r.display_name || r.name || r.username || 'User',
      emoji: r.emoji || null,
      avatarUrl: safeAvatar(r.avatar_url),
      status: r.status || 'approved',
    };
  }

  async function loadProfile(userId: string): Promise<Profile | null> {
    if (!dbOn()) {
      return profiles.get(userId) || { id: userId, name: 'User', emoji: null, avatarUrl: null, status: 'approved' };
    }
    const r = await database().query<ProfileRow>(
      'SELECT id, display_name, name, username, emoji, avatar_url, status, last_seen FROM users WHERE id::text = $1',
      [userId]
    );
    if (!r.rows.length) return null;
    presence.setLastSeen(userId, r.rows[0].last_seen);
    return profileFromRow(r.rows[0]);
  }

  async function persistLastSeen(userId: string, ms: number): Promise<void> {
    if (!dbOn()) return;
    try {
      await database().query('UPDATE users SET last_seen = $1 WHERE id::text = $2', [ms, userId]);
    } catch (err) {
      console.error('last_seen update failed:', (err as Error).message);
    }
  }

  // The playlist if `viewerId` may see it.
  const lobbyForViewer = (viewerId: string | null) => (lobbyId: string): Playlist | null | undefined => {
    const l = getLobby(lobbyId);
    return access.canView(l, viewerId) ? l : null;
  };

  function person(p: Profile, viewerId: string | null): Person {
    return {
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      avatarUrl: p.avatarUrl,
      pending: p.status === 'pending',
      online: presence.isOnline(p.id),
      lastSeen: presence.lastSeen(p.id),
      nowPlaying: viewNowPlaying(presence.getNowPlaying(p.id), lobbyForViewer(viewerId)),
      listeners: listenerCount(p.id),
    };
  }

  async function listPeople(viewerId: string | null): Promise<Person[]> {
    let list: Profile[];
    if (dbOn()) {
      const r = await database().query<ProfileRow>(
        'SELECT id, display_name, name, username, emoji, avatar_url, status, last_seen FROM users ORDER BY created_at ASC'
      );
      list = [];
      for (const row of r.rows) {
        if (!isEligible(row.status)) continue;
        const p = profileFromRow(row);
        if (!presence.isOnline(p.id)) presence.setLastSeen(p.id, row.last_seen);
        profiles.set(p.id, p);
        list.push(p);
      }
    } else {
      list = [...profiles.values()];
    }
    return list.map(p => person(p, viewerId));
  }

  // Send `build(viewerId)` to everyone taking part. When the payload depends
  // on a private playlist, its owner gets their own version and everybody
  // else the redacted one.
  function emitNowPlaying(userId: string): void {
    const entry = presence.getNowPlaying(userId);
    const lobbyId = entry && entry.context && entry.context.type === 'lobby' ? entry.context.lobbyId : null;
    const l = lobbyId ? getLobby(lobbyId) : null;
    if (l && access.isPrivate(l) && l.ownerId) {
      io.to(userRoom(l.ownerId)).emit('people:now-playing', { userId, nowPlaying: viewNowPlaying(entry, lobbyForViewer(l.ownerId)) });
      io.to(ROOM).except(userRoom(l.ownerId)).emit('people:now-playing', { userId, nowPlaying: viewNowPlaying(entry, () => null) });
      return;
    }
    // Public (or no) playlist: every signed-in viewer may see it.
    io.to(ROOM).emit('people:now-playing', { userId, nowPlaying: viewNowPlaying(entry, (id) => getLobby(id) || null) });
  }

  function emitPresence(userId: string): void {
    const p = profiles.get(userId);
    if (!p) return;
    // Presence payload carries no now-playing (that has its own event).
    io.to(ROOM).emit('people:presence', { user: { ...person(p, null), nowPlaying: undefined } });
  }

  presence.on('online', (userId) => emitPresence(userId));
  presence.on('offline', (userId, lastSeen) => {
    persistLastSeen(userId, lastSeen);
    emitPresence(userId);
  });
  presence.on('now-playing', (userId) => emitNowPlaying(userId));

  function attach(socket: SocialSocket): void {
    // Handlers that need it run only once ok() said there is an account.
    const userId = socket.data.userId as string;
    const headers = socket.request.headers || {};

    // Anonymous sockets get the handlers too, so they hear "Not signed in".
    const ready = (async () => {
      if (!userId) return false;
      let p;
      try { p = await loadProfile(userId); } catch (err) {
        console.error('Social profile load failed:', (err as Error).message);
        return false;
      }
      if (!p || !isEligible(p.status) || !socket.connected) return false;
      const known = profiles.has(userId);
      profiles.set(userId, p);
      socket.join(ROOM);
      socket.join(userRoom(userId));
      socket.data.social = true;
      const { online } = presence.connect(userId, socket.id);
      if (online) persistLastSeen(userId, Date.now());
      else if (!known) emitPresence(userId);
      return true;
    })();
    socket.data.socialReady = ready;

    const ok = async () => (await ready) && socket.data.social;
    const reply = (ack: Ack | undefined, payload: unknown) => { if (typeof ack === 'function') ack(payload); };

    // Without a database there is no users table: take the display name the
    // client shows (the id still comes from the signed cookie).
    socket.on('social:hello', async ({ name, emoji }: { name?: unknown; emoji?: unknown } = {}) => {
      if (dbOn() || !(await ok())) return;
      const p = profiles.get(userId);
      const n = cleanName(name);
      if (!p || !n) return;
      p.name = n;
      p.emoji = typeof emoji === 'string' ? emoji.slice(0, 10) : p.emoji;
      io.to(ROOM).emit('people:user', { user: { ...person(p, null), nowPlaying: undefined } });
    });

    socket.on('people:list', async (_arg: unknown, ack?: Ack) => {
      if (typeof _arg === 'function') { ack = _arg as Ack; }
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      try {
        reply(ack, { me: userId, isAdmin: !!isAdmin(headers), people: await listPeople(userId) });
      } catch (err) {
        console.error('People list failed:', (err as Error).message);
        reply(ack, { error: 'Could not load people' });
      }
    });

    socket.on('chat:history', async (arg: { before?: unknown; limit?: unknown } | Ack | undefined, ack?: Ack) => {
      if (typeof arg === 'function') { ack = arg; arg = {}; }
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      try {
        reply(ack, await store.page({ before: arg && arg.before, limit: arg && arg.limit }));
      } catch (err) {
        console.error('Chat history failed:', (err as Error).message);
        reply(ack, { error: 'Could not load messages' });
      }
    });

    socket.on('chat:send', async (arg: { text?: unknown } | undefined, ack?: Ack) => {
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      const { text, error } = chat.normalizeText(arg && arg.text);
      if (error !== undefined) return reply(ack, { error });
      if (!limiter.hit(userId)) return reply(ack, { error: 'You are sending messages too fast. Wait a few seconds.' });
      try {
        const p: Partial<Profile> = profiles.get(userId) || {};
        const message = await store.add({ userId, author: p, text, createdAt: Date.now() });
        io.to(ROOM).emit('chat:message', message);
        reply(ack, { ok: true, message });
      } catch (err) {
        console.error('Chat send failed:', (err as Error).message);
        reply(ack, { error: 'Could not send the message' });
      }
    });

    socket.on('chat:delete', async (arg: { id?: unknown } | undefined, ack?: Ack) => {
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      // Re-checked on every call: the admin cookie expires.
      if (!isAdmin(headers)) return reply(ack, { error: 'Only an admin can delete messages' });
      const removed = await deleteMessage(arg && arg.id);
      reply(ack, removed ? { ok: true } : { error: 'Message not found' });
    });

    socket.on('presence:now-playing', async (report: { context?: { type?: unknown; lobbyId?: unknown } | null } | null | undefined) => {
      if (!(await ok())) return;
      // A playlist the reporter cannot see is never recorded.
      let r = report;
      if (r && r.context && r.context.type === 'lobby' && !access.canView(getLobby(r.context.lobbyId as string), userId)) {
        r = { ...r, context: null };
      }
      presence.setNowPlaying(userId, socket.id, r);
    });

    socket.on('disconnect', async () => {
      if (!(await ready)) return;
      presence.disconnect(userId, socket.id);
    });
  }

  async function deleteMessage(id: unknown): Promise<boolean> {
    let removed = false;
    try { removed = await store.remove(id); } catch (err) {
      console.error('Chat delete failed:', (err as Error).message);
      return false;
    }
    if (removed) io.to(ROOM).emit('chat:deleted', { id: Number(id) });
    return removed;
  }

  // A playlist was renamed, changed visibility or was deleted: everyone
  // playing from it gets a fresh (re-redacted) now-playing.
  function lobbyChanged(lobbyId: string): void {
    for (const userId of presence.usersPlayingFromLobby(lobbyId)) emitNowPlaying(userId);
  }

  // Name/avatar/status changed (profile page, admin approve/reject).
  async function profileChanged(userId: string): Promise<void> {
    let p;
    try { p = await loadProfile(userId); } catch { return; }
    if (!p || !isEligible(p.status)) {
      profiles.delete(userId);
      io.to(ROOM).emit('people:removed', { userId });
      io.in(userRoom(userId)).socketsLeave(ROOM);
      return;
    }
    profiles.set(userId, p);
    io.to(ROOM).emit('people:user', { user: { ...person(p, null), nowPlaying: undefined } });
  }

  // Shutdown: whoever is online was last seen now.
  async function flushLastSeen(): Promise<void> {
    const t = Date.now();
    await Promise.all(presence.onlineUserIds().map(u => persistLastSeen(u, t)));
  }

  // Display name of a user taking part (listen-along).
  const nameOf = (userId: string): string | null => (profiles.get(userId) || {} as Partial<Profile>).name || null;

  return { attach, listPeople, deleteMessage, lobbyChanged, profileChanged, flushLastSeen, nameOf, presence, store };
}
