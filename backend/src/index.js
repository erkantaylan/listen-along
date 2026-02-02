require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const ytdlp = require('./ytdlp');
const playback = require('./playback');
const lobby = require('./lobby');
const { getQueue, deleteQueue } = require('./queue');

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

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
    ytdlp: ytdlpAvailable ? 'available' : 'unavailable'
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

// Stream audio
app.get('/api/stream', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  try {
    // Get metadata first to validate the video exists
    await ytdlp.getMetadata(q);

    // Set response headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

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

// Serve lobby page
app.get('/lobby/:id', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Serve index for root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Set up playback sync handlers
playback.setupSocketHandlers(io);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  let currentLobby = null;

  // Create a new lobby
  socket.on('lobby:create', ({ username }) => {
    const newLobby = lobby.createLobby();
    const result = lobby.joinLobby(newLobby.id, socket.id, username || 'Anonymous');

    currentLobby = newLobby.id;
    socket.join(newLobby.id);

    socket.emit('lobby:created', {
      lobbyId: newLobby.id,
      user: result.user,
      users: lobby.getLobbyUsers(newLobby.id)
    });

    console.log(`Lobby ${newLobby.id} created by ${username}`);
  });

  socket.on('join-lobby', ({ lobbyId, username }) => {
    const result = lobby.joinLobby(lobbyId, socket.id, username);
    if (!result) {
      socket.emit('error', { message: 'Lobby not found' });
      return;
    }

    currentLobby = lobbyId;
    socket.join(lobbyId);

    // Notify the joining user
    socket.emit('joined-lobby', {
      lobbyId,
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
    const queue = getQueue(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });

    console.log(`User ${result.user.username} joined lobby ${lobbyId}`);
  });

  socket.on('leave-lobby', () => {
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });

  // Handle joining a lobby room (integrates with lobby system)
  socket.on('lobby:join', ({ lobbyId, username }) => {
    // Check if lobby exists, create if not (for direct URL access)
    let lobbyData = lobby.getLobby(lobbyId);
    if (!lobbyData) {
      lobbyData = lobby.createLobby(lobbyId);
    }

    if (currentLobby) {
      socket.leave(currentLobby);
      lobby.leaveLobby(currentLobby, socket.id);
    }

    const result = lobby.joinLobby(lobbyId, socket.id, username || 'Anonymous');
    currentLobby = lobbyId;
    socket.join(lobbyId);

    // Send joined confirmation to the user
    socket.emit('lobby:joined', {
      lobbyId,
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    // Notify others in lobby
    socket.to(lobbyId).emit('lobby:user-joined', {
      user: result.user,
      users: lobby.getLobbyUsers(lobbyId)
    });

    console.log(`User ${username} joined lobby ${lobbyId}`);

    // Send current playback state to new user joining mid-song
    const playbackState = playback.getJoinState(lobbyId);
    if (playbackState) {
      socket.emit('playback:sync', playbackState);
    }

    // Send current queue state to new joiner
    const queue = getQueue(lobbyId);
    socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  socket.on('lobby:leave', ({ lobbyId }) => {
    socket.leave(lobbyId);
    console.log(`Client ${socket.id} left lobby ${lobbyId}`);
    currentLobby = null;
  });

  // Add song to queue
  socket.on('queue:add', async ({ lobbyId, query, url, title, duration, addedBy }) => {
    const queue = getQueue(lobbyId);

    // If query is provided, fetch metadata first
    if (query && !title) {
      try {
        socket.emit('queue:adding', { status: 'fetching metadata...' });
        const metadata = await ytdlp.getMetadata(query);
        if (metadata) {
          url = metadata.url || query;
          title = metadata.title || 'Unknown';
          duration = metadata.duration;
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

    const song = queue.addSong({ url: url || query, title: title || 'Unknown', duration, addedBy });
    console.log(`Song added to lobby ${lobbyId}: ${song.title}`);

    // Broadcast updated queue to all in lobby
    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });

    // If this is the first song and nothing is playing, start playback
    if (queue.getSongs().length === 1) {
      playback.setTrack(lobbyId, song, true, io);
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
    const finished = queue.advanceQueue();
    if (finished) {
      console.log(`Song finished in lobby ${lobbyId}: ${finished.title}`);
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
    const finished = queue.advanceQueue();
    if (finished) {
      console.log(`Skipped track in lobby ${lobbyId}: ${finished.title}`);
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

  // Handle track ended - auto-advance to next song
  socket.on('playback:ended', ({ lobbyId }) => {
    if (!lobbyId) return;

    const queue = getQueue(lobbyId);
    const finished = queue.advanceQueue();
    if (finished) {
      console.log(`Track ended in lobby ${lobbyId}: ${finished.title}`);
    }

    const nextSong = queue.getCurrentSong();
    if (nextSong) {
      playback.setTrack(lobbyId, nextSong, true, io);
      console.log(`Auto-advancing to next track: ${nextSong.title}`);
    } else {
      // No more songs, stop playback
      playback.setTrack(lobbyId, null, false, io);
      console.log(`Queue empty in lobby ${lobbyId}`);
    }

    io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
    if (currentLobby) {
      handleLeave(socket, currentLobby);
    }
  });
});

function handleLeave(socket, lobbyId) {
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

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
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
