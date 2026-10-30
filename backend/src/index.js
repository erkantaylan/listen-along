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
const { apiLimiter } = require('./rateLimits');
const { createResolver } = require('./songResolver');
const covers = require('./covers');
const access = require('./playlistAccess');
const spotify = require('./spotify');
const { createUserAuth, policyFor, parseCookie, isBlocked, COOKIE_NAME: AUTH_COOKIE, MAX_AGE_MS: AUTH_MAX_AGE_MS } = require('./userAuth');
const youtubePlaylist = require('./youtubePlaylist');
const chat = require('./chat');
const { createPresence } = require('./presence');
const { createSocial } = require('./social');
const { createListenAlong, createSourceResolver } = require('./listenAlong');
const downloadJobs = require('./downloadJobs');
const { createWorkerHub } = require('./workerHub');
const { createJobRouter } = require('./jobRoutes');
const resolver = createResolver();
const QRCode = require('qrcode');
const pkg = require('../package.json');
const { getVersionInfo } = require('./build-info');

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// Simple in-memory rate limiter
const rateLimitMap = new Map(); // key: IP, value: { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests per minute

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


// OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || FRONTEND_URL;

// Who is calling: the signed listen_auth cookie + the account's status
// (approved / pending / denied). See userAuth.js for the levels.
const userAuth = createUserAuth({ secret: SESSION_SECRET, db });

// OAuth CSRF state for account linking. Signed under its own label: the
// payload has the same shape as a login token, and the state travels in URLs
// (provider redirect, our request log), so it must never verify as a
// listen_auth cookie.
const OAUTH_STATE_LABEL = 'listen-along-oauth-link-state-v1.';
const signOAuthState = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(OAUTH_STATE_LABEL + payload).digest('base64url');

function createOAuthState(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now(), p: 'link' })).toString('base64url');
  return `${payload}.${signOAuthState(payload)}`;
}

function verifyOAuthState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = signOAuthState(payload);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // Expire after 10 minutes
    if (data.p !== 'link' || !data.id || !data.t || Date.now() - data.t > 10 * 60 * 1000) return null;
    return data.id;
  } catch {
    return null;
  }
}

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
    console.warn(`[http] PENDING ${req.method} ${req.originalUrl} still running after 15s`);
  }, 15000);
  const finish = (aborted) => {
    if (logged) return;
    logged = true;
    clearTimeout(pending);
    const ms = Date.now() - start;
    const status = aborted ? 'ABORTED' : res.statusCode;
    const slow = ms > 5000 ? ' SLOW' : '';
    const line = `[http] ${req.method} ${req.originalUrl} ${status} ${ms}ms${slow}`;
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
// express.static answering it with index.html.
app.use(express.static(frontendPath, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions
});

// Where to send someone who is not logged in: /login, remembering the page.
function loginRedirectUrl(req) {
  const next = req.originalUrl;
  return isSafeNextPath(next) && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

// Auth guard: deny by default. policyFor() (userAuth.js) classifies the path:
//   public    no check (health, login/OAuth, static pages, shared YouTube page)
//   self      the route has its own middleware (CLI Bearer token, admin
//             cookie, or token-or-admin-or-approved-user)
//   member    API a pending user may use too (own profile)
//   approved  every other /api/... route
//   page      every other HTML route: a login is needed (the SPA then shows
//             the pending / denied screen itself); otherwise -> /login?next=
//
// The playlist API (/api/playlists, /api/lobbies) also takes a CLI Bearer
// token instead of the cookie: the token must be valid (its owner approved),
// and the routes then act as the token's owner (requireViewer).
const PLAYLIST_API_RE = /^\/api\/(?:playlists|lobbies)(?:\/|$)/;
app.use((req, res, next) => {
  if (tokens.hasBearer(req) && PLAYLIST_API_RE.test(String(req.path).toLowerCase().replace(/\/{2,}/g, '/'))) {
    return apiLimiter(req, res, () => tokens.requireToken(req, res, next));
  }
  const policy = policyFor(req.path);
  if (policy === 'public' || policy === 'self') return next();
  if (policy === 'page') {
    return userAuth.identify(req).then(({ account }) => {
      if (account) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      res.redirect(loginRedirectUrl(req));
    }).catch((err) => {
      console.error('Account lookup failed:', err.message);
      res.status(503).send('Could not check your login, try again');
    });
  }
  return userAuth.requireLevel(policy)(req, res, next);
});


// Health check endpoint
app.get('/health', async (req, res) => {
  // yt-dlp is only used for YouTube search / playlist listing now (no audio).
  const ytdlpAvailable = await ytdlp.checkAvailable();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp: ytdlpAvailable ? 'available' : 'unavailable',
    database: db.isAvailable() ? 'connected' : 'unavailable',
    library: db.isAvailable() ? 'enabled' : 'disabled'
  });
});

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json(getVersionInfo({ pkg }));
});

// Changelog endpoint - serves CHANGELOG.md as JSON
app.get('/api/changelog', (req, res) => {
  // In Docker: /app/CHANGELOG.md, locally: ../../CHANGELOG.md from backend/src/
  const changelogPath = [
    path.join(__dirname, '..', 'CHANGELOG.md'),
    path.join(__dirname, '..', '..', 'CHANGELOG.md')
  ].find(p => fs.existsSync(p));
  try {
    const content = fs.readFileSync(changelogPath, 'utf8');
    res.json({ changelog: content });
  } catch {
    res.status(404).json({ error: 'Changelog not found' });
  }
});

// Changelog page
app.get('/changelog', (req, res) => {
  res.sendFile(path.join(frontendPath, 'changelog.html'));
});

// Legacy registration / approval check from the localStorage-id era. The
// caller is now always the logged-in account (or nobody): both answer that
// account's status and ignore any userId/username in the request,
// so nobody can create users or read another user's status.
async function sendOwnStatus(req, res) {
  try {
    const { userId, account } = await userAuth.identify(req);
    res.json({ status: account ? account.status : 'unregistered', userId });
  } catch (err) {
    console.error('Auth status error:', err.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
}
app.post('/api/auth/register', sendOwnStatus);
app.get('/api/auth/status', sendOwnStatus);

// Generate QR code for a playlist link. It only encodes the URL (the id comes
// from the caller), so it reveals nothing about whether the playlist exists.
app.get('/api/qr/:lobbyId', async (req, res) => {
  const lobbyId = req.params.lobbyId;
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(lobbyId)) return res.status(400).json({ error: 'Invalid id' });
  const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/playlist/${lobbyId}`;

  try {
    const buffer = await QRCode.toBuffer(url, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.type('png').send(buffer);
  } catch (err) {
    console.error('QR code generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Download workers (`la worker` on users' machines) and their jobs: see
// workerHub.js (WebSocket, routing), downloadJobs.js (store), jobRoutes.js
// (HTTP API). Live job status goes to the requester's sockets (jobs:update),
// worker counts to every approved socket (workers:update).
function upgradeIp(req) {
  try {
    // The upgrade request skips Express: apply the same trust-proxy rule.
    req.ip = require('proxy-addr')(req, app.get('trust proxy fn'));
  } catch {}
  return clientIpOf(req);
}
function emitJob(row) {
  if (!row || !row.requested_by_user_id) return;
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
let workersChangedTimer = null;
const workerHub = createWorkerHub({
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
  onSongRemoved: (song) => io.to(APP_ROOM).emit('library:updated', { removed: song.id }),
  onSongReplaced: (song, previous) => { handleLibrarySongReplaced(song, previous).catch(err => console.error('[library] post-replace handling failed:', err)); },
  loginRateLimit: rateLimit,
  // Library / requests reads from the web app: an approved account.
  requireWebUser: userAuth.requireLevel('approved')
}));

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
  editablePlaylist: async (playlistId, userId) => {
    const l = await lobby.getLobbyAsync(playlistId);
    return access.canEdit(l, userId) ? l : null;
  },
  spotifyTrack: (url) => spotify.getTrack(url),
  addSongToPlaylist: async (playlistId, song, addedBy) => {
    const entry = await addLibrarySongToLobby(playlistId, song, addedBy, { skipIfQueued: true });
    if (!entry) return false;
    const queue = await getQueueAsync(playlistId);
    io.to(playlistId).emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
    return true;
  },
  onJobUpdated: emitJob,
}));

// Admin page (all CLI tokens, requests, library management). Disabled without ADMIN_PASSWORD.
app.get('/admin', apiLimiter, (req, res) => {
  res.sendFile(path.join(frontendPath, 'admin.html'));
});

// Play audio for a queue entry. `q` is the queue entry's url: a YouTube URL
// (looked up by youtube_id), `library:<id>`, or a legacy cache URL. The server
// never downloads: anything not in the library is a 404 NOT_IN_LIBRARY.
app.get('/api/stream', apiLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Library unavailable (no database)', code: 'NO_DATABASE' });
  }
  // When dl is set, force the browser to save the file instead of playing it
  // inline. Used by the "Download playlist" feature.
  const forceDownload = req.query.dl === '1' || req.query.dl === 'true';
  try {
    const song = await library.resolveQueueUrl(String(q));
    if (!song) {
      return res.status(404).json({ error: 'This song is not in the library yet', code: 'NOT_IN_LIBRARY' });
    }
    sendSongFile(req, res, song, { download: forceDownload });
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).json({ error: 'Stream error' });
  }
});

// ==========================================
// Playlists (internally "lobbies") — HTTP API
// ==========================================
// Mounted at /api/playlists; /api/lobbies stays as an alias for old clients.
// Every route checks playlistAccess: a playlist the caller cannot see is a
// 404 (never a 403), so private playlists cannot be probed. Callers are a
// web session (cookie) or a CLI Bearer token (see the auth guard and
// requireViewer). Errors are JSON { error, code }.

const PLAYLIST_BASES = ['/api/playlists', '/api/lobbies'];
const playlistPaths = (suffix = '') => PLAYLIST_BASES.map(b => b + suffix);

// Owner display names (users.display_name / name), cached briefly.
const ownerNameCache = new Map(); // userId -> { name, at }
const OWNER_NAME_TTL = 60 * 1000;
async function ownerNames(ids) {
  const out = new Map();
  const missing = [];
  const now = Date.now();
  for (const id of new Set(ids.filter(Boolean))) {
    const hit = ownerNameCache.get(id);
    if (hit && now - hit.at < OWNER_NAME_TTL) out.set(id, hit.name);
    else missing.push(id);
  }
  if (missing.length && db.isAvailable()) {
    try {
      const r = await db.query(
        'SELECT id::text AS id, COALESCE(display_name, name, username) AS name FROM users WHERE id::text = ANY($1)',
        [missing]
      );
      for (const row of r.rows) {
        out.set(row.id, row.name || null);
        ownerNameCache.set(row.id, { name: row.name || null, at: now });
      }
    } catch (err) {
      console.error('Owner name lookup failed:', err.message);
    }
  }
  return out;
}

// What a user sees about a playlist they are allowed to see.
async function playlistInfo(l, userId, names = null) {
  const queue = await getQueueAsync(l.id);
  const nameMap = names || await ownerNames([l.ownerId]);
  return {
    id: l.id,
    name: l.name || null,
    visibility: l.visibility,
    ownerId: l.ownerId || null,
    ownerName: (l.ownerId && nameMap.get(l.ownerId)) || l.ownerName || null,
    isOwner: access.isOwner(l, userId),
    canManage: access.canManage(l, userId),
    pinned: l.pinned || false,
    userCount: l.users ? l.users.size : (l.userCount || 0),
    songCount: queue.getSongs().length,
    createdAt: l.createdAt
  };
}

// Tell everyone looking at a playlist that its name/visibility changed.
async function broadcastPlaylistUpdated(lobbyId) {
  const l = await lobby.getLobbyAsync(lobbyId);
  if (!l) return;
  const names = await ownerNames([l.ownerId]);
  io.to(lobbyId).emit('lobby:updated', {
    lobbyId,
    name: l.name || null,
    visibility: l.visibility,
    ownerId: l.ownerId || null,
    ownerName: (l.ownerId && names.get(l.ownerId)) || l.ownerName || null
  });
}

// A playlist went private: every socket in its room that is not the owner's
// loses it, exactly as if it had been deleted.
function evictNonOwners(lobbyId, ownerId) {
  const room = io.sockets.adapter.rooms.get(lobbyId);
  if (!room) return;
  for (const socketId of [...room]) {
    const s = io.sockets.sockets.get(socketId);
    if (!s || (ownerId && s.data.userId === ownerId)) continue;
    s.emit('lobby:closed', { lobbyId, message: 'This playlist is no longer available.' });
    if (s.data.evict) s.data.evict(lobbyId);
    else s.leave(lobbyId);
  }
}

// Who is calling a playlist route: { userId, legacy, name }, or null after
// answering 401. A Bearer token (CLI) was verified by the auth guard
// (req.apiUser): it acts as the token's owner, or — for a legacy ownerless
// token — as an ownerless member (playlistAccess viewer rules). Otherwise the
// signed listen_auth cookie (the guard already required an approved account).
async function requireViewer(req, res) {
  if (req.apiUser) {
    const { userId, name } = req.apiUser;
    return { userId: userId || null, legacy: !userId, name: name || null };
  }
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  let name = null;
  try {
    const account = await userAuth.getAccount(userId);
    name = account && account.name ? String(account.name).trim().slice(0, 30) : null;
  } catch {}
  return { userId, legacy: false, name };
}

// The playlist, or null after answering 404 when it is missing or hidden.
async function findVisiblePlaylist(req, res, viewer) {
  const l = await lobby.getLobbyAsync(req.params.id);
  if (!access.viewerCanView(l, viewer)) {
    res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
    return null;
  }
  return l;
}

// Wrap an async route: unexpected errors become a JSON 500.
const playlistRoute = (label, fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`Playlist ${label} error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
  });
};

// Playlists the caller can see: every public one plus their own private ones.
app.get(playlistPaths(), playlistRoute('list playlists', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const visible = lobby.getAllLobbies().filter(l => access.viewerCanView(l, viewer));
  const names = await ownerNames(visible.map(l => l.ownerId));
  const playlists = await Promise.all(visible.map(l => playlistInfo(l, viewer.userId, names)));
  // `lobbies` is the old key, kept for older clients.
  res.json({ playlists, lobbies: playlists });
}));

// Create a playlist owned by the caller. Body: { name?, visibility? }.
// A legacy (ownerless) CLI token creates an ownerless playlist, which is
// always public: asking it for a private one is refused.
app.post(playlistPaths(), express.json(), playlistRoute('create playlist', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const { name, visibility = 'public' } = req.body || {};
  if (!lobby.VISIBILITIES.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
  }
  if (viewer.legacy && visibility === 'private') {
    return res.status(403).json({
      error: 'This token has no owner (legacy token): it can only create public playlists. Create a token on your profile page.',
      code: 'FORBIDDEN'
    });
  }
  if (name !== undefined && name !== null && typeof name !== 'string') {
    return res.status(400).json({ error: 'name must be a string', code: 'BAD_REQUEST' });
  }
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length > 50) return res.status(400).json({ error: 'Name must be 50 characters or less', code: 'BAD_REQUEST' });
  if (trimmed && lobby.isNameTaken(trimmed, null, l => access.viewerCanView(l, viewer))) {
    return res.status(409).json({ error: 'A playlist with that name already exists', code: 'CONFLICT' });
  }
  const created = await lobby.createLobbyAsync(viewer.userId, null, trimmed || null, visibility, viewer.name);
  const info = await playlistInfo(created, viewer.userId);
  res.status(201).json({ ...info, link: `/playlist/${created.id}` });
}));

app.get(playlistPaths('/:id'), playlistRoute('get playlist', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  res.json({ ...(await playlistInfo(l, viewer.userId)), users: lobby.getLobbyUsers(l.id) });
}));

// Rename and/or change visibility. Body: { name?, visibility? }. Renaming is
// an edit (anyone who can see it); visibility is owner-only.
async function updatePlaylist(req, res, { name, visibility }) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  if (visibility !== undefined) {
    if (!lobby.VISIBILITIES.includes(visibility)) {
      return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
    }
    if (!access.viewerCanManage(l, viewer)) {
      return res.status(403).json({ error: 'Only the owner can change visibility', code: 'FORBIDDEN' });
    }
  }
  if (name !== undefined) {
    if (!access.viewerCanEdit(l, viewer)) return res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
    const result = await lobby.renameLobby(l.id, name, other => access.viewerCanView(other, viewer));
    if (!result) return res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
    if (result.error) {
      const conflict = /already exists/.test(result.error);
      return res.status(conflict ? 409 : 400).json({ error: result.error, code: conflict ? 'CONFLICT' : 'BAD_REQUEST' });
    }
  }
  if (visibility !== undefined && visibility !== l.visibility) {
    await lobby.setVisibility(l.id, visibility);
    if (visibility === 'private') evictNonOwners(l.id, l.ownerId);
  }
  await broadcastPlaylistUpdated(l.id);
  if (social) social.lobbyChanged(l.id);
  if (name !== undefined) {
    const fresh = await lobby.getLobbyAsync(l.id);
    io.to(l.id).emit('lobby:renamed', { lobbyId: l.id, name: fresh.name });
  }
  const fresh = await lobby.getLobbyAsync(l.id);
  res.json(await playlistInfo(fresh, viewer.userId));
}

app.patch(playlistPaths('/:id'), express.json(), playlistRoute('update playlist', (req, res) => {
  const { name, visibility } = req.body || {};
  return updatePlaylist(req, res, { name, visibility });
}));

// Older form: { is_public: boolean } or { visibility }.
app.patch(playlistPaths('/:id/visibility'), express.json(), playlistRoute('update visibility', (req, res) => {
  const body = req.body || {};
  let visibility = body.visibility;
  if (visibility === undefined && typeof body.is_public === 'boolean') visibility = body.is_public ? 'public' : 'private';
  if (visibility === undefined) return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
  return updatePlaylist(req, res, { visibility });
}));

// Delete as the owner. Ownerless playlists can only be deleted by an admin
// (DELETE /api/dashboard/lobbies/:id).
app.delete(playlistPaths('/:id'), playlistRoute('delete playlist', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  if (!access.viewerCanManage(l, viewer)) {
    return res.status(403).json({ error: 'Only the owner can delete this playlist', code: 'FORBIDDEN' });
  }
  await destroyLobby(l.id, { reason: 'This playlist has been deleted by its owner.' });
  console.log(`Playlist ${l.id} deleted by owner ${viewer.userId}`);
  res.json({ success: true, id: l.id });
}));

// --- A playlist's songs (its queue of library songs) ---------------------
// Same permission as the web app: whoever can see a playlist can edit its
// songs. Changes go through the same queue code as the socket handlers and
// broadcast queue:update to the playlist room, so open web clients update.

const MAX_SONGS_PER_ADD = 200;

// Queue entries as the API shows them: position (1-based), the entry id
// (used to remove / move it) and the library song behind it.
async function playlistSongViews(songs) {
  const byId = new Map();
  const byYt = new Map();
  if (db.isAvailable() && songs.length) {
    const ids = [];
    const ytIds = [];
    for (const s of songs) {
      if (typeof s.url !== 'string') continue;
      if (s.url.startsWith('library:') && library.isUuid(s.url.slice(8))) ids.push(s.url.slice(8));
      const yt = library.parseYoutubeId(s.url);
      if (yt) ytIds.push(yt);
    }
    try {
      const r = await db.query(
        `SELECT id::text AS id, youtube_id, title, artist, album, duration_sec FROM library_songs
         WHERE id = ANY($1::uuid[]) OR youtube_id = ANY($2::text[])`,
        [ids, ytIds]
      );
      for (const row of r.rows) {
        byId.set(row.id, row);
        if (row.youtube_id) byYt.set(row.youtube_id, row);
      }
    } catch (err) {
      console.error('Playlist song lookup failed:', err.message);
    }
  }
  return songs.map((s, i) => {
    const yt = library.parseYoutubeId(s.url || '');
    const lib = (s.url && s.url.startsWith('library:') && byId.get(s.url.slice(8))) || (yt && byYt.get(yt)) || null;
    return {
      position: i + 1,
      entry_id: s.id,
      library_id: lib ? lib.id : null,
      youtube_id: (lib && lib.youtube_id) || yt || null,
      title: s.title,
      artist: lib ? lib.artist : null,
      duration_sec: Number(s.duration) || (lib && lib.duration_sec !== null ? Number(lib.duration_sec) : null) || null,
      url: s.url,
      thumbnail: s.thumbnail || null,
      added_by: s.addedBy || null,
      added_at: s.addedAt || null,
      available: db.isAvailable() ? !!lib : null
    };
  });
}

// A song reference from an API body: a library song id (uuid), "yt:<id>", a
// bare 11-char YouTube id or a YouTube URL, or { library_id } / { youtube_id }.
// Returns { song } or { code, error }.
async function resolveLibraryRef(ref) {
  let libraryId = null;
  let youtubeId = null;
  if (ref && typeof ref === 'object') {
    if (typeof ref.library_id === 'string') libraryId = ref.library_id.trim();
    else if (typeof ref.youtube_id === 'string') youtubeId = library.parseYoutubeId(ref.youtube_id.replace(/^yt:/i, ''));
    else return { code: 'INVALID', error: 'Expected { library_id } or { youtube_id }' };
    if (libraryId !== null && !library.isUuid(libraryId)) return { code: 'INVALID', error: 'library_id must be a UUID' };
    if (libraryId === null && !youtubeId) return { code: 'INVALID', error: 'Invalid youtube_id' };
  } else if (typeof ref === 'string' && ref.trim()) {
    const s = ref.trim();
    if (library.isUuid(s)) libraryId = s;
    else youtubeId = library.parseYoutubeId(s.replace(/^yt:/i, ''));
    if (!libraryId && !youtubeId) return { code: 'INVALID', error: 'Not a library song id, yt:<id> or YouTube URL' };
  } else {
    return { code: 'INVALID', error: 'Empty song reference' };
  }
  const song = libraryId ? await library.getById(libraryId) : await library.getByYoutubeId(youtubeId);
  if (!song) return { code: 'NOT_IN_LIBRARY', error: 'Not in the library' };
  return { song };
}

app.get(playlistPaths('/:id/songs'), playlistRoute('list playlist songs', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  const queue = await getQueueAsync(l.id);
  res.json({ playlist: await playlistInfo(l, viewer.userId), songs: await playlistSongViews(queue.getSongs()) });
}));

// Add library songs. Body: { songs: [ref, ...], allow_duplicates?: boolean }.
// A song already in the playlist is skipped unless allow_duplicates. Answers
// 200 with one result per ref (added | already_in_playlist | not_in_library |
// invalid) even if some failed.
app.post(playlistPaths('/:id/songs'), express.json(), playlistRoute('add playlist songs', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  const body = req.body || {};
  const refs = Array.isArray(body.songs) ? body.songs : null;
  if (!refs || !refs.length) return res.status(400).json({ error: 'songs must be a non-empty array of library ids or yt:<id>', code: 'BAD_REQUEST' });
  if (refs.length > MAX_SONGS_PER_ADD) return res.status(400).json({ error: `At most ${MAX_SONGS_PER_ADD} songs per request`, code: 'BAD_REQUEST' });
  if (!db.isAvailable()) return res.status(503).json({ error: 'The music library is unavailable (no database)', code: 'NO_DATABASE' });
  const allowDuplicates = body.allow_duplicates === true;
  const addedBy = viewer.name || 'CLI';
  const results = [];
  for (const ref of refs) {
    const input = ref;
    const resolved = await resolveLibraryRef(ref);
    if (!resolved.song) {
      results.push({ input, status: resolved.code === 'INVALID' ? 'invalid' : 'not_in_library', code: resolved.code, error: resolved.error });
      continue;
    }
    const entry = await addLibrarySongToLobby(l.id, resolved.song, addedBy, { skipIfQueued: !allowDuplicates });
    const song = library.toPublic(resolved.song);
    if (!entry) results.push({ input, status: 'already_in_playlist', song });
    else results.push({ input, status: 'added', song, entry_id: entry.id });
  }
  const queue = await getQueueAsync(l.id);
  const added = results.filter(r => r.status === 'added').length;
  if (added) {
    io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
    console.log(`${added} song(s) added to playlist ${l.id} over the API by ${addedBy}`);
  }
  await queue.flush(); // persisted before we answer
  const count = (s) => results.filter(r => r.status === s).length;
  res.json({
    playlist_id: l.id,
    summary: { total: results.length, added, already_in_playlist: count('already_in_playlist'), not_in_library: count('not_in_library'), invalid: count('invalid') },
    results,
    song_count: queue.getSongs().length
  });
}));

// Remove songs. :ref is a queue entry id (removes that entry), or a library
// song id / yt:<id> / YouTube id (removes every entry of that song).
app.delete(playlistPaths('/:id/songs/:ref'), playlistRoute('remove playlist song', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  const queue = await getQueueAsync(l.id);
  const ref = String(req.params.ref || '').trim();
  let targets = queue.getSongs().filter(s => s.id === ref);
  if (!targets.length) {
    let song = null;
    if (library.isUuid(ref) && db.isAvailable()) song = await library.getById(ref);
    const yt = library.parseYoutubeId(ref.replace(/^yt:/i, ''));
    if (song) targets = queue.getSongs().filter(s => library.isQueued([s], song));
    else if (yt) targets = queue.getSongs().filter(s => library.parseYoutubeId(s.url || '') === yt);
  }
  if (!targets.length) return res.status(404).json({ error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
  const removed = [];
  for (const t of targets) {
    const r = queue.removeSong(t.id);
    if (r) removed.push({ entry_id: r.id, title: r.title, url: r.url });
  }
  io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
  await queue.flush();
  res.json({ playlist_id: l.id, removed, song_count: queue.getSongs().length });
}));

// Move one entry. Body: { position } (1-based; or index, 0-based).
app.post(playlistPaths('/:id/songs/:entryId/move'), express.json(), playlistRoute('move playlist song', async (req, res) => {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const l = await findVisiblePlaylist(req, res, viewer);
  if (!l) return;
  const body = req.body || {};
  const index = Number.isInteger(body.position) ? body.position - 1 : body.index;
  const queue = await getQueueAsync(l.id);
  if (!queue.getSongs().some(s => s.id === req.params.entryId)) {
    return res.status(404).json({ error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
  }
  if (!Number.isInteger(index) || index < 0 || index >= queue.getSongs().length) {
    return res.status(400).json({ error: `position must be between 1 and ${queue.getSongs().length}`, code: 'BAD_REQUEST' });
  }
  queue.reorderSong(req.params.entryId, index);
  io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
  await queue.flush();
  res.json({ playlist_id: l.id, songs: await playlistSongViews(queue.getSongs()) });
}));

// Thumbnail hosts queue entries use: YouTube (library songs, search) and
// Spotify (track links).
const COVER_HOST_SUFFIXES = ['ytimg.com', 'youtube.com', 'ggpht.com', 'googleusercontent.com', 'scdn.co', 'spotifycdn.com'];
function isAllowedCoverUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return COVER_HOST_SUFFIXES.some(sfx => host === sfx || host.endsWith('.' + sfx));
}

// Get cached cover art for a song
app.get('/api/covers/:id', (req, res) => {
  const songId = req.params.id;
  const fallbackUrl = req.query.fallback;

  const cached = covers.getCachedCover(songId);
  if (cached) {
    // Validate cached path is within COVERS_DIR to prevent path traversal
    const resolvedPath = path.resolve(cached.path);
    const coversBase = path.resolve(covers.COVERS_DIR);
    if (!resolvedPath.startsWith(coversBase + path.sep) && resolvedPath !== coversBase) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    return res.sendFile(resolvedPath);
  }

  // Not cached - redirect to the fallback thumbnail, but only on a known
  // image host (anything else would make this an open redirect).
  if (fallbackUrl) {
    if (!isAllowedCoverUrl(fallbackUrl)) {
      return res.status(400).json({ error: 'Invalid fallback URL' });
    }
    return res.redirect(fallbackUrl);
  }

  res.status(404).json({ error: 'Cover not found' });
});


// ==========================================
// OAuth Authentication
// ==========================================

// Helper: upsert user from OAuth profile
async function upsertOAuthUser(provider, profile) {
  if (!db.isAvailable()) return null;
  const now = Date.now();

  // Check if this provider account is already linked via user_providers
  const linkedProvider = await db.query(
    'SELECT user_id FROM user_providers WHERE provider = $1 AND provider_id = $2',
    [provider, profile.id]
  );
  if (linkedProvider.rows.length > 0) {
    // User exists via junction table — update their info and return
    const userId = linkedProvider.rows[0].user_id;
    await db.query(
      'UPDATE user_providers SET email = $1, name = $2, avatar_url = $3, linked_at = $4 WHERE provider = $5 AND provider_id = $6',
      [profile.email, profile.name, profile.avatar, now, provider, profile.id]
    );
    await db.query(
      'UPDATE users SET avatar_url = COALESCE(avatar_url, $1), updated_at = $2 WHERE id = $3',
      [profile.avatar, now, userId]
    );
    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return user.rows[0] || null;
  }

  // Check legacy users table for existing user
  const existing = await db.query(
    'SELECT * FROM users WHERE provider = $1 AND provider_id = $2',
    [provider, profile.id]
  );
  if (existing.rows.length > 0) {
    // Update name/avatar/email on each login
    await db.query(
      'UPDATE users SET name = $1, avatar_url = $2, email = $3, updated_at = $4 WHERE id = $5',
      [profile.name, profile.avatar, profile.email, now, existing.rows[0].id]
    );
    // Ensure provider is in junction table
    await db.query(
      `INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [existing.rows[0].id, provider, profile.id, profile.email, profile.name, profile.avatar, now]
    );
    // Re-fetch to return updated data
    const updated = await db.query('SELECT * FROM users WHERE id = $1', [existing.rows[0].id]);
    return updated.rows[0] || null;
  }

  // Check if another user exists with the same email — link accounts. Only
  // for an address the provider says is verified: otherwise anyone could sign
  // up at the provider with someone else's address and take over their
  // account here.
  if (profile.email && profile.emailVerified === true) {
    const emailMatch = await db.query(
      'SELECT * FROM users WHERE email = $1 AND provider != $2 LIMIT 1',
      [profile.email, provider]
    );
    if (emailMatch.rows.length > 0) {
      const existingUser = emailMatch.rows[0];
      // Link this provider to the existing user
      await db.query(
        `INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, provider_id) DO NOTHING`,
        [existingUser.id, provider, profile.id, profile.email, profile.name, profile.avatar, now]
      );
      await db.query(
        'UPDATE users SET updated_at = $1 WHERE id = $2',
        [now, existingUser.id]
      );
      // Re-fetch to return updated data
      const refreshed = await db.query('SELECT * FROM users WHERE id = $1', [existingUser.id]);
      return refreshed.rows[0] || null;
    }
  }

  // Create new user
  const status = 'approved';
  const result = await db.query(
    `INSERT INTO users (provider, provider_id, email, name, avatar_url, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [provider, profile.id, profile.email, profile.name, profile.avatar, status, now]
  );
  const newUser = result.rows[0];

  // Also add to user_providers junction table
  await db.query(
    `INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, provider_id) DO NOTHING`,
    [newUser.id, provider, profile.id, profile.email, profile.name, profile.avatar, now]
  );

  return newUser;
}

// Post-login destination: the SPA sends the page the user asked for as
// /auth/<provider>?next=<path>; it rides through the OAuth round trip in a
// short-lived cookie. Only same-origin relative paths are accepted.
const NEXT_COOKIE = 'listen_next';
function isSafeNextPath(next) {
  return typeof next === 'string' && /^\/(?![\/\\])[^\\\s\x00-\x1f]*$/.test(next);
}
function rememberNextPath(req, res) {
  if (isSafeNextPath(req.query.next) && req.query.next !== '/') {
    res.cookie(NEXT_COOKIE, req.query.next, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' });
  } else {
    res.clearCookie(NEXT_COOKIE, { path: '/' });
  }
}
function takeNextPath(req, res) {
  const raw = parseCookie(req.headers.cookie, NEXT_COOKIE);
  if (!raw) return '/';
  res.clearCookie(NEXT_COOKIE, { path: '/' });
  let next;
  try { next = decodeURIComponent(raw); } catch { return '/'; }
  return isSafeNextPath(next) ? next : '/';
}

// The GitHub account's email and whether GitHub has verified it: the public
// profile email if it is in the verified list, else the primary address.
async function githubEmail(accessToken, publicEmail) {
  let emails = [];
  try {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'listen-along' }
    });
    const list = await emailsRes.json();
    if (Array.isArray(list)) emails = list;
  } catch {}
  const find = (pred) => emails.find(e => e && typeof e.email === 'string' && pred(e));
  if (publicEmail) {
    const listed = find(e => e.email.toLowerCase() === String(publicEmail).toLowerCase());
    return { email: publicEmail, verified: !!(listed && listed.verified === true) };
  }
  const primary = find(e => e.primary);
  return { email: primary ? primary.email : null, verified: !!(primary && primary.verified === true) };
}

// Set auth cookie and redirect (back to the page that asked for the login)
function setAuthCookieAndRedirect(req, res, user) {
  const token = userAuth.createToken(String(user.id));
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: AUTH_MAX_AGE_MS, // 30 days; the token itself expires with it
    path: '/'
  });
  res.redirect(takeNextPath(req, res));
}

// Google OAuth
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  rememberNextPath(req, res);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/?error=token_failed');
    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await userRes.json();
    const user = await upsertOAuthUser('google', {
      id: profile.id,
      email: profile.email,
      emailVerified: profile.verified_email === true,
      name: profile.name,
      avatar: profile.picture
    });
    if (!user) return res.redirect('/?error=db_unavailable');
    setAuthCookieAndRedirect(req, res, user);
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// GitHub OAuth
app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).json({ error: 'GitHub OAuth not configured' });
  }
  rememberNextPath(req, res);
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/github/callback`,
    scope: 'read:user user:email'
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/github/callback`
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/?error=token_failed');
    // Get user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'User-Agent': 'listen-along'
      }
    });
    const profile = await userRes.json();
    const { email, verified } = await githubEmail(tokens.access_token, profile.email);
    const user = await upsertOAuthUser('github', {
      id: String(profile.id),
      email,
      emailVerified: verified,
      name: profile.name || profile.login,
      avatar: profile.avatar_url
    });
    if (!user) return res.redirect('/?error=db_unavailable');
    setAuthCookieAndRedirect(req, res, user);
  } catch (err) {
    console.error('GitHub OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Auth status endpoint
app.get('/api/auth/me', async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId || !db.isAvailable()) {
    return res.json({ authenticated: false });
  }
  try {
    const result = await db.query('SELECT id, provider, email, name, display_name, emoji, avatar_url, status FROM users WHERE id::text = $1', [userId]);
    if (result.rows.length === 0) {
      return res.json({ authenticated: false });
    }
    const user = result.rows[0];
    res.json({
      authenticated: true,
      user: {
        id: user.id,
        provider: user.provider,
        email: user.email,
        name: user.display_name || user.name,
        displayName: user.display_name,
        emoji: user.emoji,
        avatarUrl: user.avatar_url,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Auth check error:', err.message);
    res.json({ authenticated: false });
  }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.clearCookie(NEXT_COOKIE, { path: '/' });
  res.json({ success: true });
});

// Admin: list pending users (dashboard auth)
app.get('/api/auth/users', adminAuth.requireAdmin, async (req, res) => {
  if (!db.isAvailable()) return res.json({ users: [] });
  try {
    const result = await db.query('SELECT id, provider, email, name, avatar_url, status, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: result.rows });
  } catch (err) {
    console.error('List users error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Admin: approve/deny user (dashboard auth)
app.post('/api/auth/users/:userId/status', adminAuth.requireAdmin, express.json(), async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or denied' });
  }
  try {
    await db.query('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), req.params.userId]);
    accountStatusChanged(req.params.userId, status);
    res.json({ success: true });
  } catch (err) {
    console.error('Update user status error:', err.message);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// An admin changed an account's status: forget the cached status at once, and
// a denied / rejected account loses its open sockets (the handshake refuses
// new ones).
function accountStatusChanged(userId, status) {
  userAuth.invalidate(userId);
  if (social) social.profileChanged(String(userId));
  if (isBlocked(status)) io.in(userRoom(String(userId))).disconnectSockets(true);
}

// The users.id from a valid (signed, unexpired) listen_auth cookie, or null.
// Only proves who it is; the guard / userAuth.getAccount check the status.
function getAuthUserId(req) {
  return userAuth.userIdFromHeaders(req.headers);
}

// Tear down a lobby everywhere: notify + disconnect members, clear
// queue state, then delete the row from BOTH memory and the DB.
// Shared by the admin (dashboard) and creator delete paths. Uses the async
// delete so the row does not resurrect on restart (there is no longer any
// time-based cleanup to remove stale rows — hq-9gvy).
async function destroyLobby(lobbyId, { reason } = {}) {
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
  if (social) social.lobbyChanged(lobbyId);
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
  const song = queue.addSong({ ...entry, addedBy: addedBy || 'anonymous' });
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
        queue.updateSong(s.id, entry);
        if (entry.thumbnail) covers.cacheCover(s.id, entry.thumbnail).catch(() => {});
        rewritten++;
      }
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    } catch (err) {
      console.error(`[library] could not rewrite queue of ${lobbyId} after a replace:`, err.message);
    }
  }
  io.to(APP_ROOM).emit('library:updated', {
    song: pub,
    replaced: { id: librarySong.id, oldUrls, url: entry.url, file_version: pub.file_version },
  });
  for (const url of new Set([entry.url, librarySong.source_url].filter(Boolean))) {
    io.to(APP_ROOM).emit('download:status', { url, status: 'ready', percent: 100 });
  }
  if (rewritten) console.log(`[library] replaced ${librarySong.id}: rewrote ${rewritten} queue entr${rewritten === 1 ? 'y' : 'ies'}`);
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

// ==========================================
// Shared YouTube Playlist (public, no auth, no yt-dlp)
// ==========================================

app.get('/api/youtube-playlist', (req, res) => {
  res.json({ songs: youtubePlaylist.getSongs() });
});

app.post('/api/youtube-playlist', rateLimit, (req, res) => {
  const { videoId, title, thumbnail, addedBy } = req.body || {};
  try {
    const song = youtubePlaylist.addSong({ videoId, title, thumbnail, addedBy });
    youtubePlaylist.broadcast(io, 'song:added', song);
    res.status(201).json({ song });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/youtube-playlist/:id', rateLimit, (req, res) => {
  const removed = youtubePlaylist.removeSong(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: 'Song not found' });
  }
  youtubePlaylist.broadcast(io, 'song:removed', { id: req.params.id });
  res.json({ success: true });
});

// ==========================================
// Profile API
// ==========================================

// Get current user's profile with linked providers
app.get('/api/profile', async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId || !db.isAvailable()) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const userResult = await db.query(
      'SELECT id, display_name, username, emoji, name, email, avatar_url, provider FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Get linked providers
    const providersResult = await db.query(
      'SELECT provider, provider_id, email, name, avatar_url, linked_at FROM user_providers WHERE user_id = $1 ORDER BY linked_at ASC',
      [userId]
    );

    res.json({
      id: user.id,
      displayName: user.display_name || user.username || user.name || 'User',
      emoji: user.emoji,
      email: user.email,
      avatarUrl: user.avatar_url,
      providers: providersResult.rows.map(p => ({
        provider: p.provider,
        email: p.email,
        name: p.name,
        avatarUrl: p.avatar_url,
        linkedAt: p.linked_at
      }))
    });
  } catch (err) {
    console.error('Profile fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update profile (display name, emoji)
app.put('/api/profile', express.json(), async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId || !db.isAvailable()) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { displayName, emoji } = req.body;
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (displayName.trim().length > 30) {
    return res.status(400).json({ error: 'displayName must be 30 characters or less' });
  }
  try {
    await db.query(
      'UPDATE users SET display_name = $1, emoji = $2, updated_at = $3 WHERE id = $4',
      [displayName.trim(), typeof emoji === 'string' && emoji ? emoji.slice(0, 10) : null, Date.now(), userId]
    );
    userAuth.invalidate(userId);
    if (social) social.profileChanged(String(userId));
    res.json({ success: true });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Unlink a provider from account
app.delete('/api/profile/providers/:provider', async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId || !db.isAvailable()) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const provider = req.params.provider;
  try {
    // Ensure user has at least one other provider (can't unlink the last one)
    const countResult = await db.query(
      'SELECT COUNT(*) as count FROM user_providers WHERE user_id = $1',
      [userId]
    );
    if (parseInt(countResult.rows[0].count) <= 1) {
      return res.status(400).json({ error: 'Cannot unlink the only connected account' });
    }

    await db.query(
      'DELETE FROM user_providers WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );

    // If the unlinked provider was the primary on users table, update to another linked provider
    const user = await db.query('SELECT provider FROM users WHERE id = $1', [userId]);
    if (user.rows[0] && user.rows[0].provider === provider) {
      const remaining = await db.query(
        'SELECT provider, provider_id, email, name, avatar_url FROM user_providers WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (remaining.rows.length > 0) {
        const p = remaining.rows[0];
        await db.query(
          'UPDATE users SET provider = $1, provider_id = $2, email = COALESCE($3, email), updated_at = $4 WHERE id = $5',
          [p.provider, p.provider_id, p.email, Date.now(), userId]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Provider unlink error:', err.message);
    res.status(500).json({ error: 'Failed to unlink provider' });
  }
});

// OAuth linking routes — when user is already logged in and wants to connect another provider
app.get('/auth/google/link', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  const userId = getAuthUserId(req);
  if (!userId) return res.redirect('/');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/link/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state: createOAuthState(userId)
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/link/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('/?error=link_failed');
  const userId = verifyOAuthState(state);
  if (!userId) return res.redirect('/?error=link_failed');
  // Verify the user making the request is the one who started the link
  const authUserId = getAuthUserId(req);
  if (!authUserId || authUserId !== userId) return res.redirect('/?error=link_failed');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/link/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/?error=link_token_failed');
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await userRes.json();
    await linkProviderToUser(userId, 'google', {
      id: profile.id, email: profile.email, name: profile.name, avatar: profile.picture
    });
    res.redirect('/profile');
  } catch (err) {
    console.error('Google link error:', err.message);
    res.redirect('/?error=link_failed');
  }
});

app.get('/auth/github/link', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).json({ error: 'GitHub OAuth not configured' });
  }
  const userId = getAuthUserId(req);
  if (!userId) return res.redirect('/');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/github/link/callback`,
    scope: 'read:user user:email',
    state: createOAuthState(userId)
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/github/link/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('/?error=link_failed');
  const userId = verifyOAuthState(state);
  if (!userId) return res.redirect('/?error=link_failed');
  const authUserId = getAuthUserId(req);
  if (!authUserId || authUserId !== userId) return res.redirect('/?error=link_failed');
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/github/link/callback`
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/?error=link_token_failed');
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'listen-along' }
    });
    const profile = await userRes.json();
    let email = profile.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'listen-along' }
      });
      const emails = await emailsRes.json();
      const primary = Array.isArray(emails) && emails.find(e => e.primary);
      email = primary ? primary.email : null;
    }
    await linkProviderToUser(userId, 'github', {
      id: String(profile.id), email, name: profile.name || profile.login, avatar: profile.avatar_url
    });
    res.redirect('/profile');
  } catch (err) {
    console.error('GitHub link error:', err.message);
    res.redirect('/?error=link_failed');
  }
});

// Link a provider to an existing user account
async function linkProviderToUser(userId, provider, profile) {
  if (!db.isAvailable()) return;
  const now = Date.now();
  // Check if this provider account is already linked to another user
  const existing = await db.query(
    'SELECT user_id FROM user_providers WHERE provider = $1 AND provider_id = $2',
    [provider, profile.id]
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].user_id === userId) return; // Already linked to this user
    // Remove from the other user — the current user is claiming this provider
    await db.query(
      'DELETE FROM user_providers WHERE provider = $1 AND provider_id = $2',
      [provider, profile.id]
    );
  }
  await db.query(
    `INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, provider_id) DO UPDATE SET user_id = $1, email = $4, name = $5, avatar_url = $6, linked_at = $7`,
    [userId, provider, profile.id, profile.email, profile.name, profile.avatar, now]
  );
}

// Dashboard stats endpoint
app.get('/api/dashboard/stats', adminAuth.requireAdmin, async (req, res) => {
  // Calculate disk usage from songs directory
  let diskUsageBytes = 0;
  let diskFileCount = 0;
  let unregisteredFileCount = 0;
  let unregisteredBytes = 0;
  try {
    const songsDir = library.SONGS_PATH;
    if (fs.existsSync(songsDir)) {
      const knownPathsResult = db.isAvailable()
        ? await db.query('SELECT file_path FROM library_songs')
        : { rows: [] };
      const knownPaths = new Set(knownPathsResult.rows.map(r => r.file_path));

      const files = fs.readdirSync(songsDir).map(f => path.join(songsDir, f));
      if (fs.existsSync(library.LIBRARY_DIR)) {
        files.push(...fs.readdirSync(library.LIBRARY_DIR).map(f => path.join(library.LIBRARY_DIR, f)));
      }
      for (const fullPath of files) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            diskUsageBytes += stat.size;
            diskFileCount++;
            if (!knownPaths.has(fullPath)) {
              unregisteredFileCount++;
              unregisteredBytes += stat.size;
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Private playlists are visible to their owner only — admins included: the
  // dashboard counts them but never lists them.
  const stats = {
    totalLobbies: lobby.lobbies.size,
    privateLobbies: 0,
    totalUsers: 0,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    diskUsage: { bytes: diskUsageBytes, fileCount: diskFileCount, unregisteredFiles: unregisteredFileCount, unregisteredBytes },
    lobbies: []
  };

  for (const [lobbyId, lobbyData] of lobby.lobbies) {
    const users = lobby.getLobbyUsers(lobbyId);
    const userCount = users ? users.length : 0;
    stats.totalUsers += userCount;
    if (access.isPrivate(lobbyData)) { stats.privateLobbies++; continue; }

    const queue = await getQueueAsync(lobbyId);

    stats.lobbies.push({
      id: lobbyId,
      name: lobbyData.name || null,
      userCount,
      queueLength: queue.getSongs().length,
      createdAt: lobbyData.createdAt,
      lastActivity: lobbyData.lastActivity
    });
  }

  res.json(stats);
});

// Song cache / cookie management was removed with server-side downloading.
// Library management (delete songs, tokens, requests) lives on /admin.

// List all registered users (dashboard only)
app.get('/api/dashboard/users', adminAuth.requireAdmin, async (req, res) => {
  if (!db.isAvailable()) {
    return res.json({ users: [] });
  }

  try {
    const result = await db.query(
      'SELECT id, user_id, username, emoji, email, avatar_url, provider, status, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('List users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Approve a user (dashboard only)
app.put('/api/dashboard/users/:id/approve', adminAuth.requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
      ['approved', Date.now(), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    accountStatusChanged(req.params.id, 'approved');
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Approve user error:', err.message);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Reject a user (dashboard only)
app.put('/api/dashboard/users/:id/reject', adminAuth.requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
      ['rejected', Date.now(), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    accountStatusChanged(req.params.id, 'rejected');
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Reject user error:', err.message);
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

// Delete a lobby (dashboard only)
app.delete('/api/dashboard/lobbies/:id', adminAuth.requireAdmin, async (req, res) => {
  const lobbyId = req.params.id;
  const lobbyData = lobby.getLobby(lobbyId);

  if (!access.canAdminDelete(lobbyData)) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  await destroyLobby(lobbyId, { reason: 'This playlist has been deleted by an administrator.' });

  console.log(`Lobby ${lobbyId} deleted via dashboard`);
  res.json({ success: true });
});

// Admin moderation: delete a global chat message (also possible inline over
// the socket, chat:delete). Everyone sees it disappear (chat:deleted).
app.delete('/api/chat/messages/:id', adminAuth.requireAdmin, async (req, res) => {
  if (!social) return res.status(503).json({ error: 'Chat is not ready' });
  const removed = await social.deleteMessage(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Message not found' });
  res.json({ success: true });
});

// Old lobby URLs moved to /playlist/... (the client does the same for in-app
// navigation, see legacyRedirect in frontend/router.js).
app.get(['/lobby/:id', '/lobby/:id/library'], (req, res) => {
  const qs = req.originalUrl.indexOf('?');
  const rest = req.path.endsWith('/library') ? '/library' : '';
  res.redirect(301, `/playlist/${encodeURIComponent(req.params.id)}${rest}${qs >= 0 ? req.originalUrl.slice(qs) : ''}`);
});

// SPA views (auth guard applied above; the client routes them, see frontend/router.js)
app.get(['/playlist/:id', '/playlist/:id/library', '/library', '/profile', '/social'], (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Serve shared YouTube playlist page (public by design, see policyFor in userAuth.js)
app.get('/youtube-playlist', (req, res) => {
  res.sendFile(path.join(frontendPath, 'youtube-playlist.html'));
});

// Serve dashboard page
app.get('/dashboard', (req, res) => {
  if (!adminAuth.isAdmin(req)) return res.redirect('/admin?next=/dashboard');
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Login page (the SPA's login view). Someone already logged in goes on to
// ?next (a same-origin path) or home. After the OAuth round trip the server
// redirects to the remembered ?next itself (see rememberNextPath).
app.get('/login', async (req, res) => {
  let account = null;
  try { ({ account } = await userAuth.identify(req)); } catch {}
  if (account) {
    const next = typeof req.query.next === 'string' && isSafeNextPath(req.query.next) ? req.query.next : '/';
    return res.redirect(next);
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Auth providers info (which providers are configured)
app.get('/api/auth/providers', (req, res) => {
  res.json({
    google: !!GOOGLE_CLIENT_ID,
    github: !!GITHUB_CLIENT_ID
  });
});

// Serve index for root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Set up shared YouTube playlist handlers (separate namespace, no auth)
youtubePlaylist.setupSocketHandlers(io);

// Rooms: APP_ROOM holds every socket of an approved account (library /
// requests broadcasts); userRoom(id) every socket of one account (so a
// denied account can be disconnected everywhere).
const APP_ROOM = 'app';
const userRoom = (id) => `user:${id}`;

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

// Socket.IO handshake (main namespace; /youtube-playlist is public and has no
// such check): only a logged-in account that is not denied / rejected may
// connect. Pending accounts connect for the global chat and people panel;
// every playlist/queue event checks for an approved account itself.
io.use((socket, next) => {
  const headers = socket.request.headers || {};
  if (!socketOriginAllowed(headers)) return next(new Error('Origin not allowed'));
  const userId = userAuth.userIdFromHeaders(headers);
  if (!userId) return next(new Error('Authentication required'));
  userAuth.getAccount(userId).then((account) => {
    if (!account) return next(new Error('Authentication required'));
    if (isBlocked(account.status)) return next(new Error('Access denied'));
    socket.data.userId = userId;
    socket.join(userRoom(userId));
    if (account.status === 'approved') socket.join(APP_ROOM);
    next();
  }).catch((err) => {
    console.error('Socket account lookup failed:', err.message);
    next(new Error('Could not check your account, try again'));
  });
});

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

  // Who this socket is: the users.id from the signed listen_auth cookie sent
  // with the handshake (set by io.use above; never a client-supplied id).
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

    const result = (await editableLobby(lobbyId)) ? await lobby.renameLobby(lobbyId, name, visibleTo) : null;
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

    console.log(`Lobby ${lobbyId} renamed to "${result.lobby.name}"`);
  });

  // Add song to queue. Only songs in the library can be queued; anything else
  // becomes a song request (the server never downloads) that is auto-added to
  // this lobby's queue once someone uploads it with the CLI.
  // addedBy / requester come from the account, never from the client (only
  // without a database, where there are no accounts, is its name used).
  socket.on('queue:add', async ({ lobbyId, query, url, title, libraryId, addedBy: clientAddedBy } = {}) => {
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

    const input = url || query;
    if (!libraryId) socket.emit('queue:adding', { status: 'Looking it up…' });

    let result;
    try {
      result = await resolver.resolve({ input, libraryId, title });
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
    const removed = queue.removeSong(songId);
    if (removed) {
      console.log(`Song removed from lobby ${lobbyId}: ${removed.title}`);
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

  social = createSocial({
    io,
    db,
    presence,
    store: dbAvailable ? chat.createPgStore(db) : chat.createMemoryStore(),
    getLobby: (id) => lobby.getLobby(id),
    isAdmin: (headers) => adminAuth.isAdmin({ headers }),
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
