const { v4: uuidv4 } = require('uuid');

const lobbies = new Map();
const LOBBY_CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const LOBBY_TIMEOUT = 5 * 60 * 1000; // 5 minutes empty before cleanup

function generateLobbyId() {
  return uuidv4().substring(0, 8);
}

function createLobby(hostId = null, customId = null) {
  const id = customId || generateLobbyId();
  const lobby = {
    id,
    hostId,
    users: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  lobbies.set(id, lobby);
  return lobby;
}

function getLobby(id) {
  return lobbies.get(id);
}

function joinLobby(lobbyId, socketId, username) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const user = {
    socketId,
    username: username || `User-${socketId.substring(0, 4)}`,
    joinedAt: Date.now()
  };
  lobby.users.set(socketId, user);
  lobby.lastActivity = Date.now();
  return { lobby, user };
}

function leaveLobby(lobbyId, socketId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return null;

  const user = lobby.users.get(socketId);
  if (user) {
    lobby.users.delete(socketId);
    lobby.lastActivity = Date.now();
  }
  return user;
}

function getLobbyUsers(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return [];
  return Array.from(lobby.users.values());
}

function deleteLobby(id) {
  return lobbies.delete(id);
}

function cleanupEmptyLobbies() {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    if (lobby.users.size === 0 && (now - lobby.lastActivity) > LOBBY_TIMEOUT) {
      lobbies.delete(id);
      console.log(`Cleaned up empty lobby: ${id}`);
    }
  }
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

module.exports = {
  createLobby,
  getLobby,
  joinLobby,
  leaveLobby,
  getLobbyUsers,
  deleteLobby,
  lobbies
};
