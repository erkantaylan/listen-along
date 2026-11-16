/**
 * The Socket.IO server: its rooms, the handshake (who may connect), the
 * central-login re-check of open sockets, and the connection handler, which
 * builds one connection's account helpers and hands them to each area's
 * register(socket, ctx): features/social and features/listen-along (attach), then
 * core/playlists' and core/queue's socket handlers, then the disconnect handler. The
 * order of registration is the order of the handlers, keep it.
 *
 * Rooms: APP_ROOM holds every socket of an approved account (library /
 * requests broadcasts); userRoom(id) every socket of one account (so a
 * denied account can be disconnected everywhere); sessionRoom(hash) every
 * socket of one central-login session.
 */

import { Server } from 'socket.io';
import type { Server as HttpServer, IncomingHttpHeaders } from 'node:http';
import type { CorsOptions } from 'cors';
import { isBlocked } from '../auth/index.ts';
import { emitPlaylistEvent } from '../shared/legacyWire.ts';
import type { UserAuth } from '../auth/index.ts';
import type { PlaylistSockets } from '../core/playlists/index.ts';
import type { QueueSockets } from '../core/queue/index.ts';
import type { AppSocket, Io } from '../shared/types.ts';

export const APP_ROOM = 'app';
export const userRoom = (id: string): string => `user:${id}`;
// Central login: every socket of one session (keyed by the session id's hash).
export function sessionRoom(idHash: string): string { return `session:${idHash}`; }

/**
 * @param deps.cors the same CORS options as the HTTP API
 */
export function createSocketServer({ server, cors }: { server: HttpServer; cors: CorsOptions }): Io {
  return new Server(server, {
    cors
  });
}

// A browser opening a WebSocket from another site sends its Origin. Refuse
// origins that are not this server (Host / X-Forwarded-Host) or the
// configured FRONTEND_URL / BASE_URL, so another site cannot ride the login
// cookie. Clients without an Origin header (CLI, tests) still need the cookie.
export function socketOriginAllowed(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const allowed = new Set<string>();
  for (const h of [headers.host, headers['x-forwarded-host']]) {
    if (typeof h === 'string') for (const part of h.split(',')) allowed.add(part.trim().toLowerCase());
  }
  for (const u of [env.FRONTEND_URL, env.BASE_URL]) {
    if (!u) continue;
    try { allowed.add(new URL(u).host.toLowerCase()); } catch {}
  }
  return allowed.has(host);
}

export interface SocketHandlersDeps {
  io: Io;
  /** FRONTEND_URL / BASE_URL (allowed origins) */
  env: NodeJS.ProcessEnv;
  db: { isAvailable(): boolean };
  userAuth: Pick<UserAuth, 'resolve' | 'getAccount'>;
  oidc: { enabled: boolean; recheckMs?: number };
  /** central login only */
  oidcSessions: { check(idHash: string): Promise<unknown> } | null; // truthy = the session is live
  /** made in start() */
  getSocial: () => { attach(socket: AppSocket): void } | null;
  /** made in start() */
  getListenAlong: () => { attach(socket: AppSocket): void } | null;
  /** core/playlists createPlaylistSockets() */
  playlistSockets: PlaylistSockets;
  /** core/queue createQueueSockets() */
  queueSockets: QueueSockets;
}

export function attachSocketHandlers({ io, env, db, userAuth, oidc: OIDC, oidcSessions, getSocial, getListenAlong, playlistSockets, queueSockets }: SocketHandlersDeps): void {
  // Socket.IO handshake: only a logged-in account that is not denied / rejected may
  // connect. Pending accounts connect for the global chat and people panel;
  // every playlist/queue event checks for an approved account itself.
  // Who the handshake is comes from userAuth.resolve(): the central-login
  // session (la_session) or the dev sign-in cookie, the same as for HTTP.
  // A central-login socket also joins its session's room, so ending that
  // session (logout, a failed re-check, a ban) cuts it.
  io.use((socket, next) => {
    const headers = socket.request.headers || {};
    if (!socketOriginAllowed(headers, env)) return next(new Error('Origin not allowed'));
    userAuth.resolve(headers).then(async (who) => {
      if (!who) return next(new Error('Authentication required'));
      const { userId, sessionId } = who;
      const account = await userAuth.getAccount(userId);
      if (!account) return next(new Error('Authentication required'));
      if (isBlocked(account.status)) return next(new Error('Access denied'));
      socket.data.userId = userId;
      socket.join(userRoom(userId));
      if (sessionId) {
        socket.data.sessionId = sessionId;
        socket.join(sessionRoom(sessionId));
      }
      if (account.status === 'approved') socket.join(APP_ROOM);
      next();
    }).catch((err) => {
      console.error('Socket account lookup failed:', (err as Error).message);
      next(new Error('Could not check your account, try again'));
    });
  });

  // Central login: sockets live for hours, so their sessions are re-checked on
  // a timer too (oidcSessions.check refreshes only when due). A session that
  // ends takes its sockets with it (oidcSessions' onEnded, main.ts).
  if (OIDC.enabled) {
    // Central login has its re-check interval and its sessions.
    const SOCKET_CHECK_MS = Math.max(5_000, Math.min(60_000, OIDC.recheckMs!));
    setInterval(() => {
      const ids = new Set<string>();
      for (const s of io.sockets.sockets.values()) if (s.data.sessionId) ids.add(s.data.sessionId);
      for (const id of ids) {
        oidcSessions!.check(id).then((live) => {
          if (!live) io.in(sessionRoom(id)).disconnectSockets(true);
        }).catch((err) => console.error('[oidc] socket session check failed:', err.message));
      }
    }, SOCKET_CHECK_MS).unref();
  }

  // Socket.IO connection handling
  // Socket.IO connection handling
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    // Who this socket is: the users.id from the handshake's login cookie
    // (the central-login session, or the dev sign-in; set by io.use above; never
    // a client-supplied id).
    // Set by the handshake above: only an account connects.
    const userId = socket.data.userId!;

    // Global chat + people panel (presence, now playing): see features/social.
    const social = getSocial();
    if (social) social.attach(socket);
    // Listen along with another user (follows their now-playing): features/listen-along.
    const listenAlong = getListenAlong();
    if (listenAlong) listenAlong.attach(socket);

    // The account as it is now (status changes apply without reconnecting;
    // userAuth caches lookups for a few seconds). null on error: fail closed.
    const currentAccount = () => userAuth.getAccount(userId).catch((err) => {
      console.error('Socket account lookup failed:', (err as Error).message);
      return null;
    });
    // Playlists, queue, listening: approved accounts only.
    const isApproved = async () => {
      const account = await currentAccount();
      if (account && account.status === 'approved') { socket.join(APP_ROOM); return true; }
      return false;
    };
    // The name shown for this socket in playlists and on queued songs: the
    // account's display name. Only without a database (no users table) is the
    // client's name used, as features/social does.
    const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 30) : '');
    const cleanEmoji = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : null);
    const displayName = async (clientName: unknown) => {
      const account = await currentAccount();
      if (db.isAvailable()) return (account && account.name ? cleanName(account.name) : '') || 'Anonymous';
      return cleanName(clientName) || 'Anonymous';
    };
    const displayEmoji = async (clientEmoji: unknown) => {
      if (!db.isAvailable()) return cleanEmoji(clientEmoji);
      const account = await currentAccount();
      return account ? cleanEmoji(account.emoji) : null;
    };
    const refusePending = (event?: string) => {
      const refusal = { message: 'Your account is pending approval', code: 'ACCOUNT_PENDING' };
      if (event) socket.emit(event, refusal);
      else emitPlaylistEvent(socket, 'playlist:error', refusal);
    };

    // playlist:create / join / view / unview / leave / pin / rename, user:update,
    // listener:now-playing (core/playlists). The playlist this socket is in.
    const playlist = playlistSockets.register(socket, { userId, isApproved, displayName, displayEmoji, refusePending });

    // queue:add / remove / restore / reorder / clear / get (core/queue).
    queueSockets.register(socket, { userId, visiblePlaylist: playlist.visiblePlaylist, editablePlaylist: playlist.editablePlaylist, displayName });

    socket.on('disconnect', (reason) => {
      console.log(`Client disconnected: ${socket.id} (${reason})`);
      playlist.disconnected();
    });
  });
}

