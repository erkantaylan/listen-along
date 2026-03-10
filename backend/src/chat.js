/**
 * Chat module for lobby messaging
 * Handles in-memory storage with optional database persistence
 */

const crypto = require('crypto');
const db = require('./db');

// In-memory chat history per lobby (most recent messages)
const lobbyMessages = new Map(); // lobbyId -> Array of messages
const MAX_MESSAGES_PER_LOBBY = 100;
const MAX_MESSAGE_LENGTH = 500;

// Per-socket throttle tracking
const socketThrottles = new Map(); // socketId -> { count, resetTime }
const THROTTLE_WINDOW = 10000; // 10 seconds
const THROTTLE_MAX = 5; // max 5 messages per 10 seconds

/**
 * Check if a socket is throttled
 */
function isThrottled(socketId) {
  const now = Date.now();
  let record = socketThrottles.get(socketId);

  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + THROTTLE_WINDOW };
    socketThrottles.set(socketId, record);
  }

  if (record.count >= THROTTLE_MAX) {
    return true;
  }

  record.count++;
  return false;
}

/**
 * Clean up throttle tracking for a socket
 */
function cleanupSocket(socketId) {
  socketThrottles.delete(socketId);
}

/**
 * Create a chat message object
 */
function createMessage(lobbyId, userId, username, emoji, content, songMention) {
  const msg = {
    id: crypto.randomUUID(),
    lobbyId,
    userId,
    username,
    emoji,
    content: content.slice(0, MAX_MESSAGE_LENGTH),
    timestamp: Date.now()
  };
  if (songMention && songMention.id && songMention.title) {
    msg.songMention = {
      id: songMention.id,
      title: String(songMention.title).slice(0, 200),
      thumbnail: songMention.thumbnail || null
    };
  }
  return msg;
}

/**
 * Add a message to in-memory store and optionally persist to DB
 */
async function addMessage(lobbyId, userId, username, emoji, content, songMention) {
  const msg = createMessage(lobbyId, userId, username, emoji, content, songMention);

  // In-memory store
  if (!lobbyMessages.has(lobbyId)) {
    lobbyMessages.set(lobbyId, []);
  }
  const messages = lobbyMessages.get(lobbyId);
  messages.push(msg);

  // Trim to max
  if (messages.length > MAX_MESSAGES_PER_LOBBY) {
    messages.splice(0, messages.length - MAX_MESSAGES_PER_LOBBY);
  }

  // Persist to DB if available
  if (db.isAvailable()) {
    try {
      await db.query(
        `INSERT INTO chat_messages (id, lobby_id, user_id, username, emoji, content, created_at, song_mention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [msg.id, msg.lobbyId, msg.userId, msg.username, msg.emoji, msg.content, msg.timestamp,
         msg.songMention ? JSON.stringify(msg.songMention) : null]
      );
    } catch (err) {
      console.error('Failed to persist chat message:', err.message);
    }
  }

  return msg;
}

/**
 * Get recent messages for a lobby
 */
async function getHistory(lobbyId, limit = 50) {
  // Try memory first
  const cached = lobbyMessages.get(lobbyId);
  if (cached && cached.length > 0) {
    return cached.slice(-limit);
  }

  // Fall back to DB
  if (db.isAvailable()) {
    try {
      const result = await db.query(
        `SELECT id, lobby_id as "lobbyId", user_id as "userId", username, emoji, content, created_at as timestamp, song_mention as "songMention"
         FROM chat_messages
         WHERE lobby_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [lobbyId, limit]
      );

      const messages = result.rows.reverse().map(row => ({
        ...row,
        timestamp: parseInt(row.timestamp),
        songMention: row.songMention ? (typeof row.songMention === 'string' ? JSON.parse(row.songMention) : row.songMention) : undefined
      }));

      // Cache in memory
      lobbyMessages.set(lobbyId, messages);
      return messages;
    } catch (err) {
      console.error('Failed to fetch chat history:', err.message);
    }
  }

  return [];
}

/**
 * Clean up messages for a lobby (when lobby is deleted)
 */
function cleanupLobby(lobbyId) {
  lobbyMessages.delete(lobbyId);
}

module.exports = {
  addMessage,
  getHistory,
  isThrottled,
  cleanupSocket,
  cleanupLobby,
  MAX_MESSAGE_LENGTH
};
