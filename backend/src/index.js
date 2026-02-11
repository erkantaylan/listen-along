require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const ytdlp = require('./ytdlp');
const playback = require('./playback');
const lobby = require('./lobby');
const { getQueue, getQueueAsync, deleteQueue } = require('./queue');
const db = require('./db');
const downloader = require('./downloader');
const covers = require('./covers');
const playlist = require('./playlist');
const pkg = require('../package.json');

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

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

const app = express();
const server = http.createServer(app);

// CORS configuration
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ['GET', 'POST'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Serve static frontend files
// In Docker: /app/src/index.js -> /app/frontend (../frontend)
// Local dev: backend/src/index.js -> frontend (../../frontend)
const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions
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

// Get video metadata
app.get('/api/metadata', async (req, res) => {
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
app.get('/api/stream', async (req, res) => {
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
app.get('/api/lobbies', (req, res) => {
  const allLobbies = lobby.getAllLobbies();

  const lobbies = allLobbies.map(l => {
    const queue = getQueue(l.id);
    return {
      id: l.id,
      name: l.name || null,
      listeningMode: l.listeningMode,
      userCount: l.userCount,
      songCount: queue.getSongs().length,
      createdAt: l.createdAt
    };
  });

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
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    return res.sendFile(cached.path);
  }

  // Not cached - redirect to fallback URL if provided
  if (fallbackUrl) {
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
  const [user, pass] = credentials.split(':');

  if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
    res.status(401).send('Invalid credentials');
  }
};

// Dashboard stats endpoint
app.get('/api/dashboard/stats', dashboardAuth, (req, res) => {
  const stats = {
    totalLobbies: lobby.lobbies.size,
    totalUsers: 0,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    lobbies: []
  };

  for (const [lobbyId, lobbyData] of lobby.lobbies) {
    const userCount = lobbyData.users.size;
    stats.totalUsers += userCount;

    const queue = getQueue(lobbyId);
    const playbackState = playback.getState(lobbyId);

    stats.lobbies.push({
      id: lobbyId,
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

  // Clean up playback and queue state
  playback.cleanupLobby(lobbyId);
  deleteQueue(lobbyId);

  // Delete the lobby
  lobby.deleteLobby(lobbyId);

  console.log(`Lobby ${lobbyId} deleted via dashboard`);
  res.json({ success: true });
});

// Serve lobby page
app.get('/lobby/:id', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Serve dashboard page
app.get('/dashboard', dashboardAuth, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
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

  // Create a new lobby
  socket.on('lobby:create', async ({ username, emoji, listeningMode, name }) => {
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

    const lobbyName = (name && name.trim()) ? name.trim() : null;
    const newLobby = await lobby.createLobbyAsync(null, null, listeningMode, lobbyName);
    const result = await lobby.joinLobbyAsync(newLobby.id, socket.id, username || 'Anonymous', emoji);

    currentLobby = newLobby.id;
    socket.join(newLobby.id);

    socket.emit('lobby:created', {
      lobbyId: newLobby.id,
      name: newLobby.name,
      listeningMode: newLobby.listeningMode,
      user: result.user,
      users: lobby.getLobbyUsers(newLobby.id)
    });

    console.log(`Lobby ${newLobby.id} created by ${username} (${newLobby.listeningMode})${newLobby.name ? ` name="${newLobby.name}"` : ''}`);
  });

  socket.on('join-lobby', async ({ lobbyId, username, emoji }) => {
    const result = await lobby.joinLobbyAsync(lobbyId, socket.id, username, emoji);
    if (!result) {
      socket.emit('error', { message: 'Lobby not found' });
      return;
    }

    currentLobby = lobbyId;
    socket.join(lobbyId);

    // Notify the joining user
    const joinLobbyData = await lobby.getLobbyAsync(lobbyId);
    socket.emit('joined-lobby', {
      lobbyId,
      name: joinLobbyData ? joinLobbyData.name : null,
      listeningMode: lobby.getListeningMode(lobbyId),
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Broadcast to others in the lobby
    socket.to(lobbyId).emit('user-joined', {
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Send current playback state to new user joining mid-song
    const state = playback.getJoinState(lobbyId);
    if (state) {
      socket.emit('playback:sync', state);
    }

    // Send current queue state to new joiner
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });

    // Send current shuffle state to new joiner
    const shuffleState = playback.getShuffleState(lobbyId);
    socket.emit('playback:shuffle', { lobbyId, shuffleEnabled: shuffleState.shuffleEnabled });

    console.log(`User ${result.user.username} joined lobby ${lobbyId}`);
  });

  socket.on('leave-lobby', () => {
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });

  // Handle joining a lobby room (integrates with lobby system)
  socket.on('lobby:join', async ({ lobbyId, username, emoji }) => {
    // Check if lobby exists, create if not (for direct URL access)
    let lobbyData = await lobby.getLobbyAsync(lobbyId);
    if (!lobbyData) {
      lobbyData = await lobby.createLobbyAsync(null, lobbyId);
    }

    if (currentLobby) {
      socket.leave(currentLobby);
      lobby.leaveLobby(currentLobby, socket.id);
    }

    const result = await lobby.joinLobbyAsync(lobbyId, socket.id, username || 'Anonymous', emoji);
    if (!result) {
      socket.emit('lobby:error', { message: 'Failed to join lobby' });
      return;
    }
    currentLobby = lobbyId;
    socket.join(lobbyId);

    // Send joined confirmation to the user
    const listeningMode = lobby.getListeningMode(lobbyId);
    const joinedLobbyData = await lobby.getLobbyAsync(lobbyId);
    socket.emit('lobby:joined', {
      lobbyId,
      name: joinedLobbyData ? joinedLobbyData.name : null,
      listeningMode,
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Notify others in lobby
    socket.to(lobbyId).emit('lobby:user-joined', {
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    console.log(`User ${username} joined lobby ${lobbyId} (${listeningMode})`);

    // Send current playback state to new user joining mid-song
    // Only send sync state for synchronized lobbies
    const playbackState = playback.getJoinState(lobbyId);
    if (playbackState && listeningMode === 'synchronized') {
      socket.emit('playback:sync', playbackState);
    }

    // Send current queue state to new joiner
    const queue = await getQueueAsync(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  socket.on('lobby:leave', ({ lobbyId }) => {
    socket.leave(lobbyId);
    console.log(`Client ${socket.id} left lobby ${lobbyId}`);
    currentLobby = null;
  });

  // Set user mode (listening or lobby)
  socket.on('mode:set', ({ lobbyId, mode }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const user = lobby.setUserMode(lobbyId, socket.id, mode);
    if (user) {
      console.log(`User ${user.username} switched to ${mode} mode in lobby ${lobbyId}`);

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
    const queue = await getQueueAsync(lobbyId);
    const inputUrl = url || query;

    // Check if this is a playlist URL
    if (inputUrl && ytdlp.isPlaylistUrl(inputUrl)) {
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

        // Send playlist info to client for confirmation dialog
        socket.emit('queue:playlist-confirm', {
          lobbyId,
          url: inputUrl,
          playlistTitle: playlist.title,
          songCount: items.length,
          totalCount: playlist.total,
          limited: playlist.limited,
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

    // Broadcast updated queue to all in lobby
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });

    // If this is the first song and nothing is playing, start playback
    if (queue.getSongs().length === 1) {
      playback.setTrack(lobbyId, song, true, io);
    }
  });

  // Handle playlist add after user confirms via dialog
  socket.on('queue:playlist-add', async ({ lobbyId, url, mode, addedBy }) => {
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
      const items = playlistData.items;

      if (items.length === 0) {
        socket.emit('queue:error', { message: 'Playlist is empty' });
        return;
      }

      if (mode === 'single') {
        // Add only the first song
        const item = items[0];
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

        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });

        if (wasEmpty) {
          playback.setTrack(lobbyId, song, true, io);
        }
      } else {
        // Add all songs - first song immediately, rest progressively
        console.log(`Adding playlist "${playlistData.title}" (${items.length} items) to lobby ${lobbyId}`);

        if (playlistData.limited) {
          socket.emit('queue:playlist-info', {
            message: `Playlist has ${playlistData.total} videos, adding first ${items.length}`,
            total: playlistData.total,
            adding: items.length
          });
        }

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

        downloader.startDownload(firstItem.url, {
          title: firstItem.title,
          duration: firstItem.duration
        }, lobbyId).catch(err => {
          console.error(`Background download failed for playlist item: ${err.message}`);
        });

        if (firstItem.thumbnail) {
          covers.cacheCover(firstSong.id, firstItem.thumbnail).catch(() => {});
        }

        // Emit queue update immediately so first song appears in UI
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });

        socket.emit('queue:playlist-progress', {
          current: 1,
          total: items.length,
          title: firstItem.title
        });

        // Start playback immediately if queue was empty
        if (wasEmpty) {
          playback.setTrack(lobbyId, firstSong, true, io);
        }

        // Add remaining songs progressively in the background
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

            downloader.startDownload(item.url, {
              title: item.title,
              duration: item.duration
            }, lobbyId).catch(err => {
              console.error(`Background download failed for playlist item: ${err.message}`);
            });

            if (item.thumbnail) {
              covers.cacheCover(song.id, item.thumbnail).catch(() => {});
            }

            socket.emit('queue:playlist-progress', {
              current: i + 1,
              total: items.length,
              title: item.title
            });

            // Emit queue update after each song so UI updates progressively
            io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
          }

          console.log(`Playlist "${playlistData.title}" added to lobby ${lobbyId}`);

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
  socket.on('queue:remove', ({ lobbyId, songId }) => {
    const queue = getQueue(lobbyId);
    const removed = queue.removeSong(songId);
    if (removed) {
      console.log(`Song removed from lobby ${lobbyId}: ${removed.title}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    }
  });

  // Reorder song in queue
  socket.on('queue:reorder', ({ lobbyId, songId, newIndex }) => {
    const queue = getQueue(lobbyId);
    const success = queue.reorderSong(songId, newIndex);
    if (success) {
      console.log(`Song reordered in lobby ${lobbyId}: moved to position ${newIndex}`);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    }
  });

  // Get current queue state
  socket.on('queue:get', (lobbyId) => {
    const queue = getQueue(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  // Advance to next song (when current song ends)
  socket.on('queue:next', (lobbyId) => {
    const queue = getQueue(lobbyId);
    const shuffleState = playback.getShuffleState(lobbyId);
    const songs = queue.getSongs();

    if (shuffleState.shuffleEnabled && songs.length > 1) {
      // Shuffle mode: get next index from shuffle order
      const nextIndex = playback.getNextShuffleIndex(lobbyId, songs.length);
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
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  // Toggle playback (play/pause)
  socket.on('playback:toggle', ({ lobbyId }) => {
    const state = playback.getState(lobbyId);
    if (!state) return;

    if (state.isPlaying) {
      playback.pause(lobbyId, io);
    } else {
      // If no current track, try to play first song in queue
      if (!state.currentTrack) {
        const queue = getQueue(lobbyId);
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
  socket.on('playback:next', ({ lobbyId }) => {
    const queue = getQueue(lobbyId);
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

    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  // Go to previous track (restart current song)
  socket.on('playback:previous', ({ lobbyId }) => {
    const state = playback.getState(lobbyId);
    if (!state || !state.currentTrack) return;

    // Restart current song from beginning
    playback.seek(lobbyId, 0, io);
    if (!state.isPlaying) {
      playback.resume(lobbyId, io);
    }
  });

  // Handle track ended - coordinates playback and queue with repeat modes
  socket.on('playback:ended', ({ lobbyId }) => {
    if (!lobbyId) lobbyId = currentLobby;
    if (!lobbyId) return;

    const repeatMode = playback.getRepeatMode(lobbyId);
    const queue = getQueue(lobbyId);
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
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });

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


  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });
});

function handleLeave(socket, lobbyId) {
  const queue = getQueue(lobbyId);
  queue.removeUserPosition(socket.id);

  const user = lobby.leaveLobby(lobbyId, socket.id);
  if (user) {
    socket.leave(lobbyId);
    socket.to(lobbyId).emit('user-left', {
      user,
      users: lobby.getLobbyUsers(lobbyId)
    });
    console.log(`User ${user.username} left lobby ${lobbyId}`);
  }
}

// Initialize database and start server
async function start() {
  // Initialize database if DATABASE_URL is set
  const dbAvailable = await db.init();
  if (dbAvailable) {
    console.log('Database persistence enabled');

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

    io.close(() => {
      console.log('Socket.IO server closed');
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
