require('./logger'); // timestamp + level on all console output — must be first
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ytdlp = require('./ytdlp');
const lobby = require('./lobby');
const { getQueue, getQueueAsync, deleteQueue, hasQueue } = require('./queue');
const db = require('./db');
const library = require('./library');
const songRequests = require('./requests');
const { createLibraryRouter, sendSongFile } = require('./libraryRoutes');
const { createTokenRouter } = require('./tokenRoutes');
const tokens = require('./tokens');
const clientIpSetup = require('./clientIp');
const adminAuth = require('./adminAuth');
const { apiLimiter, make: makeLimiter } = require('./rateLimits');
const { readOidcConfig } = require('./oidcConfig');
const { createOidcClient } = require('./oidc');
const { createSessionStore, createOidcSessions } = require('./oidcSessions');
const { createSettings, parseRegistrationsDefault } = require('./settings');
const { createResolver } = require('./songResolver');
const { createPicker, cleanPicks } = require('./picker');
const covers = require('./covers');
const access = require('./playlistAccess');
const playlistPins = require('./playlistPins');
const spotify = require('./spotify');
const { createAppRelease } = require('./appRelease');
const { createCliRelease, createCliRouter } = require('./cliRelease');
const { createUserAuth, isBlocked } = require('./userAuth');
const { readDevLogin } = require('./devLogin');
const chat = require('./chat');
const { createPresence } = require('./presence');
const { createSocial } = require('./social');
const { createListenAlong, createSourceResolver } = require('./listenAlong');
const downloadJobs = require('./downloadJobs');
const { createWorkerHub } = require('./workerHub');
const { createJobRouter } = require('./jobRoutes');
const { createActivityFeed } = require('./activityFeed');
const { createStationRouter } = require('./stations');
const { createArtistRouter } = require('./artists');
const { createInfoRouter, createPageRouter } = require('./appRoutes');
const { createMediaRouter } = require('./mediaRoutes');
const { createProfileRouter } = require('./profileRoutes');
const { createAdminRouter } = require('./adminRoutes');
const { createAuthRoutes } = require('./authRoutes');
const { createPlaylistRoutes } = require('./playlistRoutes');
// The web's "pick the video" dialog (picker.js): lookups for it, and what they
// said about each video, for the title of a chosen one.
const picker = createPicker();
const resolver = createResolver({ videoTitles: picker.titles });

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// Simple in-memory rate limiter
const rateLimitMap = new Map(); // key: IP, value: { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests per minute

// Songs removed from a queue in the last minute, so the remover can undo
// (queue:restore). key: `${lobbyId}:${songId}` -> { song, index, at }.
const removedSongs = new Map();
const REMOVED_SONG_TTL = 60 * 1000;
function stashRemovedSong(lobbyId, song, index) {
  const now = Date.now();
  for (const [k, v] of removedSongs) if (now - v.at > REMOVED_SONG_TTL) removedSongs.delete(k);
  removedSongs.set(`${lobbyId}:${song.id}`, { song, index, at: now });
}

function rateLimit(req, res, next) {
  const ip = req.clientIp || req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }

  record.count++;
  next();
}


const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Sign-in, fixed at boot. Central login (OIDC, see oidcConfig.js) is the only
// one in production and is required there. Local development and the tests may
// use the dev sign-in instead (INSECURE_DEV_LOGIN=1, devLogin.js), which is
// refused unless NODE_ENV is development or test. A missing, half or broken
// configuration, or no sign-in at all, stops the server here, on purpose.
let OIDC;
let DEV_LOGIN;
let REGISTRATIONS_DEFAULT_OPEN;
try {
  DEV_LOGIN = readDevLogin(process.env);
} catch (err) {
  console.error(`[auth] ${err.message}`);
  process.exit(1);
}
try {
  OIDC = readOidcConfig(process.env);
  // Registrations before an admin has saved the switch (settings.js).
  REGISTRATIONS_DEFAULT_OPEN = parseRegistrationsDefault(process.env);
} catch (err) {
  console.error(`[oidc] ${err.message}`);
  process.exit(1);
}
if (!OIDC.enabled && !DEV_LOGIN) {
  console.error('[auth] no sign-in configured: set OIDC_ISSUER, OIDC_CLIENT_ID, BASE_URL (or FRONTEND_URL) and SESSION_SECRET (central login, CENTRAL-LOGIN.md), or for local development only INSECURE_DEV_LOGIN=1 with NODE_ENV=development');
  process.exit(1);
}
if (DEV_LOGIN) console.warn('[auth] INSECURE_DEV_LOGIN is on: anyone can sign in as anyone at /auth/dev/login. Development and tests only.');

// DATABASE_URL set but no pool = an outage: central login then fails closed
// (no in-memory users or sessions; those are for the no-database dev mode).
const DB_EXPECTED = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
const settings = createSettings({ db, dbExpected: DB_EXPECTED, defaults: { registrations_open: REGISTRATIONS_DEFAULT_OPEN } });
const oidcClient = OIDC.enabled ? createOidcClient(OIDC, { secret: SESSION_SECRET }) : null;
const sessionStore = OIDC.enabled ? createSessionStore({ db, secret: SESSION_SECRET, dbExpected: DB_EXPECTED }) : null;
const oidcSessions = OIDC.enabled ? createOidcSessions({
  store: sessionStore,
  client: oidcClient,
  cfg: OIDC,
  cookieName: OIDC.sessionCookie,
  // A session ended by a re-check (the IdP refused, expired, unverified too
  // long): its sockets go too.
  onEnded: (idHash) => io.in(sessionRoom(idHash)).disconnectSockets(true),
}) : null;

// Who is calling: the la_session server-side session (central login) or the
// signed la_dev_login cookie (dev sign-in) + the account's status
// (approved / pending / denied). See userAuth.js for the levels.
const userAuth = createUserAuth({ secret: SESSION_SECRET, db, sessions: oidcSessions, devLogin: DEV_LOGIN });

const app = express();
const server = http.createServer(app);

// Behind Cloudflare -> Traefik: trust the private proxy hop and take the
// visitor's IP from CF-Connecting-IP only when the request really came from
// Cloudflare. Sets req.clientIp, which the rate limits key on. See clientIp.js.
const clientIpOf = clientIpSetup.install(app);

// CORS configuration
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// HTTP request logging — one concise line per dynamic request with status +
// duration, a SLOW tag for anything over 5s, and a PENDING warning for requests
// still running after 15s. The PENDING warning is the key diagnostic: a request
// that hangs (yt-dlp/db/upstream stall) otherwise surfaces only as a proxy 504
// with nothing in our own logs. Static assets are skipped to keep signal high.
const STATIC_ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map)$/i;
app.use((req, res, next) => {
  if (STATIC_ASSET_RE.test(req.path)) return next();
  const start = Date.now();
  let logged = false;
  const pending = setTimeout(() => {
    console.warn(`[http] PENDING ${req.method} ${req.path === '/auth/oidc/callback' ? req.path : req.originalUrl} still running after 15s`);
  }, 15000);
  const finish = (aborted) => {
    if (logged) return;
    logged = true;
    clearTimeout(pending);
    const ms = Date.now() - start;
    const status = aborted ? 'ABORTED' : res.statusCode;
    const slow = ms > 5000 ? ' SLOW' : '';
    // The central login's callback carries a one-time code: not in the log.
    const shownUrl = req.path === '/auth/oidc/callback' ? `${req.path}?…` : req.originalUrl;
    const line = `[http] ${req.method} ${shownUrl} ${status} ${ms}ms${slow}`;
    if (aborted || res.statusCode >= 500 || ms > 5000) console.warn(line);
    else console.log(line);
  };
  res.on('finish', () => finish(false));
  res.on('close', () => { if (!res.writableEnded) finish(true); });
  next();
});

if (!process.env.SESSION_SECRET) {
  console.log('Warning: SESSION_SECRET not set, using random secret (logins will not survive a restart)');
}

// Serve static frontend files
// In Docker: /app/src/index.js -> /app/frontend (../frontend)
// Local dev: backend/src/index.js -> frontend (../../frontend)
const frontendPath = path.resolve(process.env.FRONTEND_PATH || path.join(__dirname, '../frontend'));

// Static assets (scripts, styles, icons, locales) are public: they hold no
// data. `index: false` so "/" goes through the auth guard below instead of
// express.static answering it with index.html. Compiled TypeScript in
// <frontend>/dist is served first, at the same URLs (frontendStatic.js).
app.use(require('./frontendStatic').frontendStatic(frontendPath));

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions
});

// Rooms: APP_ROOM holds every socket of an approved account (library /
// requests broadcasts); userRoom(id) every socket of one account (so a
// denied account can be disconnected everywhere).
const APP_ROOM = 'app';
const userRoom = (id) => `user:${id}`;
// Central login: every socket of one session (keyed by the session id's hash).
function sessionRoom(idHash) { return `session:${idHash}`; }

// Sign-in over HTTP (authRoutes.js): the guard here, before every route; the
// legacy status checks and the sign-in / sign-out routes further down.
const auth = createAuthRoutes({
  oidc: OIDC, devLogin: DEV_LOGIN, sessionSecret: SESSION_SECRET, dbExpected: DB_EXPECTED, env: process.env, frontendPath,
  db, settings, userAuth, oidcClient, sessionStore, oidcSessions, tokens, apiLimiter, makeLimiter, io, sessionRoom,
});
app.use(auth.guard);


// Health, build info, changelog, the playlist QR code (appRoutes.js). Before
// the library router: its router.use(apiLimiter) counts everything after it.
app.use(createInfoRouter({ db, ytdlp, frontendPath }));

// Legacy status checks: POST /api/auth/register, GET /api/auth/status (authRoutes.js).
app.use(auth.statusRouter);

// Download workers (`la worker` on users' machines) and their jobs: see
// workerHub.js (WebSocket, routing), downloadJobs.js (store), jobRoutes.js
// (HTTP API). Live job status goes to the requester's sockets (jobs:update),
// worker counts to every approved socket (workers:update), and a reduced
// view of every job to every approved socket (activityFeed.js).
function upgradeIp(req) {
  try {
    // The upgrade request skips Express: apply the same trust-proxy rule.
    req.ip = require('proxy-addr')(req, app.get('trust proxy fn'));
  } catch {}
  return clientIpOf(req);
}
function emitJob(row) {
  if (!row) return;
  // Everyone's activity log (activityFeed.js), then the requester's own, richer view.
  activityFeed.jobChanged(row);
  if (!row.requested_by_user_id) return;
  io.to(userRoom(row.requested_by_user_id)).emit('jobs:update', { job: downloadJobs.toPublic(row), workers: workerHub.stats() });
}
// A web download job targets a playlist: add what it got (as the requester,
// if they can still edit it). Song-request jobs need nothing here: the
// request flow (handleLibrarySongAdded) adds to the requesting playlist.
async function addJobSongsToPlaylist(job, songs) {
  if (!job || job.source !== 'web' || !job.playlist_id || !db.isAvailable()) return;
  const l = await lobby.getLobbyAsync(job.playlist_id);
  if (!l || !access.canEdit(l, job.requested_by_user_id)) return;
  let added = 0;
  for (const song of songs) {
    if (!song) continue;
    if (await addLibrarySongToLobby(job.playlist_id, song, job.requested_by || 'Someone', { skipIfQueued: true })) added++;
  }
  if (added) {
    const queue = await getQueueAsync(job.playlist_id);
    io.to(job.playlist_id).emit('queue:update', { lobbyId: job.playlist_id, songs: queue.getSongs() });
  }
}
// The la CLI this image ships (cli/): offered to workers in the welcome and
// through /api/cli/latest|bundle so they update themselves (cliRelease.js).
const cliRelease = createCliRelease();
cliRelease.load();
app.use(createCliRouter({ release: cliRelease, requireToken: tokens.requireToken, limiter: apiLimiter }));
let workersChangedTimer = null;
const workerHub = createWorkerHub({
  cliLatest: () => cliRelease.latest(),
  verifyToken: (token) => tokens.verifyToken(token),
  ipOf: upgradeIp,
  dbAvailable: () => db.isAvailable(),
  onJobUpdated: emitJob,
  onJobFinished: (job, songIds) => {
    Promise.all(songIds.map((id) => library.getById(id).catch(() => null)))
      .then((songs) => addJobSongsToPlaylist(job, songs))
      .catch((err) => console.error('[jobs] playlist add failed:', err.message));
  },
  onWorkersChanged: () => {
    // Coalesce bursts (connect + dispatch + finish).
    if (workersChangedTimer) return;
    workersChangedTimer = setTimeout(() => {
      workersChangedTimer = null;
      io.to(APP_ROOM).emit('workers:update', workerHub.stats());
    }, 200);
  },
});
workerHub.attach(server);

// A song request was created: it becomes a download job (automatic).
async function queueRequestJob(request, requestedByUserId) {
  try {
    const row = await downloadJobs.createForRequest(request, { requestedByUserId });
    if (!row) return;
    emitJob(row);
    workerHub.dispatch();
  } catch (err) {
    console.error('[jobs] could not queue a job for request', request && request.id, err.message);
  }
}

// Music library, song requests, CLI tokens and admin API (see libraryRoutes.js)
app.use(createLibraryRouter({
  onJobUpload: (job, song) => { addJobSongsToPlaylist(job, [song]).catch(err => console.error('[jobs] playlist add failed:', err.message)); },
  onRequestDismissed: (request) => {
    downloadJobs.cancelForRequest(request.id).then((rows) => rows.forEach(emitJob)).catch(() => {});
  },
  onSongAdded: (song, fulfilled) => { handleLibrarySongAdded(song, fulfilled).catch(err => console.error('[library] post-upload handling failed:', err)); },
  onRequestsChanged: () => io.to(APP_ROOM).emit('requests:updated'),
  onSongRemoved: (song) => {
    io.to(APP_ROOM).emit('library:updated', { removed: song.id });
    downloadJobs.failReplaceJobsForSong(song.id).then((rows) => rows.forEach(emitJob)).catch(() => {});
  },
  // Marked / unmarked broken, or reports dismissed: badges everywhere refresh.
  onReportsChanged: (songId) => io.to(APP_ROOM).emit('library:updated', { reports: { id: songId } }),
  onSongReplaced: (song, previous) => { handleLibrarySongReplaced(song, previous).catch(err => console.error('[library] post-replace handling failed:', err)); },
  onSongDetailsChanged: (song, previous) => { handleLibrarySongDetailsChanged(song, previous).catch(err => console.error('[library] post-edit handling failed:', err)); },
  onJobUpdated: emitJob,
  loginRateLimit: rateLimit,
  // Library / requests reads from the web app: an approved account.
  requireWebUser: userAuth.requireLevel('approved')
}));

// Radio stations (stations.js). Approved accounts only, by the guard's default.
app.use(createStationRouter());

// Artists: read-only song lists per library artist (artists.js). Approved accounts only, by the guard's default.
app.use(createArtistRouter());

// The caller's own CLI tokens (profile page). Approved accounts only.
app.use(createTokenRouter({
  requireUser: (req, res, next) => userAuth.requireLevel('approved')(req, res, () => {
    req.account = req._listenAuth.account;
    next();
  }),
}));

// Download jobs, workers, profile activity (jobRoutes.js).
const withAccount = (level) => (req, res, next) => userAuth.requireLevel(level)(req, res, () => {
  req.account = req._listenAuth.account;
  next();
});
app.use(createJobRouter({
  requireUser: withAccount('approved'),
  requireMember: withAccount('member'),
  hub: workerHub,
  cliLatest: () => cliRelease.latest(),
  editablePlaylist: async (playlistId, userId) => {
    const l = await lobby.getLobbyAsync(playlistId);
    return access.canEdit(l, userId) ? l : null;
  },
  spotifyTrack: (url) => spotify.getTrack(url),
  addSongToPlaylist: async (playlistId, song, addedBy, { allowDuplicates = false } = {}) => {
    const entry = await addLibrarySongToLobby(playlistId, song, addedBy, { skipIfQueued: !allowDuplicates });
    if (!entry) return false;
    const queue = await getQueueAsync(playlistId);
    io.to(playlistId).emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
    return true;
  },
  visiblePlaylist: async (playlistId, userId) => {
    const l = await lobby.getLobbyAsync(playlistId);
    return access.canView(l, userId) ? l : null;
  },
  onJobUpdated: emitJob,
  picker,
}));

// The latest Android release for the /app page (appRelease.js).
const appRelease = createAppRelease(process.env.APP_RELEASES_API_URL ? { apiUrl: process.env.APP_RELEASES_API_URL } : {});
// Redirects, SPA views, the Android release, the dashboard shell, "/" (appRoutes.js).
app.use(createPageRouter({ frontendPath, apiLimiter, adminAuth, appRelease }));

// Audio for queue entries and their covers (mediaRoutes.js).
app.use(createMediaRouter({ db, library, covers, apiLimiter, sendSongFile }));

// Playlists over HTTP, songs included (playlistRoutes.js).
const { router: playlistRouter, ownerNames } = createPlaylistRoutes({
  io, db, lobby, getQueueAsync, library, playlistPins, userAuth, adminAuth, getSocial: () => social, userRoom,
  notifyPlaylistsChanged, destroyLobby, addLibrarySongToLobby,
});
app.use(playlistRouter);

// Sidebars refetch /api/playlists on this signal. It carries nothing, and a
// private playlist's changes only reach its owner. `everyone`: the playlist
// just changed visibility, so others gain or lose it.
function notifyPlaylistsChanged(l, { everyone = false } = {}) {
  if (!everyone && l && access.isPrivate(l) && l.ownerId) io.to(userRoom(l.ownerId)).emit('playlists:changed');
  else io.to(APP_ROOM).emit('playlists:changed');
}



// Central login / dev sign-in round trips, /api/auth/me, logout, the login
// page and /api/auth/providers (authRoutes.js).
app.use(auth.router);

// An admin changed an account's status: forget the cached status at once, and
// a denied / rejected account loses its open sockets (the handshake refuses
// new ones) and, with central login, every session (so it is signed out
// everywhere; signing in again is refused while it stays blocked). Its CLI
// tokens stop by themselves (tokens.verifyToken needs an approved owner).
async function accountStatusChanged(userId, status) {
  userAuth.invalidate(userId);
  if (social) social.profileChanged(String(userId));
  if (!isBlocked(status)) return;
  io.in(userRoom(String(userId))).disconnectSockets(true);
  if (sessionStore) {
    try {
      const gone = await sessionStore.removeForUser(String(userId));
      for (const h of gone) io.in(sessionRoom(h)).disconnectSockets(true);
      if (gone.length) console.log(`[oidc] user ${userId} is ${status}: ${gone.length} session(s) ended`);
    } catch (err) {
      // Still locked out: every request checks the status.
      console.error(`[oidc] could not end the sessions of user ${userId}:`, err.message);
    }
  }
}

// Tear down a lobby everywhere: notify + disconnect members, clear
// queue state, then delete the row from BOTH memory and the DB.
// Shared by the admin (dashboard) and creator delete paths. Uses the async
// delete so the row does not resurrect on restart (there is no longer any
// time-based cleanup to remove stale rows — hq-9gvy).
async function destroyLobby(lobbyId, { reason } = {}) {
  const before = await lobby.getLobbyAsync(lobbyId);
  io.to(lobbyId).emit('lobby:closed', {
    lobbyId,
    message: reason || 'This playlist has been deleted.'
  });
  const room = io.sockets.adapter.rooms.get(lobbyId);
  for (const socketId of room ? [...room] : []) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data.evict) s.data.evict(lobbyId);
  }
  io.in(lobbyId).socketsLeave(lobbyId);

  deleteQueue(lobbyId);

  await lobby.deleteLobbyAsync(lobbyId);
  playlistPins.forgetPlaylist(lobbyId);
  if (social) social.lobbyChanged(lobbyId);
  notifyPlaylistsChanged(before);
}

// ==========================================
// Library -> lobby queue glue
// ==========================================

// Append a library song to a lobby's queue. Caller broadcasts the queue:update.
// skipIfQueued: add nothing (returns null) when the song is already in the
// queue. Checked here, with no await before addSong, so two quick adds of the
// same song cannot both get through.
async function addLibrarySongToLobby(lobbyId, librarySong, addedBy, { skipIfQueued = false } = {}) {
  const queue = await getQueueAsync(lobbyId);
  if (skipIfQueued && library.isQueued(queue.getSongs(), librarySong)) return null;
  const entry = library.toQueueEntry(librarySong);
  const song = queue.addSong({ ...entry, artistName: library.queueArtist(librarySong), addedBy: addedBy || 'anonymous' });
  if (entry.thumbnail) {
    covers.cacheCover(song.id, entry.thumbnail).catch(err => {
      console.error(`Failed to cache cover for ${song.id}:`, err.message);
    });
  }
  return song;
}

// Tell a socket/room which queue entries are not playable (not in library).
async function emitUnavailableSongs(target, songs) {
  if (!db.isAvailable() || !songs || !songs.length) return;
  try {
    const missing = await library.findUnavailableUrls(songs.map(s => s.url));
    for (const url of missing) {
      target.emit('download:status', { url, status: 'unavailable', error: 'Not in the library yet' });
    }
  } catch (err) {
    console.error('Availability check failed:', err.message);
  }
}

// A song's audio (and metadata) was replaced under the same id. Queue entries
// keep pointing at it by url, which may change (a new youtube_id): rewrite
// every entry of every playlist that held the old song to the new url /
// title / duration / cover, then tell clients. Players that are playing it
// get library:updated { replaced } and reload the new file at the same
// position (frontend player.reloadReplaced).
async function handleLibrarySongReplaced(librarySong, previous) {
  const pub = library.toPublic(librarySong);
  const { entry, oldUrls, rewritten } = await rewriteQueueEntries(librarySong, previous, { covers: true });
  io.to(APP_ROOM).emit('library:updated', {
    song: pub,
    replaced: { id: librarySong.id, oldUrls, url: entry.url, file_version: pub.file_version },
  });
  for (const url of new Set([entry.url, librarySong.source_url].filter(Boolean))) {
    io.to(APP_ROOM).emit('download:status', { url, status: 'ready', percent: 100 });
  }
  if (rewritten) console.log(`[library] replaced ${librarySong.id}: rewrote ${rewritten} queue entr${rewritten === 1 ? 'y' : 'ies'}`);
}

// Only the title, artist or album changed: queue entries follow, and players
// update what they show without touching the audio (library:updated { details }).
async function handleLibrarySongDetailsChanged(librarySong, previous) {
  const { entry, oldUrls } = await rewriteQueueEntries(librarySong, previous, { covers: false });
  io.to(APP_ROOM).emit('library:updated', {
    song: library.toPublic(librarySong),
    details: { id: librarySong.id, oldUrls, url: entry.url },
  });
  // An active replace job keeps the song's details (library.updateDetails wrote
  // them): whoever shows the job gets the new ones.
  if (db.isAvailable()) {
    downloadJobs.activeReplaceJob(librarySong.id).then((row) => { if (row) emitJob(row); }).catch(() => {});
  }
}

// Every entry of every playlist holding the song gets its current url / title
// / duration / cover; viewers get queue:update.
async function rewriteQueueEntries(librarySong, previous, { covers: withCovers }) {
  const entry = library.toQueueEntry(librarySong);
  const oldUrls = [...new Set([library.queueUrlFor(previous), `library:${previous.id}`, previous.source_url].filter(Boolean))];
  // Queues already in memory, plus (below) any in the DB that hold the song.
  const lobbyIds = new Set(lobby.getAllLobbies().map(l => l.id).filter(id => hasQueue(id)));
  if (db.isAvailable()) {
    // Playlists not loaded in memory yet still have their queue in the DB.
    const ytId = previous.youtube_id || null;
    const r = await db.query(
      `SELECT DISTINCT lobby_id FROM queue_songs WHERE url = ANY($1::text[])
         OR ($2::text IS NOT NULL AND url LIKE '%' || $2 || '%')`,
      [oldUrls, ytId]
    ).catch(() => ({ rows: [] }));
    for (const row of r.rows) lobbyIds.add(row.lobby_id);
  }
  let rewritten = 0;
  for (const lobbyId of lobbyIds) {
    try {
      const queue = await getQueueAsync(lobbyId);
      const hits = queue.getSongs().filter(s => library.isQueued([s], previous));
      if (!hits.length) continue;
      for (const s of hits) {
        queue.updateSong(s.id, { ...entry, artistName: library.queueArtist(librarySong) });
        if (withCovers && entry.thumbnail) covers.cacheCover(s.id, entry.thumbnail).catch(() => {});
        rewritten++;
      }
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    } catch (err) {
      console.error(`[library] could not rewrite queue of ${lobbyId} after a change:`, err.message);
    }
  }
  return { entry, oldUrls, rewritten };
}

// A song was uploaded (or an upload hit an existing song that fulfils
// requests): refresh library views, mark matching queue entries playable, and
// add the song to the queue of every lobby that requested it.
async function handleLibrarySongAdded(librarySong, fulfilled = []) {
  const pub = library.toPublic(librarySong);
  io.to(APP_ROOM).emit('library:updated', { song: pub });
  // Waiting download jobs for these requests have nothing left to do.
  if (fulfilled.length && db.isAvailable()) {
    downloadJobs.settleForFulfilledRequests(fulfilled.map(r => r.id), librarySong)
      .then((rows) => rows.forEach(emitJob)).catch(() => {});
  }
  const urls = new Set([library.queueUrlFor(librarySong)]);
  if (librarySong.source_url) urls.add(librarySong.source_url);
  for (const url of urls) io.to(APP_ROOM).emit('download:status', { url, status: 'ready', percent: 100 });

  const byLobby = new Map();
  for (const r of fulfilled) {
    if (r.lobby_id && !byLobby.has(r.lobby_id)) byLobby.set(r.lobby_id, r);
  }
  for (const [lobbyId, request] of byLobby) {
    try {
      const lobbyData = await lobby.getLobbyAsync(lobbyId);
      if (!lobbyData) continue;
      const queue = await getQueueAsync(lobbyId);
      const alreadyQueued = queue.getSongs().some(s => urls.has(s.url));
      if (!alreadyQueued) {
        await addLibrarySongToLobby(lobbyId, librarySong, request.requested_by);
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      }
      io.to(lobbyId).emit('request:fulfilled', {
        request,
        song: pub,
        addedToQueue: !alreadyQueued,
        message: `"${pub.title}" is now in the library${alreadyQueued ? '' : ' and was added to the queue'} (requested by ${request.requested_by})`
      });
    } catch (err) {
      console.error(`[library] could not add fulfilled request to lobby ${lobbyId}:`, err.message);
    }
  }
}

// The caller's own profile (profileRoutes.js).
app.use(createProfileRouter({ db, userAuth, getSocial: () => social }));

// Dashboard APIs: users, statuses, settings, stats, playlist and chat
// moderation (adminRoutes.js). All behind adminAuth.requireAdmin.
app.use(createAdminRouter({
  db, lobby, getQueueAsync, library, settings, oidc: OIDC, apiLimiter, adminAuth,
  accountStatusChanged, destroyLobby, getSocial: () => social,
}));


// The downloads activity log, live (activityFeed.js; fed by emitJob above).
const activityFeed = createActivityFeed({
  io,
  room: APP_ROOM,
  userRoom,
  getPlaylist: (id) => lobby.getLobbyAsync(id),
  progressMs: process.env.ACTIVITY_PROGRESS_MS ? Number(process.env.ACTIVITY_PROGRESS_MS) : undefined,
});

// A browser opening a WebSocket from another site sends its Origin. Refuse
// origins that are not this server (Host / X-Forwarded-Host) or the
// configured FRONTEND_URL / BASE_URL, so another site cannot ride the login
// cookie. Clients without an Origin header (CLI, tests) still need the cookie.
function socketOriginAllowed(headers) {
  const origin = headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const allowed = new Set();
  for (const h of [headers.host, headers['x-forwarded-host']]) {
    if (typeof h === 'string') for (const part of h.split(',')) allowed.add(part.trim().toLowerCase());
  }
  for (const u of [process.env.FRONTEND_URL, process.env.BASE_URL]) {
    if (!u) continue;
    try { allowed.add(new URL(u).host.toLowerCase()); } catch {}
  }
  return allowed.has(host);
}

// Socket.IO handshake: only a logged-in account that is not denied / rejected may
// connect. Pending accounts connect for the global chat and people panel;
// every playlist/queue event checks for an approved account itself.
// Who the handshake is comes from userAuth.resolve(): the central-login
// session (la_session) or the dev sign-in cookie, the same as for HTTP.
// A central-login socket also joins its session's room, so ending that
// session (logout, a failed re-check, a ban) cuts it.
io.use((socket, next) => {
  const headers = socket.request.headers || {};
  if (!socketOriginAllowed(headers)) return next(new Error('Origin not allowed'));
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
// ends takes its sockets with it (onEnded above).
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
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  // A socket is a *member* of at most one lobby (currentLobby: listed as a
  // listener, now-playing) and may additionally *view* one other lobby
  // (viewingLobby: in its Socket.IO room for queue updates and adding
  // songs, but not listed). The web app keeps the member lobby on the one it
  // is playing from while the user browses other lobbies.
  let currentLobby = null;
  let viewingLobby = null;

  // Who this socket is: the users.id from the handshake's login cookie
  // (the central-login session, or the dev sign-in; set by io.use above; never
  // a client-supplied id).
  const userId = socket.data.userId;

  // Global chat + people panel (presence, now playing): see social.js.
  if (social) social.attach(socket);
  // Listen along with another user (follows their now-playing): listenAlong.js.
  if (listenAlong) listenAlong.attach(socket);

  // The playlist if this socket may see it, else null (callers answer as if
  // it did not exist, so private playlists cannot be probed).
  const visibleLobby = async (lobbyId) => {
    if (!lobbyId || typeof lobbyId !== 'string') return null;
    if (!(await isApproved())) return null;
    const l = await lobby.getLobbyAsync(lobbyId);
    return access.canView(l, userId) ? l : null;
  };
  // Mutations: the socket must be in the playlist's room and allowed to edit.
  const editableLobby = async (lobbyId) => {
    if (!verifyLobbyMembership(lobbyId)) return null;
    if (!(await isApproved())) return null;
    const l = await lobby.getLobbyAsync(lobbyId);
    return access.canEdit(l, userId) ? l : null;
  };
  const visibleTo = (l) => access.canView(l, userId);

  const stopViewing = () => {
    if (viewingLobby && viewingLobby !== currentLobby) socket.leave(viewingLobby);
    viewingLobby = null;
  };

  // The playlist was deleted or went private under this socket: drop it.
  socket.data.evict = (lobbyId) => {
    if (currentLobby === lobbyId) {
      handleLeave(socket, lobbyId);
      currentLobby = null;
    }
    if (viewingLobby === lobbyId) viewingLobby = null;
    socket.leave(lobbyId);
  };

  // lobby:joined + the queue for a lobby this socket is already in.
  const sendLobbyState = async (lobbyId, { viewing = false, user = null } = {}) => {
    const lobbyData = await lobby.getLobbyAsync(lobbyId);
    const names = lobbyData ? await ownerNames([lobbyData.ownerId]) : new Map();
    socket.emit('lobby:joined', {
      lobbyId,
      viewing,
      name: lobbyData ? lobbyData.name : null,
      pinned: lobbyData ? (lobbyData.pinned || false) : false,
      visibility: lobbyData ? lobbyData.visibility : 'public',
      ownerId: lobbyData ? lobbyData.ownerId : null,
      ownerName: lobbyData ? ((lobbyData.ownerId && names.get(lobbyData.ownerId)) || lobbyData.ownerName || null) : null,
      isOwner: access.isOwner(lobbyData, userId),
      canEdit: access.canEdit(lobbyData, userId),
      user,
      users: lobby.getLobbyUsers(lobbyId)
    });
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
    emitUnavailableSongs(socket, queue.getSongs());
  };

  // Per-socket rate limiting for expensive operations
  const socketRateLimit = { count: 0, resetTime: Date.now() + RATE_LIMIT_WINDOW };
  const checkSocketRateLimit = () => {
    const now = Date.now();
    if (now > socketRateLimit.resetTime) {
      socketRateLimit.count = 0;
      socketRateLimit.resetTime = now + RATE_LIMIT_WINDOW;
    }
    if (socketRateLimit.count >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }
    socketRateLimit.count++;
    return true;
  };

  // Verify socket is actually in the lobby before allowing operations
  const verifyLobbyMembership = (lobbyId) => {
    if (!lobbyId) return false;
    return socket.rooms.has(lobbyId);
  };

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

  // Create a playlist owned by this (logged-in) socket. visibility:
  // 'public' (default) or 'private'. asViewer: keep the current member lobby
  // (the one being played from) and only view the new one.
  socket.on('lobby:create', async ({ username, emoji, name, visibility, asViewer } = {}) => {
    if (!(await isApproved())) return refusePending();
    const shownName = await displayName(username);
    const shownEmoji = await displayEmoji(emoji);
    const vis = visibility === undefined ? 'public' : visibility;
    if (!lobby.VISIBILITIES.includes(vis)) {
      socket.emit('lobby:error', { message: "Visibility must be 'public' or 'private'" });
      return;
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (trimmedName.length > 50) {
      socket.emit('lobby:error', { message: 'Name must be 50 characters or less' });
      return;
    }
    if (trimmedName && lobby.isNameTaken(trimmedName, null, visibleTo)) {
      socket.emit('lobby:error', { message: 'A playlist with that name already exists' });
      return;
    }

    const newLobby = await lobby.createLobbyAsync(userId, null, trimmedName || null, vis, shownName);
    const viewOnly = !!asViewer && !!currentLobby;
    let user = null;
    stopViewing();
    if (viewOnly) {
      viewingLobby = newLobby.id;
    } else {
      if (currentLobby) handleLeave(socket, currentLobby);
      const result = await lobby.joinLobbyAsync(newLobby.id, socket.id, shownName, shownEmoji);
      user = result.user;
      currentLobby = newLobby.id;
    }
    socket.join(newLobby.id);

    notifyPlaylistsChanged(newLobby);
    socket.emit('lobby:created', {
      lobbyId: newLobby.id,
      viewing: viewOnly,
      name: newLobby.name,
      visibility: newLobby.visibility,
      ownerId: newLobby.ownerId,
      ownerName: newLobby.ownerName,
      isOwner: true,
      pinned: newLobby.pinned || false,
      user,
      users: lobby.getLobbyUsers(newLobby.id)
    });

    console.log(`Playlist ${newLobby.id} (${newLobby.visibility}) created by ${shownName}${newLobby.name ? ` name="${newLobby.name}"` : ''}`);
  });

  // Handle joining a lobby room (integrates with lobby system)
  socket.on('lobby:join', async ({ lobbyId, username, emoji } = {}) => {
    if (!(await isApproved())) return refusePending();

    // Missing and hidden (someone else's private) playlists look the same.
    const lobbyData = await visibleLobby(lobbyId);
    if (!lobbyData) {
      socket.emit('lobby:not-found', { lobbyId });
      return;
    }

    // Already a member (e.g. opening the page of the lobby being played
    // from): just resend its state, without leaving and re-adding.
    if (currentLobby === lobbyId && lobby.getLobbyUsers(lobbyId).some(u => u.socketId === socket.id)) {
      await sendLobbyState(lobbyId);
      return;
    }

    if (currentLobby) handleLeave(socket, currentLobby);
    if (viewingLobby === lobbyId) viewingLobby = null; // viewer becomes member

    const shownName = await displayName(username);
    const result = await lobby.joinLobbyAsync(lobbyId, socket.id, shownName, await displayEmoji(emoji));
    if (!result) {
      socket.emit('lobby:error', { message: 'Failed to join lobby' });
      return;
    }
    currentLobby = lobbyId;

    // Notify existing members BEFORE joining the room
    // This ensures the joining user cannot receive their own join notification
    socket.to(lobbyId).emit('lobby:user-joined', {
      lobbyId,
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Now join the Socket.IO room
    socket.join(lobbyId);

    // Send joined confirmation + the current queue to the user
    console.log(`User ${shownName} joined lobby ${lobbyId}`);
    await sendLobbyState(lobbyId, { user: result.user });
  });

  // Look at a lobby without becoming a member of it: join its room (queue,
  // listener updates; adding songs works) but stay listed in, and keep
  // now-playing in, the member lobby. Replaces any previous view.
  socket.on('lobby:view', async ({ lobbyId } = {}) => {
    if (!lobbyId) return;
    if (!(await isApproved())) return refusePending();
    const lobbyData = await visibleLobby(lobbyId);
    if (!lobbyData) {
      socket.emit('lobby:not-found', { lobbyId });
      return;
    }
    if (lobbyId === currentLobby) {
      stopViewing();
      await sendLobbyState(lobbyId);
      return;
    }
    if (viewingLobby !== lobbyId) {
      stopViewing();
      viewingLobby = lobbyId;
      socket.join(lobbyId);
    }
    await sendLobbyState(lobbyId, { viewing: true });
  });

  socket.on('lobby:unview', () => {
    stopViewing();
  });

  socket.on('lobby:leave', ({ lobbyId } = {}) => {
    if (lobbyId && lobbyId === viewingLobby) {
      stopViewing();
      return;
    }
    if (lobbyId) {
      handleLeave(socket, lobbyId);
    }
    currentLobby = null;
  });

  // Update user profile (name/emoji)
  // The name/emoji come from the account (the profile page saves them with
  // PUT /api/profile, then the client sends this); only without a database
  // is the client's own name taken.
  socket.on('user:update', async ({ lobbyId, username, emoji } = {}) => {
    if (lobbyId && lobbyId !== currentLobby) return;
    lobbyId = currentLobby;
    if (!lobbyId) return;
    if (!(await isApproved())) return;

    const user = lobby.updateUser(lobbyId, socket.id, { username: await displayName(username), emoji: await displayEmoji(emoji) });
    if (user) {
      // Broadcast updated user list to all in lobby
      io.to(lobbyId).emit('users:updated', {
        lobbyId,
        users: lobby.getLobbyUsers(lobbyId)
      });
    }
  });

  // Report what this listener is playing (shown next to queue items). Listening
  // along with a user is listenAlong.js (presence:now-playing).
  socket.on('listener:now-playing', async ({ lobbyId, track } = {}) => {
    if (lobbyId && lobbyId !== currentLobby) return;
    lobbyId = currentLobby;
    if (!lobbyId) return;
    if (!(await isApproved())) return;

    // Only a title and an https thumbnail, both bounded, reach other users.
    const clean = track && typeof track === 'object' ? {
      title: typeof track.title === 'string' ? track.title.slice(0, 300) : '',
      thumbnail: typeof track.thumbnail === 'string' && /^https:\/\//i.test(track.thumbnail) ? track.thumbnail.slice(0, 1000) : null
    } : null;
    track = clean;
    const user = lobby.setUserCurrentTrack(lobbyId, socket.id, track);
    if (user) {
      io.to(lobbyId).emit('users:updated', {
        lobbyId,
        users: lobby.getLobbyUsers(lobbyId)
      });
    }
  });

  // Pin/unpin lobby (make persistent)
  socket.on('lobby:pin', async ({ lobbyId, pinned } = {}) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const result = (await editableLobby(lobbyId)) ? await lobby.pinLobby(lobbyId, !!pinned) : null;
    if (!result) {
      socket.emit('lobby:error', { message: 'Playlist not found' });
      return;
    }

    // Broadcast pin state to all users in the lobby
    io.to(lobbyId).emit('lobby:pinned', {
      lobbyId,
      pinned: !!pinned
    });

    console.log(`Lobby ${lobbyId} ${pinned ? 'pinned' : 'unpinned'}`)
  });

  // Rename lobby
  socket.on('lobby:rename', async ({ lobbyId, name } = {}) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const l = await editableLobby(lobbyId);
    if (l && !access.canRename(l, userId, { admin: adminAuth.isAdmin({ headers: socket.handshake.headers }) })) {
      socket.emit('lobby:error', { message: 'Only the owner can rename' });
      return;
    }
    const result = l ? await lobby.renameLobby(lobbyId, name, visibleTo) : null;
    if (!result) {
      socket.emit('lobby:error', { message: 'Playlist not found' });
      return;
    }
    if (result.error) {
      socket.emit('lobby:error', { message: result.error });
      return;
    }

    // Broadcast rename to all users in the lobby
    io.to(lobbyId).emit('lobby:renamed', {
      lobbyId,
      name: result.lobby.name
    });
    if (social) social.lobbyChanged(lobbyId);
    notifyPlaylistsChanged(result.lobby);

    console.log(`Lobby ${lobbyId} renamed to "${result.lobby.name}"`);
  });

  // Add song to queue. Only songs in the library can be queued; anything else
  // becomes a song request (the server never downloads) that is auto-added to
  // this lobby's queue once someone uploads it with the CLI.
  // addedBy / requester come from the account, never from the client (only
  // without a database, where there are no accounts, is its name used).
  // picks: YouTube video ids chosen in the web's pick dialog (POST
  // /api/jobs/picks). Those exact videos are added or requested, with no
  // search; without it everything works as before (query / url / libraryId).
  socket.on('queue:add', async ({ lobbyId, query, url, title, libraryId, picks: rawPicks, addedBy: clientAddedBy } = {}) => {
    if (!checkSocketRateLimit()) {
      socket.emit('queue:error', { message: 'Too many requests, please slow down' });
      return;
    }

    if (!(await editableLobby(lobbyId))) {
      socket.emit('queue:error', { message: 'Playlist not found' });
      return;
    }

    if (!db.isAvailable()) {
      socket.emit('queue:error', { message: 'The music library is unavailable (no database)' });
      return;
    }

    const picks = rawPicks === undefined ? null : cleanPicks(rawPicks);
    if (rawPicks !== undefined && !picks) {
      socket.emit('queue:error', { message: 'Could not add that selection' });
      return;
    }

    const input = url || query;
    if (!libraryId && !picks) socket.emit('queue:adding', { status: 'Looking it up…' });

    let result;
    try {
      result = picks ? await resolver.resolve({ picks }) : await resolver.resolve({ input, libraryId, title });
    } catch (err) {
      console.error('queue:add resolve error:', err);
      socket.emit('queue:error', { message: 'Could not add that song' });
      return;
    }

    const addedBy = await displayName(clientAddedBy);
    const requester = { requestedBy: addedBy, requestedById: userId, lobbyId };

    if (result.type === 'error') {
      socket.emit('queue:error', { message: result.message });
      return;
    }

    if (result.type === 'library') {
      // Adding by library id (library page) is refused for a song the lobby
      // already has queued; search / links may still queue a song twice.
      const song = await addLibrarySongToLobby(lobbyId, result.song, addedBy, { skipIfQueued: !!libraryId });
      if (!song) {
        socket.emit('queue:error', { message: 'Already in the queue', libraryId });
        return;
      }
      console.log(`Song added to lobby ${lobbyId}: ${song.title}`);
      const queue = await getQueueAsync(lobbyId);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      return;
    }

    if (result.type === 'request') {
      try {
        const { request, created } = await songRequests.createRequest({ ...result.request, ...requester });
        const name = request.title || request.youtube_id || 'That song';
        socket.emit('queue:requested', {
          request,
          created,
          message: created
            ? `"${name}" isn't in the library yet. It has been requested and will be added to the queue once uploaded.`
            : `"${name}" isn't in the library yet. It was already requested.`
        });
        if (created) {
          io.to(APP_ROOM).emit('requests:updated');
          queueRequestJob(request, userId);
        }
      } catch (err) {
        console.error('Request create error:', err.message);
        socket.emit('queue:error', { message: 'Could not record the request' });
      }
      return;
    }

    // Playlist: queue what the library has, request the rest.
    let added = 0;
    let requested = 0;
    for (const item of result.items) {
      try {
        if (item.type === 'library') {
          await addLibrarySongToLobby(lobbyId, item.song, addedBy);
          added++;
        } else {
          const { request, created } = await songRequests.createRequest({ ...item.request, ...requester });
          if (created) { requested++; queueRequestJob(request, userId); }
        }
      } catch (err) {
        console.error(`[playlist] item failed: ${err.message}`);
      }
    }
    const queue = await getQueueAsync(lobbyId);
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    if (requested) io.to(APP_ROOM).emit('requests:updated');
    const capped = result.total > result.items.length ? ` (first ${result.items.length} of ${result.total})` : '';
    const notInLibrary = result.items.length - added;
    socket.emit('queue:adding', {
      status: `Playlist${capped}: added ${added} song${added !== 1 ? 's' : ''}` +
        (notInLibrary ? `, ${notInLibrary} not in the library yet (requested)` : '')
    });
  });

  // Remove song from queue
  socket.on('queue:remove', async ({ lobbyId, songId } = {}) => {
    if (!(await editableLobby(lobbyId))) return;

    const queue = await getQueueAsync(lobbyId);
    const index = queue.getSongs().findIndex(s => s.id === songId);
    const removed = queue.removeSong(songId);
    if (removed) {
      stashRemovedSong(lobbyId, removed, index);
      console.log(`Song removed from lobby ${lobbyId}: ${removed.title}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    }
  });

  // Undo a remove: put a song removed in the last minute back where it was.
  socket.on('queue:restore', async ({ lobbyId, songId } = {}) => {
    if (!(await editableLobby(lobbyId))) return;
    const key = `${lobbyId}:${songId}`;
    const stashed = removedSongs.get(key);
    if (!stashed || Date.now() - stashed.at > REMOVED_SONG_TTL) return;
    removedSongs.delete(key);
    const queue = await getQueueAsync(lobbyId);
    if (queue.insertSong(stashed.song, stashed.index)) {
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    }
  });

  // Reorder song in queue
  socket.on('queue:reorder', async ({ lobbyId, songId, newIndex } = {}) => {
    if (!(await editableLobby(lobbyId))) return;
    const queue = await getQueueAsync(lobbyId);
    const success = queue.reorderSong(songId, newIndex);
    if (success) {
      console.log(`Song reordered in lobby ${lobbyId}: moved to position ${newIndex}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    }
  });

  // Clear all songs from queue
  socket.on('queue:clear', async ({ lobbyId } = {}) => {
    if (!(await editableLobby(lobbyId))) return;
    const queue = await getQueueAsync(lobbyId);
    queue.clear();
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  // Get current queue state
  socket.on('queue:get', async (lobbyId) => {
    if (!(await visibleLobby(lobbyId))) return;
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });
});

function handleLeave(socket, lobbyId) {
  const user = lobby.getLobbyUsers(lobbyId).find(u => u.socketId === socket.id);
  // leaveLobby is async but removes the user synchronously; the rest is the
  // last-activity write.
  Promise.resolve(lobby.leaveLobby(lobbyId, socket.id)).catch(() => {});
  socket.leave(lobbyId);
  if (user) {
    socket.to(lobbyId).emit('lobby:user-left', {
      lobbyId,
      user,
      users: lobby.getLobbyUsers(lobbyId)
    });
    console.log(`User ${user.username} left lobby ${lobbyId}`);
  }
}

// Global chat + presence. Created in start() once we know whether there is a
// database (chat history in Postgres, else in memory like the other modules).
const graceEnv = Number.parseInt(process.env.PRESENCE_GRACE_MS, 10);
const presence = createPresence({ graceMs: Number.isFinite(graceEnv) ? graceEnv : 5000 });
let social = null;
let listenAlong = null;

// Initialize database and start server
async function start() {
  // Initialize database if DATABASE_URL is set
  const dbAvailable = await db.init();

  // Central login: metadata that cannot work stops the server; an IdP that
  // cannot be reached right now does not (sign-in retries discovery).
  if (OIDC.enabled) {
    try {
      await oidcClient.bootCheck();
    } catch (err) {
      console.error(`[oidc] ${err.message}`);
      process.exit(1);
    }
    const purge = () => sessionStore.purgeExpired()
      .then((n) => { if (n) console.log(`[oidc] ${n} expired session(s) removed`); })
      .catch((err) => console.error('[oidc] session purge failed:', err.message));
    purge();
    setInterval(purge, 60 * 60 * 1000).unref();
  }

  social = createSocial({
    io,
    db,
    presence,
    store: dbAvailable ? chat.createPgStore(db) : chat.createMemoryStore(),
    getLobby: (id) => lobby.getLobby(id),
    isAdmin: (headers) => adminAuth.isAdmin({ headers }),
    listenerCount: (id) => (listenAlong ? listenAlong.graph.followersOf(id).length : 0),
  });

  listenAlong = createListenAlong({
    io,
    presence,
    nameOf: (id) => social.nameOf(id),
    isApproved: (id) => userAuth.getAccount(id).then(a => !!a && a.status === 'approved').catch(() => false),
    resolveSource: createSourceResolver(dbAvailable
      ? async (url) => { const song = await library.resolveQueueUrl(url); return song ? song.id : null; }
      : null),
  });

  if (dbAvailable) {
    console.log('Database persistence enabled');

    // Restore lobbies from database into memory so lobby list works after restart
    await lobby.loadLobbiesFromDB();

    // Download jobs that were running when the server stopped go back in the
    // queue; workers reconnect and pick them up (or reclaim their own).
    await workerHub.start().catch(err => console.error('[workers] start failed:', err.message));

    // Register the legacy yt-dlp cache into the library (idempotent). Runs in
    // the background: hashing a large cache can take a while. Library songs
    // are permanent — there is no age-based cleanup any more.
    try { library.ensureDirs(); } catch (err) { console.error('Could not create songs dir:', err.message); }
    library.migrateLegacyCache().catch(err => {
      console.error('Legacy cache migration failed:', err.message);
    }).then(() => library.backfillMetaKeys()).catch(err => {
      // Duplicate-detection keys for songs from before they existed (or from
      // an older normalization). Background, batched; retried next boot.
      console.error('Duplicate-key backfill failed:', err.message);
    });
  } else {
    console.log('Running in memory-only mode');
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    ytdlp.availableCached().catch(() => {}); // warm the /health cache
    if (dbAvailable) {
      console.log(`Music library: ${library.SONGS_PATH}`);
    }
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown handling
const shutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  const lastSeenDone = social ? social.flushLastSeen().catch(() => {}) : Promise.resolve();
  presence.close();
  workerHub.close();

  server.close(async () => {
    console.log('HTTP server closed');
    await lastSeenDone;

    io.close(async () => {
      console.log('Socket.IO server closed');

      if (db.isAvailable()) {
        try {
          await db.close();
          console.log('Database connection closed');
        } catch (err) {
          console.error('Error closing database:', err.message);
        }
      }

      process.exit(0);
    });
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global crash guards: a stray promise rejection or thrown exception would
// otherwise kill the process and trigger a restart (the main cause of the
// 504s users were seeing). We deliberately log and KEEP THE PROCESS ALIVE.
// Trade-off: after an uncaughtException the process state can be undefined,
// but staying up is the intentional choice here to avoid a restart-storm.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
