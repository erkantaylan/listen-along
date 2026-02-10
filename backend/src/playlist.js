/**
 * Playlist module for persistent per-user playlists
 *
 * Provides CRUD operations for playlists and their songs.
 * Requires database to be available (playlists are persistent).
 */

const db = require('./db');

/**
 * Create a new playlist
 */
async function createPlaylist(userId, name) {
  if (!db.isAvailable()) return null;

  const now = Date.now();
  const result = await db.query(
    'INSERT INTO playlists (user_id, name, created_at) VALUES ($1, $2, $3) RETURNING id, user_id, name, created_at',
    [userId, name, now]
  );

  return result.rows[0];
}

/**
 * Get all playlists for a user
 */
async function getPlaylistsByUser(userId) {
  if (!db.isAvailable()) return [];

  const result = await db.query(
    `SELECT p.id, p.user_id, p.name, p.created_at,
            COUNT(ps.id)::int AS song_count
     FROM playlists p
     LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Get a single playlist with its songs
 */
async function getPlaylist(playlistId) {
  if (!db.isAvailable()) return null;

  const playlistResult = await db.query(
    'SELECT id, user_id, name, created_at FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (playlistResult.rows.length === 0) return null;

  const playlist = playlistResult.rows[0];

  const songsResult = await db.query(
    'SELECT id, url, title, duration, thumbnail, sort_order, added_at FROM playlist_songs WHERE playlist_id = $1 ORDER BY sort_order',
    [playlistId]
  );

  playlist.songs = songsResult.rows;
  return playlist;
}

/**
 * Delete a playlist (cascade deletes songs)
 */
async function deletePlaylist(playlistId, userId) {
  if (!db.isAvailable()) return false;

  const result = await db.query(
    'DELETE FROM playlists WHERE id = $1 AND user_id = $2 RETURNING id',
    [playlistId, userId]
  );

  return result.rowCount > 0;
}

/**
 * Rename a playlist
 */
async function renamePlaylist(playlistId, userId, newName) {
  if (!db.isAvailable()) return null;

  const result = await db.query(
    'UPDATE playlists SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, user_id, name, created_at',
    [newName, playlistId, userId]
  );

  return result.rows[0] || null;
}

/**
 * Add a song to a playlist
 */
async function addSong(playlistId, { url, title, duration, thumbnail }) {
  if (!db.isAvailable()) return null;

  const now = Date.now();

  // Get current max sort_order
  const orderResult = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM playlist_songs WHERE playlist_id = $1',
    [playlistId]
  );
  const sortOrder = orderResult.rows[0].next_order;

  const result = await db.query(
    `INSERT INTO playlist_songs (playlist_id, url, title, duration, thumbnail, sort_order, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, url, title, duration, thumbnail, sort_order, added_at`,
    [playlistId, url, title || 'Unknown', duration || 0, thumbnail || null, sortOrder, now]
  );

  return result.rows[0];
}

/**
 * Remove a song from a playlist
 */
async function removeSong(playlistId, songId) {
  if (!db.isAvailable()) return false;

  const result = await db.query(
    'DELETE FROM playlist_songs WHERE id = $1 AND playlist_id = $2 RETURNING id',
    [songId, playlistId]
  );

  return result.rowCount > 0;
}

/**
 * Reorder a song in a playlist
 */
async function reorderSong(playlistId, songId, newIndex) {
  if (!db.isAvailable()) return false;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get all songs in order
    const songsResult = await client.query(
      'SELECT id FROM playlist_songs WHERE playlist_id = $1 ORDER BY sort_order',
      [playlistId]
    );

    const songs = songsResult.rows;
    const currentIndex = songs.findIndex(s => s.id === songId);
    if (currentIndex === -1 || newIndex < 0 || newIndex >= songs.length) {
      await client.query('ROLLBACK');
      return false;
    }

    // Reorder in memory
    const [moved] = songs.splice(currentIndex, 1);
    songs.splice(newIndex, 0, moved);

    // Update sort orders
    for (let i = 0; i < songs.length; i++) {
      await client.query(
        'UPDATE playlist_songs SET sort_order = $1 WHERE id = $2',
        [i, songs[i].id]
      );
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createPlaylist,
  getPlaylistsByUser,
  getPlaylist,
  deletePlaylist,
  renamePlaylist,
  addSong,
  removeSong,
  reorderSong
};
