/**
 * Per-user playlist pins (the sidebar's "Pinned" group): Postgres
 * `playlist_pins` (see db.js), or memory when there is no database.
 *
 * A pin belongs to one user and is never visible to anyone else. It says
 * nothing about access: callers check playlistAccess first, and the list view
 * only annotates playlists the viewer can already see, so a pin on a playlist
 * that went private stays hidden (it comes back if the playlist goes public
 * again). Not to be confused with the older shared `lobbies.pinned` flag.
 */
const db = require('./db');

const memory = new Map(); // userId -> Map(lobbyId -> pinnedAt ms)

class PlaylistGoneError extends Error {}

// lobbyId -> pinnedAt (ms) for one user. Lookup failures read as "no pins": the
// playlist list must still load.
async function pinsForUser(userId) {
  if (!userId) return new Map();
  if (!db.isAvailable()) return new Map(memory.get(userId) || []);
  try {
    const r = await db.query('SELECT lobby_id, pinned_at FROM playlist_pins WHERE user_id = $1', [userId]);
    return new Map(r.rows.map(row => [row.lobby_id, Number(row.pinned_at)]));
  } catch (err) {
    console.error('Failed to load playlist pins:', err.message);
    return new Map();
  }
}

// Idempotent: pinning again keeps the original time. Returns pinnedAt.
async function pin(userId, lobbyId) {
  const now = Date.now();
  if (!db.isAvailable()) {
    if (!memory.has(userId)) memory.set(userId, new Map());
    const mine = memory.get(userId);
    if (!mine.has(lobbyId)) mine.set(lobbyId, now);
    return mine.get(lobbyId);
  }
  try {
    await db.query(
      'INSERT INTO playlist_pins (user_id, lobby_id, pinned_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, lobby_id) DO NOTHING',
      [userId, lobbyId, now]
    );
  } catch (err) {
    // Foreign key: the playlist was deleted between the access check and here.
    if (err.code === '23503') throw new PlaylistGoneError('Playlist not found');
    throw err;
  }
  return (await pinsForUser(userId)).get(lobbyId) || now;
}

async function unpin(userId, lobbyId) {
  if (!db.isAvailable()) {
    const mine = memory.get(userId);
    if (mine) mine.delete(lobbyId);
    return;
  }
  await db.query('DELETE FROM playlist_pins WHERE user_id = $1 AND lobby_id = $2', [userId, lobbyId]);
}

// A deleted playlist: the foreign key cascades in Postgres, memory needs this.
function forgetPlaylist(lobbyId) {
  for (const mine of memory.values()) mine.delete(lobbyId);
}

module.exports = { pinsForUser, pin, unpin, forgetPlaylist, PlaylistGoneError };
