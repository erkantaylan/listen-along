const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory storage (fallback if no database)
const lobbies = new Map();
// User connections are always in-memory (transient socket state)
const lobbyUsers = new Map();

// Periodic sweep only reclaims orphaned queue/playback state — it never deletes
// lobbies. Time-based lobby expiry was removed in hq-9gvy.
const LOBBY_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

function generateLobbyId() {
  return uuidv4().substring(0, 8);
}

async function createLobby(hostId = null, customId = null, listeningMode = 'synchronized', name = null, isPublic = true) {
  const id = customId || generateLobbyId();
  const now = Date.now();
  const mode = (listeningMode === 'independent') ? 'independent' : 'synchronized';
  const pub = isPublic !== false;

  const lobby = {
    id,
    hostId: hostId || null,
    name: name || null,
    listeningMode: mode,
    isPublic: pub,
    pinned: false,
    createdAt: now,
    lastActivity: now
  };

  if (db.isAvailable()) {
    try {
      await db.query(
        'INSERT INTO lobbies (id, host_id, name, listening_mode, is_public, created_at, last_activity, pinned) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO UPDATE SET last_activity = $7',
        [id, hostId || null, name || null, mode, pub, now, now, false]
      );
    } catch (err) {
      console.error('Failed to persist lobby:', err.message);
    }
  }

  lobbies.set(id, lobby);
  lobbyUsers.set(id, new Map());

  return { ...lobby, users: new Map() };
}

async function getLobby(id) {
  // Try memory first
  let lobby = lobbies.get(id);

  // If not in memory but DB available, try to load from DB
  if (!lobby && db.isAvailable()) {
    try {
      const result = await db.query(
        'SELECT id, host_id, name, listening_mode, is_public, created_at, last_activity, pinned FROM lobbies WHERE id = $1',
        [id]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        lobby = {
          id: row.id,
          hostId: row.host_id,
          name: row.name || null,
          listeningMode: row.listening_mode || 'synchronized',
          isPublic: row.is_public !== false,
          pinned: row.pinned || false,
          createdAt: parseInt(row.created_at),
          lastActivity: parseInt(row.last_activity)
        };
        lobbies.set(id, lobby);
        if (!lobbyUsers.has(id)) {
          lobbyUsers.set(id, new Map());
        }
      }
    } catch (err) {
      console.error('Failed to load lobby from DB:', err.message);
    }
  }

  if (!lobby) return undefined;

  // Attach users Map for compatibility
  return {
    ...lobby,
    users: lobbyUsers.get(id) || new Map()
  };
}

async function updateLastActivity(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  lobby.lastActivity = Date.now();

  if (db.isAvailable()) {
    try {
      await db.query(
        'UPDATE lobbies SET last_activity = $1 WHERE id = $2',
        [lobby.lastActivity, lobbyId]
      );
    } catch (err) {
      console.error('Failed to update lobby activity:', err.message);
    }
  }
}

async function joinLobby(lobbyId, socketId, username, emoji) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return null;

  const user = {
    socketId,
    username: username || `User-${socketId.substring(0, 4)}`,
    emoji: emoji || null,
    joinedAt: Date.now(),
    mode: 'listening', // 'listening' or 'lobby'
    currentTrack: null,  // { title, thumbnail } - what user is currently listening to
    followingSocketId: null  // socketId of user being followed (independent mode)
  };

  let users = lobbyUsers.get(lobbyId);
  if (!users) {
    users = new Map();
    lobbyUsers.set(lobbyId, users);
  }
  users.set(socketId, user);

  await updateLastActivity(lobbyId);

  return { lobby: { ...lobby, users }, user };
}

async function leaveLobby(lobbyId, socketId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const users = lobbyUsers.get(lobbyId);
  if (!users) return undefined;

  const user = users.get(socketId);
  if (user) {
    users.delete(socketId);
    await updateLastActivity(lobbyId);
  }
  return user;
}

function getLobbyUsers(lobbyId) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return [];
  return Array.from(users.values());
}

function setUserMode(lobbyId, socketId, mode) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  // Validate mode
  if (mode !== 'listening' && mode !== 'lobby') {
    return null;
  }

  user.mode = mode;
  return user;
}

function updateUser(lobbyId, socketId, updates) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  if (updates.username !== undefined) {
    const trimmed = String(updates.username).trim();
    if (trimmed && trimmed.length <= 30) {
      user.username = trimmed;
    }
  }
  if (updates.emoji !== undefined) {
    user.emoji = updates.emoji || null;
  }
  return user;
}

function getUserMode(lobbyId, socketId) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  return user ? user.mode : null;
}

function setUserCurrentTrack(lobbyId, socketId, track) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  user.currentTrack = track ? { title: track.title, thumbnail: track.thumbnail } : null;
  return user;
}

function setAllUsersCurrentTrack(lobbyId, track) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return;

  const trackInfo = track ? { title: track.title, thumbnail: track.thumbnail } : null;
  for (const user of users.values()) {
    if (user.mode === 'listening') {
      user.currentTrack = trackInfo;
    }
  }
}

function setUserFollowing(lobbyId, socketId, targetSocketId) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  // Can't follow yourself
  if (targetSocketId === socketId) return null;

  // Validate target exists in same lobby (null means unfollow)
  if (targetSocketId !== null) {
    const target = users.get(targetSocketId);
    if (!target) return null;
  }

  user.followingSocketId = targetSocketId;
  return user;
}

function getFollowers(lobbyId, leaderSocketId) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return [];

  const followers = [];
  for (const user of users.values()) {
    if (user.followingSocketId === leaderSocketId) {
      followers.push(user);
    }
  }
  return followers;
}

function clearFollowersOf(lobbyId, socketId) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return;

  for (const user of users.values()) {
    if (user.followingSocketId === socketId) {
      user.followingSocketId = null;
    }
  }
}

function isNameTaken(name, excludeLobbyId = null) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  for (const [id, l] of lobbies) {
    if (excludeLobbyId && id === excludeLobbyId) continue;
    if (l.name && l.name.toLowerCase().trim() === lower) return true;
  }
  return false;
}

async function renameLobby(lobbyId, newName) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const trimmed = newName ? newName.trim() : '';
  if (!trimmed) return { error: 'Name cannot be empty' };
  if (trimmed.length > 50) return { error: 'Name must be 50 characters or less' };
  if (isNameTaken(trimmed, lobbyId)) return { error: 'A lobby with that name already exists' };

  lobby.name = trimmed;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE lobbies SET name = $1 WHERE id = $2', [trimmed, lobbyId]);
    } catch (err) {
      console.error('Failed to update lobby name in DB:', err.message);
    }
  }

  return { lobby };
}

async function pinLobby(lobbyId, pinned) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  lobby.pinned = pinned;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE lobbies SET pinned = $1 WHERE id = $2', [pinned, lobbyId]);
    } catch (err) {
      console.error('Failed to update lobby pinned state:', err.message);
    }
  }

  return { lobby };
}

// Set a lobby's public/private visibility. Ownership is enforced by the caller
// (HTTP layer); this only persists the new value to memory + DB.
async function setVisibility(lobbyId, isPublic) {
  const pub = isPublic !== false;
  const lobby = lobbies.get(lobbyId);
  if (lobby) lobby.isPublic = pub;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE lobbies SET is_public = $1 WHERE id = $2', [pub, lobbyId]);
    } catch (err) {
      console.error('Failed to update lobby visibility:', err.message);
    }
  }

  return { lobby: lobby || null, isPublic: pub };
}

async function deleteLobby(id) {
  if (db.isAvailable()) {
    try {
      await db.query('DELETE FROM lobbies WHERE id = $1', [id]);
    } catch (err) {
      console.error('Failed to delete lobby from DB:', err.message);
    }
  }

  lobbyUsers.delete(id);
  return lobbies.delete(id);
}

// Time-based lobby deletion was removed in hq-9gvy: idle lobbies are NEVER
// deleted, in memory or in the DB. They persist until a creator (or admin)
// explicitly deletes them. This sweep now only reclaims orphaned queue/playback
// state for lobby IDs that no longer exist in memory (e.g. lazily created by
// getQueue() for an already-deleted lobby) — it never removes a lobby itself.
async function cleanupEmptyLobbies() {
  // Lazy require to avoid circular dependency (playback.js requires lobby.js)
  const { cleanupOrphanedQueues } = require('./queue');
  const playback = require('./playback');

  const validLobbyIds = new Set(lobbies.keys());
  cleanupOrphanedQueues(validLobbyIds);
  playback.cleanupOrphanedPlayback(validLobbyIds);
}

// Cleanup interval handle (only start in production)
let cleanupInterval = null;

function startCleanup() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupEmptyLobbies, LOBBY_CLEANUP_INTERVAL);
  }
}

function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Auto-start in production (not during tests)
if (process.env.NODE_ENV !== 'test') {
  startCleanup();
}

// Sync wrapper for backward compatibility with tests
function createLobbySync(hostId = null, customId = null, listeningMode = 'synchronized', name = null, isPublic = true) {
  const id = customId || generateLobbyId();
  const now = Date.now();
  const mode = (listeningMode === 'independent') ? 'independent' : 'synchronized';

  const users = new Map();
  const lobby = {
    id,
    hostId: hostId || null,
    name: name || null,
    listeningMode: mode,
    isPublic: isPublic !== false,
    pinned: false,
    createdAt: now,
    lastActivity: now,
    users
  };

  lobbies.set(id, lobby);
  lobbyUsers.set(id, users);

  return lobby;
}

function getLobbySync(id) {
  const lobby = lobbies.get(id);
  if (!lobby) return undefined;

  // Ensure users Map is attached
  if (!lobby.users) {
    lobby.users = lobbyUsers.get(id) || new Map();
  }

  return lobby;
}

function joinLobbySync(lobbyId, socketId, username, emoji) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const user = {
    socketId,
    username: username || `User-${socketId.substring(0, 4)}`,
    emoji: emoji || null,
    joinedAt: Date.now(),
    mode: 'listening', // 'listening' or 'lobby'
    currentTrack: null,  // { title, thumbnail } - what user is currently listening to
    followingSocketId: null  // socketId of user being followed (independent mode)
  };

  let users = lobbyUsers.get(lobbyId);
  if (!users) {
    users = new Map();
    lobbyUsers.set(lobbyId, users);
  }
  users.set(socketId, user);
  lobby.lastActivity = Date.now();

  return { lobby: { ...lobby, users }, user };
}

function leaveLobbySync(lobbyId, socketId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const users = lobbyUsers.get(lobbyId);
  if (!users) return undefined;

  const user = users.get(socketId);
  if (user) {
    users.delete(socketId);
    updateLastActivity(lobbyId).catch(err =>
      console.error('Failed to persist last_activity on leave:', err.message)
    );
  }
  return user;
}

async function loadLobbiesFromDB() {
  if (!db.isAvailable()) return;

  try {
    const result = await db.query(
      'SELECT id, host_id, name, listening_mode, is_public, created_at, last_activity, pinned FROM lobbies ORDER BY last_activity DESC'
    );

    for (const row of result.rows) {
      if (!lobbies.has(row.id)) {
        lobbies.set(row.id, {
          id: row.id,
          hostId: row.host_id,
          name: row.name || null,
          listeningMode: row.listening_mode || 'synchronized',
          isPublic: row.is_public !== false,
          pinned: row.pinned || false,
          createdAt: parseInt(row.created_at),
          lastActivity: parseInt(row.last_activity)
        });
        if (!lobbyUsers.has(row.id)) {
          lobbyUsers.set(row.id, new Map());
        }
      }
    }

    console.log(`Loaded ${result.rows.length} lobbies from database`);
  } catch (err) {
    console.error('Failed to load lobbies from DB:', err.message);
  }
}

function getAllLobbies() {
  const result = [];
  for (const [id, lobbyData] of lobbies) {
    const users = lobbyUsers.get(id);
    const userCount = users ? users.size : 0;
    result.push({
      id,
      name: lobbyData.name || null,
      listeningMode: lobbyData.listeningMode || 'synchronized',
      hostId: lobbyData.hostId || null,
      isPublic: lobbyData.isPublic !== false,
      pinned: lobbyData.pinned || false,
      userCount,
      createdAt: lobbyData.createdAt,
      lastActivity: lobbyData.lastActivity
    });
  }
  return result;
}

function getListeningMode(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  return lobby ? lobby.listeningMode || 'synchronized' : 'synchronized';
}

function deleteLobbySync(id) {
  lobbyUsers.delete(id);
  return lobbies.delete(id);
}

module.exports = {
  createLobby: createLobbySync,
  getLobby: getLobbySync,
  joinLobby: joinLobbySync,
  leaveLobby: leaveLobbySync,
  getLobbyUsers,
  getAllLobbies,
  getListeningMode,
  setUserMode,
  getUserMode,
  updateUser,
  setUserCurrentTrack,
  setAllUsersCurrentTrack,
  setUserFollowing,
  getFollowers,
  clearFollowersOf,
  isNameTaken,
  renameLobby,
  setVisibility,
  deleteLobby: deleteLobbySync,
  pinLobby,
  lobbies,
  cleanupEmptyLobbies,
  // Async versions for production use with database
  createLobbyAsync: createLobby,
  getLobbyAsync: getLobby,
  joinLobbyAsync: joinLobby,
  leaveLobbyAsync: leaveLobby,
  deleteLobbyAsync: deleteLobby,
  loadLobbiesFromDB
};
