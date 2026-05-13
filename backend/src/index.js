require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const ytdlp = require('./ytdlp');
const playback = require('./playback');
const lobby = require('./lobby');
const { getQueue, getQueueAsync, deleteQueue } = require('./queue');
const db = require('./db');
const downloader = require('./downloader');
const covers = require('./covers');
const playlist = require('./playlist');
const chat = require('./chat');
const spotify = require('./spotify');
const auth = require('./auth');
const QRCode = require('qrcode');
const pkg = require('../package.json');

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// Simple in-memory rate limiter
const rateLimitMap = new Map(); // key: IP, value: { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
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

// Cache playlist items after initial fetch to avoid re-fetching on confirm
// Key: playlist URL, Value: { items, title, total, limited, fetchedAt }
const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPlaylist(url) {
  const entry = playlistCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PLAYLIST_CACHE_TTL) {
    playlistCache.delete(url);
    return null;
  }
  return entry;
}

function cachePlaylist(url, playlist) {
  playlistCache.set(url, { ...playlist, fetchedAt: Date.now() });
  // Evict old entries
  if (playlistCache.size > 100) {
    const oldest = [...playlistCache.entries()]
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    if (oldest) playlistCache.delete(oldest[0]);
  }
}

// Dashboard authentication
let DASHBOARD_USER = process.env.DASHBOARD_USER;
let DASHBOARD_PASS = process.env.DASHBOARD_PASS;

// Generate random credentials if not set
if (!DASHBOARD_USER || !DASHBOARD_PASS) {
  DASHBOARD_USER = DASHBOARD_USER || 'admin';
  DASHBOARD_PASS = DASHBOARD_PASS || crypto.randomBytes(16).toString('hex');
  console.log('='.repeat(60));
  console.log('Dashboard credentials (auto-generated):');
  console.log(`  Username: ${DASHBOARD_USER}`);
  console.log(`  Password: ${DASHBOARD_PASS}`);
  console.log('Set DASHBOARD_USER and DASHBOARD_PASS env vars to customize.');
  console.log('='.repeat(60));
}

// OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || FRONTEND_URL;
// First approved user becomes auto-approved; set to 'true' to auto-approve everyone
const AUTO_APPROVE = process.env.AUTO_APPROVE === 'true';

// Auth token helpers
function createAuthToken(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

// OAuth CSRF state helpers — signed token instead of raw userId
function createOAuthState(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // Expire after 10 minutes
    if (!data.id || !data.t || Date.now() - data.t > 10 * 60 * 1000) return null;
    return data.id;
  } catch {
    return null;
  }
}

const app = express();
const server = http.createServer(app);

// CORS configuration
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Session configuration
if (!process.env.SESSION_SECRET) {
  console.log('Warning: SESSION_SECRET not set, using random secret (sessions will not persist across restarts)');
}

const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  }
};

// Use PostgreSQL session store if database is available (configured in start())
let sessionMiddleware;
function initSession(pgPool) {
  if (pgPool) {
    sessionConfig.store = new PgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: true
    });
  }
  sessionMiddleware = session(sessionConfig);
  app.use(sessionMiddleware);

  // Initialize Passport
  auth.init();
  app.use(auth.passport.initialize());
  app.use(auth.passport.session());

  // Auth routes (public)
  auth.setupRoutes(app);
}

// Serve static frontend files
// In Docker: /app/src/index.js -> /app/frontend (../frontend)
// Local dev: backend/src/index.js -> frontend (../../frontend)
const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');

// Serve login page static assets without auth
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(frontendPath, 'login.html'));
});
app.use(express.static(frontendPath));

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions
});

// Auth guard - protect all routes except public ones
app.use((req, res, next) => {
  // Public paths that don't require authentication
  const publicPaths = ['/health', '/auth/', '/login', '/changelog', '/api/auth/', '/api/version', '/api/changelog'];
  const isPublic = publicPaths.some(p => req.path === p || req.path.startsWith(p));
  if (isPublic) return next();

  // Static assets are already served above by express.static
  // If we get here with a non-API path and it wasn't caught by static, apply auth
  if (req.isAuthenticated && !req.isAuthenticated()) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const ytdlpAvailable = await ytdlp.checkAvailable();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp: ytdlpAvailable ? 'available' : 'unavailable',
    database: db.isAvailable() ? 'connected' : 'unavailable',
    songCache: db.isAvailable() ? 'enabled' : 'disabled'
  });
});

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json({
    version: process.env.VERSION || pkg.version,
    name: pkg.name
  });
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

// User registration / status check
app.post('/api/auth/register', async (req, res) => {
  if (!db.isAvailable()) {
    // No database — skip approval, everyone is approved
    return res.json({ status: 'approved' });
  }

  const { userId, username, emoji } = req.body;
  if (!userId || !username) {
    return res.status(400).json({ error: 'userId and username are required' });
  }

  try {
    // Check if user already exists
    const existing = await db.query(
      'SELECT id, user_id, username, emoji, status, created_at FROM users WHERE user_id = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      // Update username/emoji if changed
      if (user.username !== username || user.emoji !== (emoji || null)) {
        await db.query(
          'UPDATE users SET username = $1, emoji = $2, updated_at = $3 WHERE user_id = $4',
          [username, emoji || null, Date.now(), userId]
        );
      }
      return res.json({ status: user.status, userId: user.user_id });
    }

    // New user — check if this is the first user (auto-approve)
    const countResult = await db.query('SELECT COUNT(*) as count FROM users');
    const isFirst = parseInt(countResult.rows[0].count) === 0;
    const status = isFirst ? 'approved' : 'pending';

    const now = Date.now();
    await db.query(
      `INSERT INTO users (user_id, username, emoji, provider, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, username, emoji || null, 'local', status, now, now]
    );

    return res.json({ status, userId });
  } catch (err) {
    console.error('User registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Check user approval status
app.get('/api/auth/status', async (req, res) => {
  if (!db.isAvailable()) {
    return res.json({ status: 'approved' });
  }

  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const result = await db.query(
      'SELECT status FROM users WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ status: 'unregistered' });
    }
    res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error('Auth status error:', err.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Generate QR code for a lobby invite link
app.get('/api/qr/:lobbyId', async (req, res) => {
  const lobbyId = req.params.lobbyId;
  const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/lobby/${lobbyId}`;

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

// Browse cached song library (ready songs only, no dashboard auth)
app.get('/api/library', async (req, res) => {
  if (!db.isAvailable()) {
    return res.json({ songs: [] });
  }
  try {
    const result = await db.query(
      `SELECT id, url, title, duration, thumbnail_url, created_at
       FROM songs WHERE status = 'ready' ORDER BY title ASC`
    );
    res.json({ songs: result.rows });
  } catch (err) {
    console.error('Library fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// Get video metadata
app.get('/api/metadata', rateLimit, async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  try {
    const metadata = await ytdlp.getMetadata(q);
    res.json(metadata);
  } catch (err) {
    console.error('Metadata error:', err.message);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({
      error: err.message,
      code: err.code || 'UNKNOWN'
    });
  }
});

// Stream audio - serves cached files when available, falls back to live transcoding
app.get('/api/stream', rateLimit, async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  try {
    // Check if we have a cached version
    const cachedSong = await downloader.getCachedSong(q);

    if (cachedSong && cachedSong.status === 'ready' && downloader.isCachedFileValid(cachedSong.file_path)) {
      // Serve from cache
      console.log(`Serving cached song: ${q}`);

      const { stream, size } = downloader.createCachedStream(cachedSong.file_path);

      // Set response headers for cached file
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

      // Handle Range requests for cached files
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
        const chunkSize = (end - start) + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', chunkSize);

        const rangeStream = require('fs').createReadStream(cachedSong.file_path, { start, end });
        rangeStream.pipe(res);

        req.on('close', () => {
          rangeStream.destroy();
        });

        return;
      }

      stream.pipe(res);

      req.on('close', () => {
        stream.destroy();
      });

      return;
    }

    // Fall back to live transcoding
    // Get metadata first to validate the video exists
    await ytdlp.getMetadata(q);

    // Start background download for future requests
    downloader.startDownload(q).catch(err => {
      console.error('Background download failed:', err.message);
    });

    // Set response headers for audio streaming
    // Safari requires specific headers for audio playback
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    // Allow cross-origin requests for audio
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    // Handle Range requests (required for Safari)
    const range = req.headers.range;
    if (range) {
      // For live transcoded streams, we can't truly seek, but we need to
      // respond properly to Range requests for Safari compatibility
      // Return 200 with full content for range requests on live streams
      console.log('Range request received:', range);
    }

    const { stream, kill, getError } = ytdlp.createTranscodedStream(q);

    // Pipe the audio stream to the response
    stream.pipe(res);

    // Handle client disconnect
    req.on('close', () => {
      kill();
    });

    // Handle stream errors
    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
      kill();
    });

    stream.on('end', () => {
      const error = getError();
      if (error && !res.headersSent) {
        console.error('yt-dlp error:', error);
      }
    });

  } catch (err) {
    console.error('Stream setup error:', err.message);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({
      error: err.message,
      code: err.code || 'UNKNOWN'
    });
  }
});

// List all active lobbies (public)
app.get('/api/lobbies', async (req, res) => {
  const allLobbies = lobby.getAllLobbies();

  const lobbies = await Promise.all(allLobbies.map(async l => {
    const queue = await getQueueAsync(l.id);
    return {
      id: l.id,
      name: l.name || null,
      listeningMode: l.listeningMode,
      pinned: l.pinned || false,
      userCount: l.userCount,
      songCount: queue.getSongs().length,
      createdAt: l.createdAt
    };
  }));

  res.json({ lobbies });
});

// Create a new lobby
app.post('/api/lobbies', (req, res) => {
  const newLobby = lobby.createLobby(null);
  res.json({
    id: newLobby.id,
    link: `/lobby/${newLobby.id}`
  });
});

// Get lobby info
app.get('/api/lobbies/:id', (req, res) => {
  const lobbyData = lobby.getLobby(req.params.id);
  if (!lobbyData) {
    return res.status(404).json({ error: 'Lobby not found' });
  }
  res.json({
    id: lobbyData.id,
    userCount: lobbyData.users.size,
    users: lobby.getLobbyUsers(req.params.id)
  });
});

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

  // Not cached - redirect to fallback URL if provided (validate to prevent open redirect)
  if (fallbackUrl) {
    try {
      const parsed = new URL(fallbackUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Invalid fallback URL' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid fallback URL' });
    }
    return res.redirect(fallbackUrl);
  }

  res.status(404).json({ error: 'Cover not found' });
});

// Playlist endpoints (require database)
app.get('/api/playlists', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing query parameter: userId' });
  }
  if (!db.isAvailable()) {
    return res.json({ playlists: [] });
  }
  try {
    const playlists = await playlist.getPlaylistsByUser(userId);
    res.json({ playlists });
  } catch (err) {
    console.error('Get playlists error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

app.post('/api/playlists', async (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) {
    return res.status(400).json({ error: 'Missing required fields: userId, name' });
  }
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const created = await playlist.createPlaylist(userId, name);
    res.status(201).json(created);
  } catch (err) {
    console.error('Create playlist error:', err.message);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

app.get('/api/playlists/:id', async (req, res) => {
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const p = await playlist.getPlaylist(req.params.id);
    if (!p) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json(p);
  } catch (err) {
    console.error('Get playlist error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

app.patch('/api/playlists/:id', async (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) {
    return res.status(400).json({ error: 'Missing required fields: userId, name' });
  }
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const updated = await playlist.renamePlaylist(req.params.id, userId, name);
    if (!updated) {
      return res.status(404).json({ error: 'Playlist not found or unauthorized' });
    }
    res.json(updated);
  } catch (err) {
    console.error('Rename playlist error:', err.message);
    res.status(500).json({ error: 'Failed to rename playlist' });
  }
});

app.delete('/api/playlists/:id', async (req, res) => {
  const userId = req.query.userId || (req.body && req.body.userId);
  if (!userId) {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const deleted = await playlist.deletePlaylist(req.params.id, userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Playlist not found or unauthorized' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete playlist error:', err.message);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

app.post('/api/playlists/:id/songs', async (req, res) => {
  const { url, title, duration, thumbnail } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const song = await playlist.addSong(req.params.id, { url, title, duration, thumbnail });
    if (!song) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.status(201).json(song);
  } catch (err) {
    console.error('Add playlist song error:', err.message);
    res.status(500).json({ error: 'Failed to add song to playlist' });
  }
});

app.delete('/api/playlists/:playlistId/songs/:songId', async (req, res) => {
  if (!db.isAvailable()) {
    return res.status(503).json({ error: 'Database not available' });
  }
  try {
    const removed = await playlist.removeSong(req.params.playlistId, req.params.songId);
    if (!removed) {
      return res.status(404).json({ error: 'Song not found in playlist' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Remove playlist song error:', err.message);
    res.status(500).json({ error: 'Failed to remove song from playlist' });
  }
});

// Dashboard basic authentication middleware
const dashboardAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const idx = credentials.indexOf(':');
  const user = credentials.slice(0, idx);
  const pass = credentials.slice(idx + 1);

  // Use constant-time comparison to prevent timing attacks
  const userMatch = user.length === DASHBOARD_USER.length &&
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(DASHBOARD_USER));
  const passMatch = pass.length === DASHBOARD_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(DASHBOARD_PASS));

  if (userMatch && passMatch) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
    res.status(401).send('Invalid credentials');
  }
};

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

  // Check if another user exists with the same email — link accounts
  if (profile.email) {
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

// Set auth cookie and redirect
function setAuthCookieAndRedirect(res, user) {
  const token = createAuthToken(user.id);
  res.cookie('listen_auth', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/'
  });
  res.redirect('/');
}

// Google OAuth
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
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
      name: profile.name,
      avatar: profile.picture
    });
    if (!user) return res.redirect('/?error=db_unavailable');
    setAuthCookieAndRedirect(res, user);
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
    // Get primary email if not public
    let email = profile.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'User-Agent': 'listen-along'
        }
      });
      const emails = await emailsRes.json();
      const primary = Array.isArray(emails) && emails.find(e => e.primary);
      email = primary ? primary.email : null;
    }
    const user = await upsertOAuthUser('github', {
      id: String(profile.id),
      email,
      name: profile.name || profile.login,
      avatar: profile.avatar_url
    });
    if (!user) return res.redirect('/?error=db_unavailable');
    setAuthCookieAndRedirect(res, user);
  } catch (err) {
    console.error('GitHub OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Auth status endpoint
app.get('/api/auth/me', async (req, res) => {
  const token = parseCookie(req.headers.cookie, 'listen_auth');
  const payload = verifyAuthToken(token);
  if (!payload || !db.isAvailable()) {
    return res.json({ authenticated: false });
  }
  try {
    const result = await db.query('SELECT id, provider, email, name, display_name, emoji, avatar_url, status FROM users WHERE id = $1', [payload.id]);
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
  res.clearCookie('listen_auth', { path: '/' });
  res.json({ success: true });
});

// Admin: list pending users (dashboard auth)
app.get('/api/auth/users', dashboardAuth, async (req, res) => {
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
app.post('/api/auth/users/:userId/status', dashboardAuth, express.json(), async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or denied' });
  }
  try {
    await db.query('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Update user status error:', err.message);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// Simple cookie parser (no dependency needed)
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=').slice(1).join('=').trim() : null;
}

// Helper: get authenticated user ID from cookie
function getAuthUserId(req) {
  const token = parseCookie(req.headers.cookie, 'listen_auth');
  const payload = verifyAuthToken(token);
  return payload ? payload.id : null;
}

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
      [displayName.trim(), emoji || null, Date.now(), userId]
    );
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
    res.redirect('/#profile');
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
    res.redirect('/#profile');
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
app.get('/api/dashboard/stats', dashboardAuth, async (req, res) => {
  // Calculate disk usage from songs directory
  let diskUsageBytes = 0;
  let diskFileCount = 0;
  try {
    const songsDir = downloader.SONGS_PATH;
    if (fs.existsSync(songsDir)) {
      const files = fs.readdirSync(songsDir);
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(songsDir, file));
          if (stat.isFile()) {
            diskUsageBytes += stat.size;
            diskFileCount++;
          }
        } catch {}
      }
    }
  } catch {}

  const stats = {
    totalLobbies: lobby.lobbies.size,
    totalUsers: 0,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    diskUsage: { bytes: diskUsageBytes, fileCount: diskFileCount },
    lobbies: []
  };

  for (const [lobbyId, lobbyData] of lobby.lobbies) {
    const users = lobby.getLobbyUsers(lobbyId);
    const userCount = users ? users.length : 0;
    stats.totalUsers += userCount;

    const queue = await getQueueAsync(lobbyId);
    const playbackState = playback.getState(lobbyId);

    stats.lobbies.push({
      id: lobbyId,
      name: lobbyData.name || null,
      userCount,
      listeningMode: lobbyData.listeningMode || 'synchronized',
      queueLength: queue.getSongs().length,
      currentTrack: playbackState?.currentTrack?.title || null,
      isPlaying: playbackState?.isPlaying || false,
      createdAt: lobbyData.createdAt,
      lastActivity: lobbyData.lastActivity
    });
  }

  res.json(stats);
});

// Cache stats endpoint (dashboard only)
app.get('/api/dashboard/cache', dashboardAuth, async (req, res) => {
  if (!db.isAvailable()) {
    return res.json({
      enabled: false,
      message: 'Database not available - caching disabled'
    });
  }

  try {
    const stats = await db.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM songs
      GROUP BY status
    `);

    const statusCounts = {};
    for (const row of stats.rows) {
      statusCounts[row.status] = parseInt(row.count);
    }

    const totalSize = await db.query(`
      SELECT COUNT(*) as total,
             SUM(duration) as total_duration
      FROM songs
      WHERE status = 'ready'
    `);

    res.json({
      enabled: true,
      songsPath: downloader.SONGS_PATH,
      stats: {
        pending: statusCounts.pending || 0,
        downloading: statusCounts.downloading || 0,
        ready: statusCounts.ready || 0,
        error: statusCounts.error || 0,
        totalCached: parseInt(totalSize.rows[0]?.total) || 0,
        totalDuration: parseFloat(totalSize.rows[0]?.total_duration) || 0
      }
    });
  } catch (err) {
    console.error('Cache stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

// List all cached songs (dashboard only)
app.get('/api/dashboard/cache/songs', dashboardAuth, async (req, res) => {
  try {
    const songs = await downloader.getAllSongs();
    res.json({ songs });
  } catch (err) {
    console.error('List songs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch cached songs' });
  }
});

// Delete a single cached song (dashboard only)
app.delete('/api/dashboard/cache/songs/:id', dashboardAuth, async (req, res) => {
  const songId = req.params.id;
  try {
    const deleted = await downloader.deleteSong(songId);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Song not found' });
    }
  } catch (err) {
    console.error('Delete song error:', err.message);
    res.status(500).json({ error: 'Failed to delete song' });
  }
});

// Delete all cached songs (dashboard only)
app.delete('/api/dashboard/cache/songs', dashboardAuth, async (req, res) => {
  try {
    const count = await downloader.deleteAllSongs();
    res.json({ success: true, deleted: count });
  } catch (err) {
    console.error('Delete all songs error:', err.message);
    res.status(500).json({ error: 'Failed to delete songs' });
  }
});

// Delete all error songs (dashboard only)
app.delete('/api/dashboard/cache/errors', dashboardAuth, async (req, res) => {
  try {
    const count = await downloader.deleteErrorSongs();
    res.json({ success: true, deleted: count });
  } catch (err) {
    console.error('Delete error songs error:', err.message);
    res.status(500).json({ error: 'Failed to delete error songs' });
  }
});

// Delete orphaned cached songs (not in any queue or playlist)
app.delete('/api/dashboard/cache/orphaned', dashboardAuth, async (req, res) => {
  try {
    const count = await downloader.deleteOrphanedSongs();
    res.json({ success: true, deleted: count });
  } catch (err) {
    console.error('Delete orphaned songs error:', err.message);
    res.status(500).json({ error: 'Failed to delete orphaned songs' });
  }
});

// List all registered users (dashboard only)
app.get('/api/dashboard/users', dashboardAuth, async (req, res) => {
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
app.put('/api/dashboard/users/:id/approve', dashboardAuth, async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
      ['approved', Date.now(), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Approve user error:', err.message);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Reject a user (dashboard only)
app.put('/api/dashboard/users/:id/reject', dashboardAuth, async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
      ['rejected', Date.now(), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Reject user error:', err.message);
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

// Delete a lobby (dashboard only)
app.delete('/api/dashboard/lobbies/:id', dashboardAuth, (req, res) => {
  const lobbyId = req.params.id;
  const lobbyData = lobby.getLobby(lobbyId);

  if (!lobbyData) {
    return res.status(404).json({ error: 'Lobby not found' });
  }

  // Notify all users in the lobby that it's being closed
  io.to(lobbyId).emit('lobby:closed', { message: 'This lobby has been closed by an administrator.' });

  // Disconnect all sockets from the room
  io.in(lobbyId).socketsLeave(lobbyId);

  // Clean up playback, queue, and chat state
  playback.cleanupLobby(lobbyId);
  deleteQueue(lobbyId);
  chat.cleanupLobby(lobbyId);

  // Delete the lobby
  lobby.deleteLobby(lobbyId);

  console.log(`Lobby ${lobbyId} deleted via dashboard`);
  res.json({ success: true });
});

// Serve lobby page (auth guard applied above)
app.get('/lobby/:id', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Serve dashboard page
app.get('/dashboard', dashboardAuth, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Serve login page
app.get('/login', (req, res) => {
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

// Set up playback sync handlers
playback.setupSocketHandlers(io);

// Set up download progress event handlers
downloader.downloadEvents.on('status', (data) => {
  if (data.lobbyId) {
    io.to(data.lobbyId).emit('download:status', {
      url: data.url,
      songId: data.songId,
      status: data.status,
      percent: data.percent || 0,
      error: data.error
    });
  }
});

downloader.downloadEvents.on('progress', (data) => {
  if (data.lobbyId) {
    io.to(data.lobbyId).emit('download:progress', {
      url: data.url,
      songId: data.songId,
      percent: data.percent
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  let currentLobby = null;

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

  // Check user approval status (returns true if approved or DB unavailable)
  const checkUserApproved = async (userId) => {
    if (!db.isAvailable() || !userId) return true;
    try {
      const result = await db.query('SELECT status FROM users WHERE user_id = $1', [userId]);
      if (result.rows.length === 0) return true; // Unregistered users pass through (frontend handles registration)
      return result.rows[0].status === 'approved';
    } catch {
      return true; // On DB error, allow access
    }
  };

  // Create a new lobby
  socket.on('lobby:create', async ({ username, emoji, listeningMode, name, lobbyId: requestedId, userId }) => {
    // Check user approval
    if (!(await checkUserApproved(userId))) {
      socket.emit('lobby:error', { message: 'Your account is pending approval' });
      return;
    }

    // Validate name uniqueness if provided
    if (name && name.trim()) {
      const trimmedName = name.trim();
      if (trimmedName.length > 50) {
        socket.emit('lobby:error', { message: 'Name must be 50 characters or less' });
        return;
      }
      if (lobby.isNameTaken(trimmedName)) {
        socket.emit('lobby:error', { message: 'A lobby with that name already exists' });
        return;
      }
    }

    // If a specific lobby ID was requested (e.g. from URL-based creation), check it doesn't already exist
    const customId = requestedId || null;
    if (customId) {
      const existing = await lobby.getLobbyAsync(customId);
      if (existing) {
        socket.emit('lobby:error', { message: 'A lobby with that ID already exists' });
        return;
      }
    }

    const lobbyName = (name && name.trim()) ? name.trim() : null;
    const newLobby = await lobby.createLobbyAsync(null, customId, listeningMode, lobbyName);
    const result = await lobby.joinLobbyAsync(newLobby.id, socket.id, username || 'Anonymous', emoji);

    currentLobby = newLobby.id;
    socket.join(newLobby.id);

    socket.emit('lobby:created', {
      lobbyId: newLobby.id,
      name: newLobby.name,
      listeningMode: newLobby.listeningMode,
      pinned: newLobby.pinned || false,
      user: result.user,
      users: lobby.getLobbyUsers(newLobby.id)
    });

    console.log(`Lobby ${newLobby.id} created by ${username} (${newLobby.listeningMode})${newLobby.name ? ` name="${newLobby.name}"` : ''}`);
  });

  // Handle joining a lobby room (integrates with lobby system)
  socket.on('lobby:join', async ({ lobbyId, username, emoji, userId }) => {
    // Check user approval
    if (!(await checkUserApproved(userId))) {
      socket.emit('lobby:error', { message: 'Your account is pending approval' });
      return;
    }

    // Check if lobby exists; if not, ask user to select room type
    let lobbyData = await lobby.getLobbyAsync(lobbyId);
    if (!lobbyData) {
      socket.emit('lobby:not-found', { lobbyId });
      return;
    }

    if (currentLobby) {
      const user = await lobby.leaveLobby(currentLobby, socket.id);
      if (user) {
        socket.leave(currentLobby);
        const remainingUsers = lobby.getLobbyUsers(currentLobby);
        socket.to(currentLobby).emit('user-left', {
          user,
          users: remainingUsers
        });
        // Stop sync timer when lobby becomes empty to prevent leaked intervals
        if (remainingUsers.length === 0) {
          playback.stopSyncTimer(currentLobby);
        }
      }
    }

    const result = await lobby.joinLobbyAsync(lobbyId, socket.id, username || 'Anonymous', emoji);
    if (!result) {
      socket.emit('lobby:error', { message: 'Failed to join lobby' });
      return;
    }
    currentLobby = lobbyId;

    // Notify existing members BEFORE joining the room
    // This ensures the joining user cannot receive their own join notification
    socket.to(lobbyId).emit('lobby:user-joined', {
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Now join the Socket.IO room
    socket.join(lobbyId);

    // Send joined confirmation to the user
    const listeningMode = lobby.getListeningMode(lobbyId);
    const joinedLobbyData = await lobby.getLobbyAsync(lobbyId);
    socket.emit('lobby:joined', {
      lobbyId,
      name: joinedLobbyData ? joinedLobbyData.name : null,
      listeningMode,
      pinned: joinedLobbyData ? (joinedLobbyData.pinned || false) : false,
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    console.log(`User ${username} joined lobby ${lobbyId} (${listeningMode})`);

    // Restore playback state from DB if not already in memory
    await playback.initLobbyFromDB(lobbyId);

    // Set user's currentTrack for listener display
    if (listeningMode === 'synchronized') {
      const pbState = playback.getState(lobbyId);
      if (pbState && pbState.currentTrack) {
        lobby.setUserCurrentTrack(lobbyId, socket.id, pbState.currentTrack);
      }
    }

    // Send current playback state to new user joining mid-song
    // Only send sync state for synchronized lobbies
    const playbackState = playback.getJoinState(lobbyId);
    if (playbackState && listeningMode === 'synchronized') {
      socket.emit('playback:sync', playbackState);
    }

    // Send current queue state to new joiner
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  socket.on('lobby:leave', ({ lobbyId }) => {
    if (lobbyId) {
      handleLeave(socket, lobbyId);
    }
    currentLobby = null;
  });

  // Set user mode (listening or lobby)
  socket.on('mode:set', ({ lobbyId, mode }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const user = lobby.setUserMode(lobbyId, socket.id, mode);
    if (user) {
      console.log(`User ${user.username} switched to ${mode} mode in lobby ${lobbyId}`);

      // Update currentTrack based on mode
      if (mode === 'lobby') {
        lobby.setUserCurrentTrack(lobbyId, socket.id, null);
      } else if (mode === 'listening' && lobby.getListeningMode(lobbyId) === 'synchronized') {
        const playbackState = playback.getState(lobbyId);
        if (playbackState && playbackState.currentTrack) {
          lobby.setUserCurrentTrack(lobbyId, socket.id, playbackState.currentTrack);
        }
      }

      // Broadcast updated user list to all in lobby
      io.to(lobbyId).emit('users:updated', {
        users: lobby.getLobbyUsers(lobbyId)
      });

      // Confirm mode change to the user
      socket.emit('mode:changed', { mode: user.mode });
    }
  });

  // Update user profile (name/emoji)
  socket.on('user:update', ({ lobbyId, username, emoji }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const user = lobby.updateUser(lobbyId, socket.id, { username, emoji });
    if (user) {
      // Broadcast updated user list to all in lobby
      io.to(lobbyId).emit('users:updated', {
        users: lobby.getLobbyUsers(lobbyId)
      });
    }
  });

  // Report currently playing track (for independent mode listener display)
  socket.on('listener:now-playing', ({ lobbyId, track }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const user = lobby.setUserCurrentTrack(lobbyId, socket.id, track);
    if (user) {
      io.to(lobbyId).emit('users:updated', {
        users: lobby.getLobbyUsers(lobbyId)
      });

      // Notify followers of this user to sync to the same track
      const followers = lobby.getFollowers(lobbyId, socket.id);
      if (followers.length > 0 && track) {
        // Find the song in queue that matches this track
        const queue = getQueue(lobbyId);
        const songs = queue.getSongs();
        const songIndex = songs.findIndex(s => s.title === track.title);
        const song = songIndex >= 0 ? songs[songIndex] : null;

        for (const follower of followers) {
          io.to(follower.socketId).emit('follow:sync', {
            leaderSocketId: socket.id,
            track: song || { title: track.title, thumbnail: track.thumbnail }
          });
        }
      }
    }
  });

  // Follow another user in independent mode (listen to same songs)
  socket.on('follow:start', ({ lobbyId, targetSocketId }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    if (lobby.getListeningMode(lobbyId) !== 'independent') return;

    const user = lobby.setUserFollowing(lobbyId, socket.id, targetSocketId);
    if (!user) {
      socket.emit('follow:error', { message: 'Cannot follow that user' });
      return;
    }

    // Get the target user's current track so follower can sync immediately
    const users = lobby.getLobbyUsers(lobbyId);
    const target = users.find(u => u.socketId === targetSocketId);

    io.to(lobbyId).emit('users:updated', { users });

    if (target && target.currentTrack) {
      // Find the full song object in queue
      const queue = getQueue(lobbyId);
      const songs = queue.getSongs();
      const songIndex = songs.findIndex(s => s.title === target.currentTrack.title);
      const song = songIndex >= 0 ? songs[songIndex] : null;

      socket.emit('follow:sync', {
        leaderSocketId: targetSocketId,
        track: song || target.currentTrack
      });
    }

    console.log(`User ${socket.id} now following ${targetSocketId} in lobby ${lobbyId}`);
  });

  // Stop following
  socket.on('follow:stop', ({ lobbyId }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const user = lobby.setUserFollowing(lobbyId, socket.id, null);
    if (user) {
      io.to(lobbyId).emit('users:updated', {
        users: lobby.getLobbyUsers(lobbyId)
      });
    }
  });

  // Pin/unpin lobby (make persistent)
  socket.on('lobby:pin', async ({ lobbyId, pinned }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const result = await lobby.pinLobby(lobbyId, !!pinned);
    if (!result) {
      socket.emit('lobby:error', { message: 'Lobby not found' });
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
  socket.on('lobby:rename', async ({ lobbyId, name }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const result = await lobby.renameLobby(lobbyId, name);
    if (!result) {
      socket.emit('lobby:error', { message: 'Lobby not found' });
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

    console.log(`Lobby ${lobbyId} renamed to "${result.lobby.name}"`);
  });

  // Add song to queue
  socket.on('queue:add', async ({ lobbyId, query, url, title, duration, addedBy, thumbnail }) => {
    if (!checkSocketRateLimit()) {
      socket.emit('queue:error', { message: 'Too many requests, please slow down' });
      return;
    }

    if (!verifyLobbyMembership(lobbyId)) {
      socket.emit('queue:error', { message: 'Not a member of this lobby' });
      return;
    }

    const queue = await getQueueAsync(lobbyId);
    const inputUrl = url || query;

    // Check if this is a Spotify URL
    const spotifyParsed = inputUrl ? spotify.parseSpotifyUrl(inputUrl) : null;
    if (spotifyParsed) {
      try {
        if (spotifyParsed.type === 'playlist') {
          socket.emit('queue:adding', { status: 'Loading Spotify playlist...' });
          const playlist = await spotify.getPlaylistTracks(inputUrl);

          if (playlist.items.length === 0) {
            socket.emit('queue:error', { message: 'Spotify playlist is empty' });
            return;
          }

          cachePlaylist(inputUrl, {
            title: playlist.title,
            items: playlist.items.map(item => ({
              title: item.title,
              duration: item.duration,
              thumbnail: item.thumbnail,
              url: `ytsearch:${item.searchQuery}`,
              uploader: item.artist
            })),
            total: playlist.total,
            limited: playlist.limited
          });

          socket.emit('queue:playlist-confirm', {
            lobbyId,
            url: inputUrl,
            playlistTitle: playlist.title,
            songCount: playlist.items.length,
            totalCount: playlist.total,
            limited: playlist.limited,
            items: playlist.items.map(item => ({ title: item.title, duration: item.duration, thumbnail: item.thumbnail })),
            firstSong: playlist.items[0] ? { title: playlist.items[0].title, duration: playlist.items[0].duration } : null,
            songMeta: null,
            addedBy
          });
          return;
        }

        // Spotify track: look up metadata then search YouTube
        socket.emit('queue:adding', { status: 'Looking up Spotify track...' });
        const trackInfo = await spotify.getTrack(inputUrl);

        socket.emit('queue:adding', { status: 'Finding on YouTube...' });
        const metadata = await ytdlp.getMetadata(`ytsearch:${trackInfo.searchQuery}`);

        if (!metadata) {
          socket.emit('queue:error', { message: `Could not find "${trackInfo.title}" on YouTube` });
          return;
        }

        url = metadata.url;
        title = trackInfo.title;
        duration = metadata.duration;
        thumbnail = trackInfo.thumbnail || metadata.thumbnail;
      } catch (err) {
        console.error('[Spotify] Import failed:', {
          url: inputUrl,
          type: spotifyParsed.type,
          error: err.message,
          stack: err.stack
        });
        socket.emit('queue:error', { message: `Failed to process Spotify link: ${err.message}` });
        return;
      }
    }

    // Check if this is a playlist URL
    if (!spotifyParsed && inputUrl && ytdlp.isPlaylistUrl(inputUrl)) {
      try {
        // Check if URL also contains a specific video (watch?v=xxx&list=yyy)
        let videoId = null;
        try {
          const parsed = new URL(inputUrl);
          videoId = parsed.searchParams.get('v');
        } catch {}

        // Fetch playlist info, and song metadata in parallel if URL has a video ID
        const [playlist, songMeta] = await Promise.all([
          ytdlp.getPlaylistItems(inputUrl),
          videoId ? ytdlp.getMetadata(`https://www.youtube.com/watch?v=${videoId}`).catch(() => null) : Promise.resolve(null)
        ]);

        const items = playlist.items;

        if (items.length === 0) {
          socket.emit('queue:error', { message: 'Playlist is empty' });
          return;
        }

        // Cache playlist items to avoid re-fetching when user confirms
        cachePlaylist(inputUrl, playlist);

        // Send playlist info with full items list for selection UI
        socket.emit('queue:playlist-confirm', {
          lobbyId,
          url: inputUrl,
          playlistTitle: playlist.title,
          songCount: items.length,
          totalCount: playlist.total,
          limited: playlist.limited,
          items: items.map(item => ({ title: item.title, duration: item.duration, thumbnail: item.thumbnail })),
          firstSong: items[0] ? { title: items[0].title, duration: items[0].duration } : null,
          songMeta: songMeta ? { title: songMeta.title, uploader: songMeta.uploader, duration: songMeta.duration } : null,
          addedBy
        });

        return;
      } catch (err) {
        console.error('Playlist fetch error:', err);
        socket.emit('queue:error', { message: `Failed to load playlist: ${err.message}` });
        return;
      }
    }

    // Regular single video handling
    // If query is provided, fetch metadata first
    if (query && !title) {
      try {
        socket.emit('queue:adding', { status: 'fetching metadata...' });
        const metadata = await ytdlp.getMetadata(query);
        if (metadata) {
          url = metadata.url || query;
          title = metadata.title || 'Unknown';
          duration = metadata.duration;
          thumbnail = metadata.thumbnail;
        } else {
          socket.emit('queue:error', { message: 'Could not fetch video metadata' });
          return;
        }
      } catch (err) {
        console.error('Metadata fetch error:', err);
        socket.emit('queue:error', { message: 'Failed to fetch video info' });
        return;
      }
    }

    const song = queue.addSong({ url: url || query, title: title || 'Unknown', duration, addedBy, thumbnail });
    console.log(`Song added to lobby ${lobbyId}: ${song.title}`);

    // Start background download for the song
    downloader.startDownload(url || query, {
      title: title || 'Unknown',
      duration,
      thumbnail
    }, lobbyId).catch(err => {
      console.error(`Background download failed: ${err.message}`);
    });

    // Cache thumbnail in background (non-blocking)
    if (thumbnail) {
      covers.cacheCover(song.id, thumbnail).catch(err => {
        console.error(`Failed to cache cover for ${song.id}:`, err.message);
      });
    }

    // If this is the first song and nothing is playing, start playback
    if (queue.getSongs().length === 1) {
      queue.setCurrentIndex(0);
      playback.setTrack(lobbyId, song, true, io);
    }

    // Broadcast updated queue to all in lobby (after potential currentIndex change)
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Handle playlist add after user confirms via dialog
  socket.on('queue:playlist-add', async ({ lobbyId, url, mode, selectedIndices, addedBy }) => {
    const queue = await getQueueAsync(lobbyId);

    try {
      // Use cached playlist items if available, otherwise re-fetch
      const cached = getCachedPlaylist(url);
      let playlistData;
      if (cached) {
        playlistData = cached;
      } else {
        socket.emit('queue:adding', { status: 'Loading playlist...' });
        playlistData = await ytdlp.getPlaylistItems(url);
      }
      const allItems = playlistData.items;

      if (allItems.length === 0) {
        socket.emit('queue:error', { message: 'Playlist is empty' });
        return;
      }

      if (mode === 'single') {
        // Add only the first song
        const item = allItems[0];
        const wasEmpty = queue.getSongs().length === 0;

        const song = queue.addSong({
          url: item.url,
          title: item.title,
          duration: item.duration,
          addedBy,
          thumbnail: item.thumbnail
        });

        downloader.startDownload(item.url, {
          title: item.title,
          duration: item.duration
        }, lobbyId).catch(err => {
          console.error(`Background download failed: ${err.message}`);
        });

        if (item.thumbnail) {
          covers.cacheCover(song.id, item.thumbnail).catch(() => {});
        }

        console.log(`Single song from playlist "${playlistData.title}" added to lobby ${lobbyId}: ${item.title}`);

        if (wasEmpty) {
          queue.setCurrentIndex(0);
          playback.setTrack(lobbyId, song, true, io);
        }

        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
      } else {
        // Filter items by selectedIndices if provided, otherwise use all
        const items = Array.isArray(selectedIndices)
          ? selectedIndices.filter(i => i >= 0 && i < allItems.length).map(i => allItems[i])
          : allItems;

        if (items.length === 0) {
          socket.emit('queue:error', { message: 'No songs selected' });
          return;
        }

        console.log(`Adding ${items.length} songs from playlist "${playlistData.title}" to lobby ${lobbyId}`);

        const wasEmpty = queue.getSongs().length === 0;

        // Add first song immediately so playback can start right away
        const firstItem = items[0];
        const firstSong = queue.addSong({
          url: firstItem.url,
          title: firstItem.title,
          duration: firstItem.duration,
          addedBy,
          thumbnail: firstItem.thumbnail
        });

        // Download first song and wait for it to start
        downloader.startDownload(firstItem.url, {
          title: firstItem.title,
          duration: firstItem.duration
        }, lobbyId).catch(err => {
          console.error(`Background download failed for playlist item: ${err.message}`);
        });

        if (firstItem.thumbnail) {
          covers.cacheCover(firstSong.id, firstItem.thumbnail).catch(() => {});
        }

        // Start playback immediately if queue was empty
        if (wasEmpty) {
          queue.setCurrentIndex(0);
          playback.setTrack(lobbyId, firstSong, true, io);
        }

        // Emit queue update immediately so first song appears in UI (after potential currentIndex change)
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });

        socket.emit('queue:playlist-progress', {
          current: 1,
          total: items.length,
          title: firstItem.title
        });

        // Add remaining songs sequentially (download one at a time)
        const addRemaining = async () => {
          for (let i = 1; i < items.length; i++) {
            const item = items[i];

            const song = queue.addSong({
              url: item.url,
              title: item.title,
              duration: item.duration,
              addedBy,
              thumbnail: item.thumbnail
            });

            // Sequential download: await each before starting next
            try {
              await downloader.startDownload(item.url, {
                title: item.title,
                duration: item.duration,
                waitForComplete: true
              }, lobbyId);
            } catch (err) {
              console.error(`Background download failed for playlist item: ${err.message}`);
            }

            if (item.thumbnail) {
              covers.cacheCover(song.id, item.thumbnail).catch(() => {});
            }

            socket.emit('queue:playlist-progress', {
              current: i + 1,
              total: items.length,
              title: item.title
            });

            // Emit queue update after each song so UI updates progressively
            io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
          }

          console.log(`Playlist "${playlistData.title}" added to lobby ${lobbyId} (${items.length} songs)`);

          socket.emit('queue:playlist-complete', {
            playlistTitle: playlistData.title,
            added: items.length
          });
        };

        // Run remaining songs in background (non-blocking)
        addRemaining().catch(err => {
          console.error(`Error adding remaining playlist items: ${err.message}`);
        });
      }
    } catch (err) {
      console.error('Playlist add error:', err);
      socket.emit('queue:error', { message: `Failed to add playlist: ${err.message}` });
    }
  });

  // Remove song from queue
  socket.on('queue:remove', async ({ lobbyId, songId }) => {
    if (!verifyLobbyMembership(lobbyId)) {
      return;
    }

    const queue = await getQueueAsync(lobbyId);
    const removed = queue.removeSong(songId);
    if (removed) {
      console.log(`Song removed from lobby ${lobbyId}: ${removed.title}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
    }
  });

  // Reorder song in queue
  socket.on('queue:reorder', async ({ lobbyId, songId, newIndex }) => {
    const queue = await getQueueAsync(lobbyId);
    const success = queue.reorderSong(songId, newIndex);
    if (success) {
      console.log(`Song reordered in lobby ${lobbyId}: moved to position ${newIndex}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
    }
  });

  // Play song at specific index (jam mode: click-to-play)
  socket.on('queue:play-at', async ({ lobbyId, index }) => {
    if (!verifyLobbyMembership(lobbyId)) return;
    const queue = await getQueueAsync(lobbyId);
    const song = queue.getSongAtIndex(index);
    if (!song) return;
    queue.setCurrentIndex(index);
    playback.setTrack(lobbyId, song, true, io);
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Shuffle upcoming songs (jam mode: one-shot visible shuffle)
  socket.on('queue:shuffle', async ({ lobbyId }) => {
    if (!verifyLobbyMembership(lobbyId)) return;
    const queue = await getQueueAsync(lobbyId);
    queue.shuffleUpcoming();
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Clear all songs from queue
  socket.on('queue:clear', async ({ lobbyId }) => {
    if (!verifyLobbyMembership(lobbyId)) return;
    const queue = await getQueueAsync(lobbyId);
    queue.clear();
    playback.trackEnded(lobbyId, io);
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Get current queue state
  socket.on('queue:get', async (lobbyId) => {
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Advance to next song (when current song ends)
  socket.on('queue:next', async (lobbyId) => {
    const queue = await getQueueAsync(lobbyId);
    const shuffleState = playback.getShuffleState(lobbyId);
    const songs = queue.getSongs();

    if (shuffleState.shuffleEnabled && songs.length > 1) {
      // Shuffle mode: get next index from shuffle order
      const currentState = playback.getState(lobbyId);
      const currentTrackId = currentState && currentState.currentTrack ? currentState.currentTrack.id : null;
      const nextIndex = playback.getNextShuffleIndex(lobbyId, songs.length, currentTrackId);
      if (nextIndex !== null && songs[nextIndex]) {
        const nextSong = songs[nextIndex];
        console.log(`Shuffle: playing song at index ${nextIndex} in lobby ${lobbyId}: ${nextSong.title}`);
        playback.setTrack(lobbyId, nextSong, true, io);
      }
    } else {
      // Normal mode: advance queue (removes first song)
      const finished = queue.advanceQueue();
      if (finished) {
        console.log(`Song finished in lobby ${lobbyId}: ${finished.title}`);
      }
      const currentSong = queue.getCurrentSong();
      if (currentSong) {
        playback.setTrack(lobbyId, currentSong, true, io);
      }
    }
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Toggle playback (play/pause)
  socket.on('playback:toggle', async ({ lobbyId }) => {
    if (!verifyLobbyMembership(lobbyId)) {
      return;
    }

    await playback.initLobbyFromDB(lobbyId);
    const state = playback.getState(lobbyId);
    if (!state) return;

    if (state.isPlaying) {
      playback.pause(lobbyId, io);
    } else {
      // If no current track, try to play first song in queue
      if (!state.currentTrack) {
        const queue = await getQueueAsync(lobbyId);
        const song = queue.getCurrentSong();
        if (song) {
          playback.setTrack(lobbyId, song, true, io);
        }
      } else {
        playback.resume(lobbyId, io);
      }
    }
  });

  // Skip to next track
  socket.on('playback:next', async ({ lobbyId }) => {
    const queue = await getQueueAsync(lobbyId);
    const repeatMode = playback.getRepeatMode(lobbyId);
    const isIndependent = lobby.getListeningMode(lobbyId) === 'independent';

    if (isIndependent) {
      // Independent mode: advance per-user position, don't modify shared queue
      let nextSong = queue.advanceUserPosition(socket.id);
      if (!nextSong && repeatMode === 'all' && queue.getSongs().length > 0) {
        queue.setUserPosition(socket.id, 0);
        nextSong = queue.getSongAtIndex(0);
      }
      if (nextSong) {
        playback.setTrack(lobbyId, nextSong, true, io);
      } else {
        playback.setTrack(lobbyId, null, false, io);
      }
      return;
    }

    const shuffleState = playback.getShuffleState(lobbyId);
    const songs = queue.getSongs();

    if (shuffleState.shuffleEnabled && songs.length > 1) {
      // Shuffle mode: pick next from shuffle order, record history
      const currentState = playback.getState(lobbyId);
      const currentTrackId = currentState && currentState.currentTrack ? currentState.currentTrack.id : null;
      const nextIndex = playback.getNextShuffleIndex(lobbyId, songs.length, currentTrackId);
      if (nextIndex !== null && songs[nextIndex]) {
        playback.setTrack(lobbyId, songs[nextIndex], true, io);
      }
      io.to(lobbyId).emit('queue:update', { lobbyId, songs, currentIndex: queue.getCurrentIndex() });
      return;
    }

    if (repeatMode === 'all') {
      // Move current song to end of queue (circular)
      queue.moveCurrentToEnd();
    } else {
      const finished = queue.advanceQueue();
      if (finished) {
        console.log(`Skipped track in lobby ${lobbyId}: ${finished.title}`);
      }
    }

    const nextSong = queue.getCurrentSong();
    if (nextSong) {
      playback.setTrack(lobbyId, nextSong, true, io);
    } else {
      // No more songs, stop playback
      playback.setTrack(lobbyId, null, false, io);
    }

    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Go to previous track
  socket.on('playback:previous', async ({ lobbyId }) => {
    const state = playback.getState(lobbyId);
    if (!state) return;

    // If more than 3 seconds into the track, restart from beginning
    const pos = state.isPlaying && state.startedAt
      ? state.position + (Date.now() - state.startedAt) / 1000
      : state.position;
    if (state.currentTrack && pos > 3) {
      playback.seek(lobbyId, 0, io);
      if (!state.isPlaying) {
        playback.resume(lobbyId, io);
      }
      return;
    }

    // Otherwise go to previous track in queue
    const queue = await getQueueAsync(lobbyId);
    const songs = queue.getSongs();
    if (songs.length === 0) return;

    const shuffleState = playback.getShuffleState(lobbyId);

    // In shuffle mode, use history to go back to the actual previous song
    if (shuffleState.shuffleEnabled) {
      const prevTrackId = playback.getPreviousShuffleTrackId(lobbyId);
      if (prevTrackId) {
        const prevSong = songs.find(s => s.id === prevTrackId);
        if (prevSong) {
          playback.setTrack(lobbyId, prevSong, true, io);
          io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
          return;
        }
      }
      // No history or song not found — restart current track
      playback.seek(lobbyId, 0, io);
      if (!state.isPlaying) {
        playback.resume(lobbyId, io);
      }
      return;
    }

    const currentIndex = state.currentTrack
      ? songs.findIndex(s => s.id === state.currentTrack.id)
      : -1;

    let prevIndex = currentIndex - 1;
    const repeatMode = playback.getRepeatMode(lobbyId);
    if (prevIndex < 0) {
      if (repeatMode === 'all') {
        prevIndex = songs.length - 1;
      } else {
        // At beginning, just restart
        playback.seek(lobbyId, 0, io);
        if (!state.isPlaying) {
          playback.resume(lobbyId, io);
        }
        return;
      }
    }

    playback.setTrack(lobbyId, songs[prevIndex], true, io);
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });
  });

  // Handle track ended - coordinates playback and queue with repeat modes
  socket.on('playback:ended', async ({ lobbyId }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const repeatMode = playback.getRepeatMode(lobbyId);
    const queue = await getQueueAsync(lobbyId);
    const isIndependent = lobby.getListeningMode(lobbyId) === 'independent';

    // For repeat-one mode, playback.js handles restarting the track
    if (repeatMode === 'one') {
      playback.trackEnded(lobbyId, io);
      return;
    }

    if (isIndependent) {
      // Independent mode: advance per-user position, don't modify shared queue
      let nextSong = queue.advanceUserPosition(socket.id);
      if (!nextSong && repeatMode === 'all' && queue.getSongs().length > 0) {
        queue.setUserPosition(socket.id, 0);
        nextSong = queue.getSongAtIndex(0);
      }
      if (nextSong) {
        playback.setTrack(lobbyId, nextSong, true, io);
      } else {
        playback.trackEnded(lobbyId, io);
      }
      return;
    }

    // Get current track before advancing
    const currentSong = queue.getCurrentSong();
    if (!currentSong) {
      playback.trackEnded(lobbyId, io);
      return;
    }

    const shuffleState = playback.getShuffleState(lobbyId);
    const songs = queue.getSongs();

    if (shuffleState.shuffleEnabled && songs.length > 1) {
      // Shuffle mode: pick next from shuffle order, record history
      const currentState = playback.getState(lobbyId);
      const currentTrackId = currentState && currentState.currentTrack ? currentState.currentTrack.id : null;
      const nextIndex = playback.getNextShuffleIndex(lobbyId, songs.length, currentTrackId);
      if (nextIndex !== null && songs[nextIndex]) {
        playback.setTrack(lobbyId, songs[nextIndex], true, io);
        console.log(`Shuffle: playing song at index ${nextIndex} in lobby ${lobbyId}: ${songs[nextIndex].title}`);
      } else {
        playback.trackEnded(lobbyId, io);
      }
      io.to(lobbyId).emit('queue:update', { lobbyId, songs, currentIndex: queue.getCurrentIndex() });
      return;
    }

    if (repeatMode === 'all') {
      // Move current song to end of queue (circular)
      queue.moveCurrentToEnd();
    } else {
      // Normal mode: remove current song
      queue.advanceQueue();
    }

    // Get next song to play
    const nextSong = queue.getCurrentSong();

    // Update queue state for all clients
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs(), currentIndex: queue.getCurrentIndex() });

    if (nextSong) {
      // Play next track
      playback.setTrack(lobbyId, nextSong, true, io);
      console.log(`Playing next song in lobby ${lobbyId}: ${nextSong.title} (repeat: ${repeatMode})`);
    } else {
      // Queue empty - stop playback
      playback.trackEnded(lobbyId, io);
      console.log(`Queue empty in lobby ${lobbyId}`);
    }
  });


  // Chat: send message
  socket.on('chat:send', async ({ lobbyId, userId, username, emoji, content, songMention }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId || !content || !content.trim()) return;

    if (!verifyLobbyMembership(lobbyId)) {
      socket.emit('chat:error', { message: 'Not a member of this lobby' });
      return;
    }

    if (chat.isThrottled(socket.id)) {
      socket.emit('chat:error', { message: 'Sending too fast, please slow down' });
      return;
    }

    const msg = await chat.addMessage(
      lobbyId,
      userId || 'anonymous',
      username || 'Anonymous',
      emoji || '',
      content.trim(),
      songMention || null
    );

    // Broadcast to all in lobby (including sender)
    io.to(lobbyId).emit('chat:message', msg);
  });

  // Chat: get history
  socket.on('chat:history', async ({ lobbyId }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const messages = await chat.getHistory(lobbyId);
    socket.emit('chat:history', { lobbyId, messages });
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
    chat.cleanupSocket(socket.id);
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });
});

async function handleLeave(socket, lobbyId) {
  const queue = await getQueueAsync(lobbyId);
  queue.removeUserPosition(socket.id);

  // Clear follow relationships: unfollow anyone this user was following,
  // and notify anyone following this user that they've been unfollowed
  lobby.clearFollowersOf(lobbyId, socket.id);

  const user = lobby.leaveLobby(lobbyId, socket.id);
  if (user) {
    socket.leave(lobbyId);
    const remainingUsers = lobby.getLobbyUsers(lobbyId);
    socket.to(lobbyId).emit('user-left', {
      user,
      users: remainingUsers
    });
    console.log(`User ${user.username} left lobby ${lobbyId}`);

    // Stop sync timer when lobby becomes empty to prevent leaked intervals
    if (remainingUsers.length === 0) {
      playback.stopSyncTimer(lobbyId);
    }
  }
}

// Initialize database and start server
async function start() {
  // Initialize database if DATABASE_URL is set
  const dbAvailable = await db.init();

  // Initialize session middleware (with or without DB store)
  const pgPool = dbAvailable ? db.getPool() : null;
  initSession(pgPool);

  if (dbAvailable) {
    console.log('Database persistence enabled');

    // Restore lobbies from database into memory so lobby list works after restart
    await lobby.loadLobbiesFromDB();

    // Run initial cache cleanup
    downloader.cleanupOldSongs().catch(err => {
      console.error('Initial cache cleanup failed:', err.message);
    });

    // Schedule periodic cache cleanup (every 6 hours)
    setInterval(() => {
      downloader.cleanupOldSongs().catch(err => {
        console.error('Periodic cache cleanup failed:', err.message);
      });
    }, 6 * 60 * 60 * 1000);
  } else {
    console.log('Running in memory-only mode');
  }

  // Share session with Socket.IO for authenticated socket connections
  if (sessionMiddleware) {
    io.engine.use(sessionMiddleware);
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    if (dbAvailable) {
      console.log(`Song cache: ${downloader.SONGS_PATH}`);
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

  server.close(() => {
    console.log('HTTP server closed');

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
