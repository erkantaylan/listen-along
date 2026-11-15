/**
 * The Socket.IO server: its rooms, the handshake (who may connect), the
 * central-login re-check of open sockets, and the connection handler, which
 * builds one connection's account helpers and hands them to each area's
 * register(socket, ctx): social.js and listenAlong.js (attach), then
 * playlistSockets.js and queueSockets.js, then the disconnect handler. The
 * order of registration is the order of the handlers, keep it.
 *
 * Rooms: APP_ROOM holds every socket of an approved account (library /
 * requests broadcasts); userRoom(id) every socket of one account (so a
 * denied account can be disconnected everywhere); sessionRoom(hash) every
 * socket of one central-login session.
 */

const { Server } = require('socket.io');
const { isBlocked } = require('./userAuth');

const APP_ROOM = 'app';
const userRoom = (id) => `user:${id}`;
// Central login: every socket of one session (keyed by the session id's hash).
function sessionRoom(idHash) { return `session:${idHash}`; }

/**
 * @param {object} deps
 * @param {import('http').Server} deps.server
 * @param {object} deps.cors - the same CORS options as the HTTP API
 * @returns {import('socket.io').Server}
 */
function createSocketServer({ server, cors }) {
  return new Server(server, {
    cors
  });
}

// A browser opening a WebSocket from another site sends its Origin. Refuse
// origins that are not this server (Host / X-Forwarded-Host) or the
// configured FRONTEND_URL / BASE_URL, so another site cannot ride the login
// cookie. Clients without an Origin header (CLI, tests) still need the cookie.
function socketOriginAllowed(headers, env = process.env) {
  const origin = headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const allowed = new Set();
  for (const h of [headers.host, headers['x-forwarded-host']]) {
    if (typeof h === 'string') for (const part of h.split(',')) allowed.add(part.trim().toLowerCase());
  }
  for (const u of [env.FRONTEND_URL, env.BASE_URL]) {
    if (!u) continue;
    try { allowed.add(new URL(u).host.toLowerCase()); } catch {}
  }
  return allowed.has(host);
}

/**
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {NodeJS.ProcessEnv} deps.env - FRONTEND_URL / BASE_URL (allowed origins)
 * @param {{ isAvailable: () => boolean }} deps.db
 * @param {{ resolve: Function, getAccount: Function }} deps.userAuth
 * @param {{ enabled: boolean, recheckMs: number }} deps.oidc
 * @param {{ check: Function }|null} deps.oidcSessions - central login only
 * @param {() => ({ attach: Function }|null)} deps.getSocial - made in start()
 * @param {() => ({ attach: Function }|null)} deps.getListenAlong - made in start()
 * @param {{ register: Function }} deps.playlistSockets - playlistSockets.createPlaylistSockets()
 * @param {{ register: Function }} deps.queueSockets - queueSockets.createQueueSockets()
 */
function attachSocketHandlers({ io, env, db, userAuth, oidc: OIDC, oidcSessions, getSocial, getListenAlong, playlistSockets, queueSockets }) {
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
      console.error('Socket account lookup failed:', err.message);
      next(new Error('Could not check your account, try again'));
    });
  });

  // Central login: sockets live for hours, so their sessions are re-checked on
  // a timer too (oidcSessions.check refreshes only when due). A session that
  // ends takes its sockets with it (oidcSessions' onEnded, index.js).
  if (OIDC.enabled) {
    const SOCKET_CHECK_MS = Math.max(5_000, Math.min(60_000, OIDC.recheckMs));
    setInterval(() => {
      const ids = new Set();
      for (const s of io.sockets.sockets.values()) if (s.data.sessionId) ids.add(s.data.sessionId);
      for (const id of ids) {
        oidcSessions.check(id).then((live) => {
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
    const userId = socket.data.userId;

    // Global chat + people panel (presence, now playing): see social.js.
    const social = getSocial();
    if (social) social.attach(socket);
    // Listen along with another user (follows their now-playing): listenAlong.js.
    const listenAlong = getListenAlong();
    if (listenAlong) listenAlong.attach(socket);

    // The account as it is now (status changes apply without reconnecting;
    // userAuth caches lookups for a few seconds). null on error: fail closed.
    const currentAccount = () => userAuth.getAccount(userId).catch((err) => {
      console.error('Socket account lookup failed:', err.message);
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
    // client's name used, as social.js does.
    const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 30) : '');
    const cleanEmoji = (v) => (typeof v === 'string' && v ? v.slice(0, 10) : null);
    const displayName = async (clientName) => {
      const account = await currentAccount();
      if (db.isAvailable()) return (account && account.name ? cleanName(account.name) : '') || 'Anonymous';
      return cleanName(clientName) || 'Anonymous';
    };
    const displayEmoji = async (clientEmoji) => {
      if (!db.isAvailable()) return cleanEmoji(clientEmoji);
      const account = await currentAccount();
      return account ? cleanEmoji(account.emoji) : null;
    };
    const refusePending = (event = 'lobby:error') => {
      socket.emit(event, { message: 'Your account is pending approval', code: 'ACCOUNT_PENDING' });
    };

    // lobby:create / join / view / unview / leave / pin / rename, user:update,
    // listener:now-playing (playlistSockets.js). The playlist this socket is in.
    const playlist = playlistSockets.register(socket, { userId, isApproved, displayName, displayEmoji, refusePending });

    // queue:add / remove / restore / reorder / clear / get (queueSockets.js).
    queueSockets.register(socket, { userId, visibleLobby: playlist.visibleLobby, editableLobby: playlist.editableLobby, displayName });

    socket.on('disconnect', (reason) => {
      console.log(`Client disconnected: ${socket.id} (${reason})`);
      playlist.disconnected();
    });
  });
}

module.exports = { APP_ROOM, userRoom, sessionRoom, createSocketServer, socketOriginAllowed, attachSocketHandlers };
