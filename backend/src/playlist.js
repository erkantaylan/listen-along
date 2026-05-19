/**
 * Playlist module for persistent playlists with public/private visibility.
 *
 * Ownership is tracked by `created_by` (set from req.user.id at the API layer).
 * `is_public = true` makes the playlist visible to all authenticated users;
 * private playlists are only visible to their creator.
 */

const db = require('./db');

/**
 * Create a new playlist (public by default).
 */
async function createPlaylist(userId, name) {
  if (!db.isAvailable()) return null;

  const now = Date.now();
  const result = await db.query(
    `INSERT INTO playlists (created_by, name, is_public, created_at)
     VALUES ($1, $2, TRUE, $3)
     RETURNING id, created_by, name, is_public, created_at`,
    [userId, name, now]
  );

  return result.rows[0];
}

/**
 * Get all playlists owned by a user (both public and private).
 */
async function getPlaylistsByUser(userId) {
  if (!db.isAvailable()) return [];

  const result = await db.query(
    `SELECT p.id, p.created_by, p.name, p.is_public, p.created_at,
            COUNT(ps.id)::int AS song_count
     FROM playlists p
     LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
     WHERE p.created_by = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Get all playlists visible to a user: every public playlist plus the user's
 * own private playlists.
 */
async function getVisiblePlaylists(userId) {
  if (!db.isAvailable()) return [];

  const result = await db.query(
    `SELECT p.id, p.created_by, p.name, p.is_public, p.created_at,
            COUNT(ps.id)::int AS song_count
     FROM playlists p
     LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
     WHERE p.is_public = TRUE OR p.created_by = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Get a single playlist with its songs. No visibility check — callers must
 * gate access via getPlaylistVisible.
 */
async function getPlaylist(playlistId) {
  if (!db.isAvailable()) return null;

  const playlistResult = await db.query(
    'SELECT id, created_by, name, is_public, created_at FROM playlists WHERE id = $1',
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
 * Get a playlist if the user is allowed to see it (public, or owner).
 * Returns null for non-existent OR private-not-owned (do not leak existence).
 */
async function getPlaylistVisible(playlistId, userId) {
  if (!db.isAvailable()) return null;

  const playlist = await getPlaylist(playlistId);
  if (!playlist) return null;
  if (!playlist.is_public && playlist.created_by !== userId) return null;
  return playlist;
}

/**
 * Look up just the owner of a playlist. Used to distinguish 404 vs 403 at the
 * HTTP layer for mutating endpoints.
 */
async function getOwner(playlistId) {
  if (!db.isAvailable()) return null;
  const result = await db.query(
    'SELECT created_by FROM playlists WHERE id = $1',
    [playlistId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].created_by;
}

/**
 * Delete a playlist. Returns 'deleted' | 'not_found' | 'forbidden'.
 */
async function deletePlaylist(playlistId, userId) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  await db.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
  return 'deleted';
}

/**
 * Rename a playlist. Returns the updated row, or 'not_found' | 'forbidden'.
 */
async function renamePlaylist(playlistId, userId, newName) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  const result = await db.query(
    `UPDATE playlists SET name = $1 WHERE id = $2
     RETURNING id, created_by, name, is_public, created_at`,
    [newName, playlistId]
  );
  return result.rows[0];
}

/**
 * Toggle playlist visibility. Returns updated row, or 'not_found' | 'forbidden'.
 */
async function setVisibility(playlistId, userId, isPublic) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  const result = await db.query(
    `UPDATE playlists SET is_public = $1 WHERE id = $2
     RETURNING id, created_by, name, is_public, created_at`,
    [isPublic, playlistId]
  );
  return result.rows[0];
}

/**
 * Add a song to a playlist. Returns the inserted row, or 'not_found' | 'forbidden'.
 */
async function addSong(playlistId, userId, { url, title, duration, thumbnail }) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  const now = Date.now();

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
 * Remove a song. Returns 'removed' | 'not_found' | 'forbidden'.
 */
async function removeSong(playlistId, songId, userId) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  const result = await db.query(
    'DELETE FROM playlist_songs WHERE id = $1 AND playlist_id = $2 RETURNING id',
    [songId, playlistId]
  );

  return result.rowCount > 0 ? 'removed' : 'not_found';
}

/**
 * Reorder a song. Returns 'reordered' | 'not_found' | 'forbidden'.
 */
async function reorderSong(playlistId, songId, newIndex, userId) {
  if (!db.isAvailable()) return 'not_found';

  const owner = await getOwner(playlistId);
  if (owner === null) return 'not_found';
  if (owner !== userId) return 'forbidden';

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const songsResult = await client.query(
      'SELECT id FROM playlist_songs WHERE playlist_id = $1 ORDER BY sort_order',
      [playlistId]
    );

    const songs = songsResult.rows;
    const currentIndex = songs.findIndex(s => s.id === songId);
    if (currentIndex === -1 || newIndex < 0 || newIndex >= songs.length) {
      await client.query('ROLLBACK');
      return 'not_found';
    }

    const [moved] = songs.splice(currentIndex, 1);
    songs.splice(newIndex, 0, moved);

    for (let i = 0; i < songs.length; i++) {
      await client.query(
        'UPDATE playlist_songs SET sort_order = $1 WHERE id = $2',
        [i, songs[i].id]
      );
    }

    await client.query('COMMIT');
    return 'reordered';
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
  getVisiblePlaylists,
  getPlaylist,
  getPlaylistVisible,
  getOwner,
  deletePlaylist,
  renamePlaylist,
  setVisibility,
  addSong,
  removeSong,
  reorderSong
};
