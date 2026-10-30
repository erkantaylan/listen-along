/**
 * Listen along (Spotify-style): follow a USER, not a playlist. The follower's
 * player plays whatever the person they listen along with plays — same song,
 * same position, live — wherever it comes from (public, private playlist or
 * the library). The follower only ever learns the song, never the playlist.
 *
 * Model (all in memory, keyed by users.id from the authenticated socket):
 *
 *   chose:  follower -> the user they picked (or were re-pointed to)
 *   socket: follower -> the one socket (browser tab) that plays along
 *
 * `chose` is a forest (cycles are refused). Everybody hears the ROOT of their
 * chain: walk `chose` until a user who follows nobody. So chains collapse by
 * construction — if A picked B and B picked C, A and B both hear C, and C is
 * told "B and A are listening along". When B stops listening along (touches
 * their own playback), A keeps the choice "B" and now hears B (who is a root
 * again). When B's socket disconnects instead (tab closed / reload), B is
 * spliced out: A is re-pointed to whomever B had picked, so A keeps hearing
 * the same music.
 *
 * Root's now-playing (presence.js) is the source of truth: every change goes
 * to each follower socket as `listen:sync` with the server timestamp of the
 * report, so the follower computes the target position itself.
 *
 * Root stops playback (now-playing cleared while still online): followers get
 * a sync with track null and pause; they stay attached and resume when the
 * root plays again. Root closes its last tab: nothing is sent until presence
 * says 'offline' (after the grace period, so a reload does not end anything);
 * then every follower of that root gets `listen:end` { reason: 'offline' }:
 * the song that is playing finishes, then playback stops — and their
 * listen-along ends (the whole tree under that root is dissolved).
 *
 * Client -> server (sockets of approved accounts only)
 *   listen:follow { userId } (ack) -> { ok, leader, chosen, sync } | { error }
 *   listen:stop   (ack) -> { ok }
 * Server -> client
 *   listen:following { leader: { id, name } | null, chosen, reason }  follower's socket
 *   listen:sync      { leaderId, track, playing, position, duration, updatedAt, serverNow }
 *   listen:end       { reason: 'offline', leader }                   follower's socket
 *   listen:followers { count, names }                                every socket of a root
 *
 * track (sync) = { title, artist, thumbnail, libraryId, src } | null; src is
 * null when the song cannot be resolved to a library file (the follower
 * shows a notice and waits for the next song).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAMES = 3;

/** Pure follow graph (unit tested on its own). */
function createListenGraph() {
  const chose = new Map();   // follower -> chosen user
  const sockets = new Map(); // follower -> socketId

  function root(u) {
    let cur = u;
    const seen = new Set();
    while (chose.has(cur) && !seen.has(cur)) { seen.add(cur); cur = chose.get(cur); }
    return cur;
  }

  /** follower -> root for everyone listening along. */
  function snapshot() {
    const m = new Map();
    for (const f of chose.keys()) m.set(f, root(f));
    return m;
  }

  return {
    root,
    snapshot,
    chosen: (u) => chose.get(u) || null,
    socketOf: (u) => sockets.get(u) || null,
    isFollowing: (u) => chose.has(u),
    followersOf(r) {
      const out = [];
      for (const f of chose.keys()) if (root(f) === r) out.push(f);
      return out;
    },
    /** Users whose follow lives in this socket. */
    usersOnSocket(socketId) {
      return [...sockets.entries()].filter(([, s]) => s === socketId).map(([u]) => u);
    },

    /** `follower` picks `leader`. Returns { ok, root } | { error }. */
    follow(follower, leader, socketId) {
      if (!follower || !leader) return { error: 'invalid' };
      if (follower === leader) return { error: 'self' };
      // Picking someone whose chain leads back to you would be a loop.
      if (root(leader) === follower) return { error: 'cycle' };
      chose.set(follower, leader);
      sockets.set(follower, socketId);
      return { ok: true, root: root(follower) };
    },

    /** Stop listening along. Those who picked `u` keep that choice (u is a root now). */
    unfollow(u) {
      sockets.delete(u);
      return chose.delete(u);
    },

    /** `u`'s tab went away: re-point those who picked u to u's own choice. */
    splice(u) {
      const up = chose.get(u);
      if (up === undefined) return false;
      for (const [f, c] of chose) if (c === u) chose.set(f, up);
      chose.delete(u);
      sockets.delete(u);
      return true;
    },

    /** Dissolve everyone under root `r` (r went offline). Returns those users. */
    endTree(r) {
      const gone = [];
      for (const f of [...chose.keys()]) if (root(f) === r) gone.push(f);
      for (const f of gone) { chose.delete(f); sockets.delete(f); }
      return gone;
    },
  };
}

/** `library:<uuid>` resolves without a database; anything else via `lookup`. */
function createSourceResolver(lookup) {
  const cache = new Map();
  return async function resolveSource(url) {
    if (typeof url !== 'string' || !url) return null;
    if (url.startsWith('library:')) {
      const id = url.slice('library:'.length);
      return UUID_RE.test(id) ? id : null;
    }
    if (cache.has(url)) return cache.get(url);
    let id = null;
    try { id = lookup ? await lookup(url) : null; } catch { id = null; }
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    if (id) cache.set(url, id);
    return id;
  };
}

/**
 * @param io          Socket.IO server
 * @param presence    createPresence() instance
 * @param nameOf      (userId) -> display name
 * @param isApproved  async (userId) -> boolean (only approved accounts play)
 * @param resolveSource async (url) -> library song id | null
 * @param now         clock (tests)
 */
function createListenAlong({ io, presence, nameOf = () => 'User', isApproved = async () => true, resolveSource = createSourceResolver(null), now = Date.now }) {
  const graph = createListenGraph();
  const userRoom = (id) => `user:${id}`;
  const seq = new Map(); // root -> counter, drops stale async syncs

  const person = (id) => (id ? { id, name: nameOf(id) || 'User' } : null);

  function followersPayload(r) {
    const ids = graph.followersOf(r);
    return { count: ids.length, names: ids.slice(0, MAX_NAMES).map(id => nameOf(id) || 'User') };
  }

  async function buildSync(r) {
    const entry = presence.getNowPlaying(r);
    if (!entry) return { leaderId: r, track: null, playing: false, position: 0, duration: 0, updatedAt: now(), serverNow: now() };
    const libraryId = await resolveSource(entry.source);
    // Re-read: the position anchor must be the latest report.
    const e = presence.getNowPlaying(r) || entry;
    return {
      leaderId: r,
      track: {
        title: e.track.title,
        artist: e.track.artist,
        thumbnail: e.track.thumbnail,
        libraryId: libraryId || null,
        src: libraryId ? `/api/library/${encodeURIComponent(libraryId)}/file` : null,
      },
      playing: e.playing,
      position: e.position,
      duration: e.duration,
      updatedAt: e.updatedAt,
      serverNow: now(),
    };
  }

  function emitTo(userId, event, payload) {
    const s = graph.socketOf(userId);
    if (s) io.to(s).emit(event, payload);
  }

  async function syncFollowers(r, only = null) {
    const n = (seq.get(r) || 0) + 1;
    seq.set(r, n);
    const targets = only || graph.followersOf(r);
    if (!targets.length) return;
    const payload = await buildSync(r);
    if (seq.get(r) !== n && !only) return; // a newer report is on its way
    for (const f of targets) if (graph.root(f) === r) emitTo(f, 'listen:sync', payload);
  }

  // After any change: tell followers whose root moved, roots whose set changed.
  function reconcile(before, { reason = 'changed', skip = new Set() } = {}) {
    const after = graph.snapshot();
    const roots = new Set();
    for (const [f, r] of after) {
      if (before.get(f) !== r) {
        roots.add(r);
        if (before.has(f)) roots.add(before.get(f));
        if (!skip.has(f)) {
          emitTo(f, 'listen:following', { leader: person(r), chosen: graph.chosen(f), reason });
          syncFollowers(r, [f]);
        }
      }
    }
    for (const [f, r] of before) if (!after.has(f)) roots.add(r);
    for (const r of roots) io.to(userRoom(r)).emit('listen:followers', followersPayload(r));
  }

  presence.on('now-playing', (userId, entry) => {
    if (!graph.followersOf(userId).length) return;
    // The root's playing tab closed and it has no other: wait for 'offline'
    // (after the grace period) instead of pausing everyone mid-song.
    if (!entry && presence.socketIds(userId).length === 0) return;
    syncFollowers(userId);
  });

  // follower -> socket, kept here too: endTree drops the graph's copy before
  // 'offline' tells those sockets.
  const lastSockets = new Map();

  presence.on('offline', (userId) => {
    // A follower going offline already left on its socket's disconnect.
    const gone = graph.endTree(userId);
    if (!gone.length) return;
    for (const f of gone) {
      const socketId = lastSockets.get(f);
      if (socketId) io.to(socketId).emit('listen:end', { reason: 'offline', leader: person(userId) });
      lastSockets.delete(f);
    }
    io.to(userRoom(userId)).emit('listen:followers', followersPayload(userId));
  });

  function attach(socket) {
    const userId = socket.data.userId;
    const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
    const ready = socket.data.socialReady || Promise.resolve(!!userId);

    // A root that reloads still sees who listens along.
    ready.then((ok) => {
      if (ok && userId && graph.followersOf(userId).length) socket.emit('listen:followers', followersPayload(userId));
    });

    socket.on('listen:follow', async (arg, ack) => {
      if (typeof arg === 'function') { ack = arg; arg = {}; }
      if (!userId || !(await ready) || !(await isApproved(userId))) return reply(ack, { error: 'Not signed in' });
      const target = arg && typeof arg.userId === 'string' ? arg.userId.slice(0, 64) : '';
      if (!target || !presence.isOnline(target)) return reply(ack, { error: 'They are not online' });
      if (target === userId) return reply(ack, { error: 'You cannot listen along with yourself' });
      const r = graph.root(target);
      if (r === userId) return reply(ack, { error: 'They are already listening along with you' });
      if (!presence.getNowPlaying(r)) return reply(ack, { error: 'They are not playing anything' });
      const before = graph.snapshot();
      const res = graph.follow(userId, target, socket.id);
      if (res.error) return reply(ack, { error: 'Cannot listen along with them' });
      lastSockets.set(userId, socket.id);
      // Whoever was listening along with this user now hears the new root.
      reconcile(before, { reason: 'changed', skip: new Set([userId]) });
      reply(ack, { ok: true, leader: person(res.root), chosen: target, sync: await buildSync(res.root) });
    });

    socket.on('listen:stop', async (arg, ack) => {
      if (typeof arg === 'function') ack = arg;
      if (!userId || graph.socketOf(userId) !== socket.id) return reply(ack, { ok: true });
      const before = graph.snapshot();
      graph.unfollow(userId);
      lastSockets.delete(userId);
      reconcile(before, { reason: 'stopped' });
      reply(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      for (const u of graph.usersOnSocket(socket.id)) {
        const before = graph.snapshot();
        graph.splice(u);
        lastSockets.delete(u);
        reconcile(before, { reason: 'left' });
      }
    });
  }

  return { attach, graph, followersPayload };
}

module.exports = { createListenAlong, createListenGraph, createSourceResolver };
