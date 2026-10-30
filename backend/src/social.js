/**
 * The global chat and the people panel over Socket.IO.
 *
 * Who takes part: every socket whose signed listen_auth cookie names a user
 * (socket.data.userId, set in index.js from the handshake — never an id the
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
 *   people:listeners { userId, count }       how many listen along (listenAlong.js)
 *
 * person = { id, name, emoji, avatarUrl, pending, online, lastSeen, nowPlaying, listeners }
 * listeners = how many people listen along with them (a count, no names).
 */

const chat = require('./chat');
const { viewNowPlaying } = require('./presence');
const access = require('./playlistAccess');

const BLOCKED_STATUSES = new Set(['denied', 'rejected']);
const ROOM = 'social';
const userRoom = (id) => `user:${id}`;

function isEligible(status) {
  return !BLOCKED_STATUSES.has(status);
}

function cleanName(v) {
  return typeof v === 'string' ? v.trim().slice(0, 30) : '';
}

function safeAvatar(url) {
  if (typeof url !== 'string') return null;
  return /^https:\/\//i.test(url) ? url.slice(0, 1000) : null;
}

/**
 * @param io        Socket.IO server
 * @param db        db module (isAvailable/query)
 * @param presence  createPresence() instance
 * @param store     chat store (createPgStore / createMemoryStore)
 * @param getLobby  (lobbyId) -> lobby | undefined (in-memory lookup, sync)
 * @param isAdmin   (headers) -> boolean (admin cookie)
 * @param limiter   chat rate limiter (createRateLimiter)
 * @param listenerCount (userId) -> how many listen along with them
 */
function createSocial({ io, db, presence, store, getLobby, isAdmin, limiter = chat.createRateLimiter(), listenerCount = () => 0 }) {
  // userId -> { id, name, emoji, avatarUrl, status }
  const profiles = new Map();

  const dbOn = () => db && db.isAvailable();

  function profileFromRow(r) {
    return {
      id: String(r.id),
      name: r.display_name || r.name || r.username || 'User',
      emoji: r.emoji || null,
      avatarUrl: safeAvatar(r.avatar_url),
      status: r.status || 'approved',
    };
  }

  async function loadProfile(userId) {
    if (!dbOn()) {
      return profiles.get(userId) || { id: userId, name: 'User', emoji: null, avatarUrl: null, status: 'approved' };
    }
    const r = await db.query(
      'SELECT id, display_name, name, username, emoji, avatar_url, status, last_seen FROM users WHERE id::text = $1',
      [userId]
    );
    if (!r.rows.length) return null;
    presence.setLastSeen(userId, r.rows[0].last_seen);
    return profileFromRow(r.rows[0]);
  }

  async function persistLastSeen(userId, ms) {
    if (!dbOn()) return;
    try {
      await db.query('UPDATE users SET last_seen = $1 WHERE id::text = $2', [ms, userId]);
    } catch (err) {
      console.error('last_seen update failed:', err.message);
    }
  }

  // The playlist if `viewerId` may see it.
  const lobbyForViewer = (viewerId) => (lobbyId) => {
    const l = getLobby(lobbyId);
    return access.canView(l, viewerId) ? l : null;
  };

  function person(p, viewerId) {
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

  async function listPeople(viewerId) {
    let list;
    if (dbOn()) {
      const r = await db.query(
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
  function emitNowPlaying(userId) {
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

  function emitPresence(userId) {
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

  function attach(socket) {
    const userId = socket.data.userId;
    const headers = socket.request.headers || {};

    // Anonymous sockets get the handlers too, so they hear "Not signed in".
    const ready = (async () => {
      if (!userId) return false;
      let p;
      try { p = await loadProfile(userId); } catch (err) {
        console.error('Social profile load failed:', err.message);
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
    const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

    // Without a database there is no users table: take the display name the
    // client shows (the id still comes from the signed cookie).
    socket.on('social:hello', async ({ name, emoji } = {}) => {
      if (dbOn() || !(await ok())) return;
      const p = profiles.get(userId);
      const n = cleanName(name);
      if (!p || !n) return;
      p.name = n;
      p.emoji = typeof emoji === 'string' ? emoji.slice(0, 10) : p.emoji;
      io.to(ROOM).emit('people:user', { user: { ...person(p, null), nowPlaying: undefined } });
    });

    socket.on('people:list', async (_arg, ack) => {
      if (typeof _arg === 'function') { ack = _arg; }
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      try {
        reply(ack, { me: userId, isAdmin: !!isAdmin(headers), people: await listPeople(userId) });
      } catch (err) {
        console.error('People list failed:', err.message);
        reply(ack, { error: 'Could not load people' });
      }
    });

    socket.on('chat:history', async (arg, ack) => {
      if (typeof arg === 'function') { ack = arg; arg = {}; }
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      try {
        reply(ack, await store.page({ before: arg && arg.before, limit: arg && arg.limit }));
      } catch (err) {
        console.error('Chat history failed:', err.message);
        reply(ack, { error: 'Could not load messages' });
      }
    });

    socket.on('chat:send', async (arg, ack) => {
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      const { text, error } = chat.normalizeText(arg && arg.text);
      if (error) return reply(ack, { error });
      if (!limiter.hit(userId)) return reply(ack, { error: 'You are sending messages too fast. Wait a few seconds.' });
      try {
        const p = profiles.get(userId) || {};
        const message = await store.add({ userId, author: p, text, createdAt: Date.now() });
        io.to(ROOM).emit('chat:message', message);
        reply(ack, { ok: true, message });
      } catch (err) {
        console.error('Chat send failed:', err.message);
        reply(ack, { error: 'Could not send the message' });
      }
    });

    socket.on('chat:delete', async (arg, ack) => {
      if (!(await ok())) return reply(ack, { error: 'Not signed in' });
      // Re-checked on every call: the admin cookie expires.
      if (!isAdmin(headers)) return reply(ack, { error: 'Only an admin can delete messages' });
      const removed = await deleteMessage(arg && arg.id);
      reply(ack, removed ? { ok: true } : { error: 'Message not found' });
    });

    socket.on('presence:now-playing', async (report) => {
      if (!(await ok())) return;
      // A playlist the reporter cannot see is never recorded.
      let r = report;
      if (r && r.context && r.context.type === 'lobby' && !access.canView(getLobby(r.context.lobbyId), userId)) {
        r = { ...r, context: null };
      }
      presence.setNowPlaying(userId, socket.id, r);
    });

    socket.on('disconnect', async () => {
      if (!(await ready)) return;
      presence.disconnect(userId, socket.id);
    });
  }

  async function deleteMessage(id) {
    let removed = false;
    try { removed = await store.remove(id); } catch (err) {
      console.error('Chat delete failed:', err.message);
      return false;
    }
    if (removed) io.to(ROOM).emit('chat:deleted', { id: Number(id) });
    return removed;
  }

  // A playlist was renamed, changed visibility or was deleted: everyone
  // playing from it gets a fresh (re-redacted) now-playing.
  function lobbyChanged(lobbyId) {
    for (const userId of presence.usersPlayingFromLobby(lobbyId)) emitNowPlaying(userId);
  }

  // Name/avatar/status changed (profile page, admin approve/reject).
  async function profileChanged(userId) {
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
  async function flushLastSeen() {
    const t = Date.now();
    await Promise.all(presence.onlineUserIds().map(u => persistLastSeen(u, t)));
  }

  // Display name of a user taking part (listen-along).
  const nameOf = (userId) => (profiles.get(userId) || {}).name || null;

  return { attach, listPeople, deleteMessage, lobbyChanged, profileChanged, flushLastSeen, nameOf, presence, store };
}

module.exports = { createSocial, isEligible };
