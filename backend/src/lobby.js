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

// A lobby is shown to users as a "playlist". visibility is 'public' (seen and
// edited by every logged-in user) or 'private' (owner only); see
// playlistAccess.js for the rules. ownerId is the users.id of the creator
// (DB column host_id), null for legacy / anonymous playlists.
const VISIBILITIES = ['public', 'private'];
function normalizeVisibility(v) {
  return v === 'private' ? 'private' : 'public';
}

function rowToLobby(row) {
  return {
    id: row.id,
    ownerId: row.host_id || null,
    ownerName: null,
    name: row.name || null,
    visibility: normalizeVisibility(row.visibility),
    pinned: row.pinned || false,
    createdAt: parseInt(row.created_at),
    lastActivity: parseInt(row.last_activity)
  };
}

const LOBBY_COLUMNS = 'id, host_id, name, visibility, created_at, last_activity, pinned';

// Every lobby is a shared queue that each listener plays at their own pace.
// A private playlist needs an owner; without one it is created public.
async function createLobby(ownerId = null, customId = null, name = null, visibility = 'public', ownerName = null) {
  const id = customId || generateLobbyId();
  const now = Date.now();
  const vis = ownerId ? normalizeVisibility(visibility) : 'public';

  const lobby = {
    id,
    ownerId: ownerId || null,
    ownerName: ownerName || null,
    name: name || null,
    visibility: vis,
    pinned: false,
    createdAt: now,
    lastActivity: now
  };

  if (db.isAvailable()) {
    try {
      await db.query(
        'INSERT INTO lobbies (id, host_id, name, visibility, created_at, last_activity, pinned) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO UPDATE SET last_activity = $6',
        [id, ownerId || null, name || null, vis, now, now, false]
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
        `SELECT ${LOBBY_COLUMNS} FROM lobbies WHERE id = $1`,
        [id]
      );
      if (result.rows.length > 0) {
        lobby = rowToLobby(result.rows[0]);
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
    currentTrack: null  // { title, thumbnail } - what user is currently listening to
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

function setUserCurrentTrack(lobbyId, socketId, track) {
  const users = lobbyUsers.get(lobbyId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  user.currentTrack = track ? { title: track.title, thumbnail: track.thumbnail } : null;
  return user;
}

// Names are unique among the playlists a user can see. `visibleTo(lobby)`
// limits the check so a clash never reveals someone else's private playlist.
function isNameTaken(name, excludeLobbyId = null, visibleTo = null) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  for (const [id, l] of lobbies) {
    if (excludeLobbyId && id === excludeLobbyId) continue;
    if (visibleTo && !visibleTo(l)) continue;
    if (l.name && l.name.toLowerCase().trim() === lower) return true;
  }
  return false;
}

async function renameLobby(lobbyId, newName, visibleTo = null) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const trimmed = newName ? String(newName).trim() : '';
  if (!trimmed) return { error: 'Name cannot be empty' };
  if (trimmed.length > 50) return { error: 'Name must be 50 characters or less' };
  if (isNameTaken(trimmed, lobbyId, visibleTo)) return { error: 'A playlist with that name already exists' };

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

// Set a playlist's visibility ('public' | 'private'). Ownership is enforced
// by the caller (playlistAccess.canManage); this only persists the value.
async function setVisibility(lobbyId, visibility) {
  const vis = normalizeVisibility(visibility);
  const lobby = lobbies.get(lobbyId);
  if (lobby) lobby.visibility = vis;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE lobbies SET visibility = $1 WHERE id = $2', [vis, lobbyId]);
    } catch (err) {
      console.error('Failed to update lobby visibility:', err.message);
    }
  }

  return { lobby: lobby || null, visibility: vis };
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
// explicitly deletes them. This sweep now only reclaims orphaned queue state
// for lobby IDs that no longer exist in memory (e.g. lazily created by
// getQueue() for an already-deleted lobby) — it never removes a lobby itself.
async function cleanupEmptyLobbies() {
  const { cleanupOrphanedQueues } = require('./queue');

  const validLobbyIds = new Set(lobbies.keys());
  cleanupOrphanedQueues(validLobbyIds);
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
function createLobbySync(ownerId = null, customId = null, name = null, visibility = 'public', ownerName = null) {
  const id = customId || generateLobbyId();
  const now = Date.now();

  const users = new Map();
  const lobby = {
    id,
    ownerId: ownerId || null,
    ownerName: ownerName || null,
    name: name || null,
    visibility: ownerId ? normalizeVisibility(visibility) : 'public',
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
    currentTrack: null  // { title, thumbnail } - what user is currently listening to
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
      `SELECT ${LOBBY_COLUMNS} FROM lobbies ORDER BY last_activity DESC`
    );

    for (const row of result.rows) {
      if (!lobbies.has(row.id)) {
        lobbies.set(row.id, rowToLobby(row));
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
      ownerId: lobbyData.ownerId || null,
      ownerName: lobbyData.ownerName || null,
      visibility: normalizeVisibility(lobbyData.visibility),
      pinned: lobbyData.pinned || false,
      userCount,
      createdAt: lobbyData.createdAt,
      lastActivity: lobbyData.lastActivity
    });
  }
  return result;
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
  updateUser,
  setUserCurrentTrack,
  isNameTaken,
  renameLobby,
  VISIBILITIES,
  normalizeVisibility,
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
