const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory storage: lobbyId -> Queue
const queues = new Map();

class Queue {
  constructor(lobbyId) {
    this.lobbyId = lobbyId;
    this.songs = [];
    this.currentIndex = -1; // Cursor: -1 means nothing playing
    this.userPositions = new Map(); // userId -> index (for independent mode)
  }

  getCurrentIndex() {
    return this.currentIndex;
  }

  setCurrentIndex(idx) {
    this.currentIndex = idx;
    // Persist to database if available
    if (db.isAvailable()) {
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }
  }

  addSong({ url, title, duration, addedBy, thumbnail }) {
    const song = {
      id: uuidv4(),
      url,
      title: title || 'Unknown',
      duration: duration || 0,
      addedBy: addedBy || 'anonymous',
      thumbnail: thumbnail || null,
      addedAt: Date.now()
    };
    this.songs.push(song);

    // Persist to database if available
    if (db.isAvailable()) {
      this._persistSong(song, this.songs.length - 1).catch(err => {
        console.error('Failed to persist song:', err.message);
      });
    }

    return song;
  }

  async _persistSong(song, sortOrder) {
    await db.query(
      `INSERT INTO queue_songs (id, lobby_id, url, title, duration, added_by, thumbnail, added_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [song.id, this.lobbyId, song.url, song.title, song.duration, song.addedBy, song.thumbnail, song.addedAt, sortOrder]
    );
  }

  async _persistCurrentIndex() {
    await db.query(
      'UPDATE lobbies SET current_index = $1 WHERE id = $2',
      [this.currentIndex, this.lobbyId]
    );
  }

  removeSong(songId) {
    const index = this.songs.findIndex(s => s.id === songId);
    if (index === -1) return null;
    const [removed] = this.songs.splice(index, 1);

    // Adjust cursor when songs before/at cursor are removed
    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      // Currently-playing song removed; cursor stays, now points to next song
      // If we removed the last song, move cursor back
      if (this.currentIndex >= this.songs.length && this.songs.length > 0) {
        this.currentIndex = this.songs.length - 1;
      } else if (this.songs.length === 0) {
        this.currentIndex = -1;
      }
    }

    // Remove from database if available
    if (db.isAvailable()) {
      this._deleteSong(songId).catch(err => {
        console.error('Failed to delete song from DB:', err.message);
      });
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }

    return removed;
  }

  async _deleteSong(songId) {
    await db.query('DELETE FROM queue_songs WHERE id = $1', [songId]);
  }

  reorderSong(songId, newIndex) {
    const currentIdx = this.songs.findIndex(s => s.id === songId);
    if (currentIdx === -1) return false;
    if (newIndex < 0 || newIndex >= this.songs.length) return false;

    const [song] = this.songs.splice(currentIdx, 1);
    this.songs.splice(newIndex, 0, song);

    // Adjust cursor to track the currently-playing song through reorder
    if (this.currentIndex >= 0) {
      if (currentIdx === this.currentIndex) {
        // The song being moved IS the current song
        this.currentIndex = newIndex;
      } else if (currentIdx < this.currentIndex && newIndex >= this.currentIndex) {
        // Song moved from before cursor to after/at cursor
        this.currentIndex--;
      } else if (currentIdx > this.currentIndex && newIndex <= this.currentIndex) {
        // Song moved from after cursor to before/at cursor
        this.currentIndex++;
      }
    }

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._updateSortOrders().catch(err => {
        console.error('Failed to update sort orders:', err.message);
      });
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }

    return true;
  }

  async _updateSortOrders() {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < this.songs.length; i++) {
        await client.query(
          'UPDATE queue_songs SET sort_order = $1 WHERE id = $2',
          [i, this.songs[i].id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  getSongs() {
    return [...this.songs];
  }

  getCurrentSong() {
    if (this.currentIndex >= 0 && this.currentIndex < this.songs.length) {
      return this.songs[this.currentIndex];
    }
    // Fallback: return first song when cursor not initialized
    return this.songs[0] || null;
  }

  /**
   * Advance cursor to next song. Does NOT remove any songs.
   * Respects repeat modes: 'all' wraps around, 'off' stops at end.
   * Returns the next song or null if at end with no repeat.
   */
  advanceToNext(repeatMode) {
    if (this.songs.length === 0) return null;

    const next = this.currentIndex + 1;
    if (next >= this.songs.length) {
      if (repeatMode === 'all') {
        this.currentIndex = 0;
      } else {
        return null; // End of queue
      }
    } else {
      this.currentIndex = next;
    }

    if (db.isAvailable()) {
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }

    return this.songs[this.currentIndex];
  }

  /**
   * Move cursor to previous song.
   * With repeat-all, wraps to end. Otherwise clamps at 0.
   */
  goToPrevious(repeatMode) {
    if (this.songs.length === 0) return null;

    const prev = this.currentIndex - 1;
    if (prev < 0) {
      if (repeatMode === 'all') {
        this.currentIndex = this.songs.length - 1;
      } else {
        this.currentIndex = 0;
        return this.songs[0];
      }
    } else {
      this.currentIndex = prev;
    }

    if (db.isAvailable()) {
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }

    return this.songs[this.currentIndex];
  }

  /**
   * Legacy method - now advances cursor instead of shifting songs.
   * Used by queue:next handler in non-shuffle mode.
   */
  advanceQueue() {
    if (this.songs.length === 0) return null;
    const current = this.getCurrentSong();
    this.advanceToNext('off');
    return current;
  }

  /**
   * Legacy method for repeat-all mode.
   * With cursor model, just return current song (no reordering needed).
   */
  moveCurrentToEnd() {
    if (this.songs.length === 0) return null;
    return this.getCurrentSong();
  }

  /**
   * Shuffle all songs after currentIndex (upcoming songs only).
   * Uses Fisher-Yates for fair random distribution.
   */
  shuffleUpcoming() {
    if (this.songs.length === 0) return;
    const startIdx = this.currentIndex + 1;
    if (startIdx >= this.songs.length) return;

    this._fisherYatesShuffle(this.songs, startIdx);

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._updateSortOrders().catch(err => {
        console.error('Failed to update sort orders after shuffle:', err.message);
      });
    }
  }

  /**
   * Fisher-Yates in-place shuffle from startIdx to end of array.
   */
  _fisherYatesShuffle(arr, startIdx) {
    for (let i = arr.length - 1; i > startIdx; i--) {
      const j = startIdx + Math.floor(Math.random() * (i - startIdx + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  getSongAtIndex(index) {
    return this.songs[index] || null;
  }

  getUserPosition(userId) {
    return this.userPositions.get(userId) || 0;
  }

  getUserCurrentSong(userId) {
    const index = this.getUserPosition(userId);
    return this.songs[index] || null;
  }

  advanceUserPosition(userId) {
    const current = this.getUserPosition(userId);
    const next = current + 1;
    if (next >= this.songs.length) {
      return null;
    }
    this.userPositions.set(userId, next);
    return this.songs[next];
  }

  setUserPosition(userId, index) {
    this.userPositions.set(userId, index);
  }

  removeUserPosition(userId) {
    this.userPositions.delete(userId);
  }

  clear() {
    this.songs = [];
    this.currentIndex = -1;

    // Clear from database if available
    if (db.isAvailable()) {
      db.query('DELETE FROM queue_songs WHERE lobby_id = $1', [this.lobbyId]).catch(err => {
        console.error('Failed to clear queue from DB:', err.message);
      });
      this._persistCurrentIndex().catch(err => {
        console.error('Failed to persist currentIndex:', err.message);
      });
    }
  }

  /**
   * Load queue from database
   */
  async loadFromDB() {
    if (!db.isAvailable()) return;

    try {
      const result = await db.query(
        'SELECT id, url, title, duration, added_by, thumbnail, added_at FROM queue_songs WHERE lobby_id = $1 ORDER BY sort_order',
        [this.lobbyId]
      );

      this.songs = result.rows.map(row => ({
        id: row.id,
        url: row.url,
        title: row.title,
        duration: parseFloat(row.duration) || 0,
        addedBy: row.added_by,
        thumbnail: row.thumbnail,
        addedAt: parseInt(row.added_at)
      }));

      // Load currentIndex from lobbies table
      const lobbyResult = await db.query(
        'SELECT current_index FROM lobbies WHERE id = $1',
        [this.lobbyId]
      );
      if (lobbyResult.rows.length > 0 && lobbyResult.rows[0].current_index != null) {
        this.currentIndex = parseInt(lobbyResult.rows[0].current_index);
      }
    } catch (err) {
      console.error('Failed to load queue from DB:', err.message);
    }
  }
}

function getQueue(lobbyId) {
  if (!queues.has(lobbyId)) {
    queues.set(lobbyId, new Queue(lobbyId));
  }
  return queues.get(lobbyId);
}

/**
 * Get queue and load from database if available
 */
async function getQueueAsync(lobbyId) {
  if (!queues.has(lobbyId)) {
    const queue = new Queue(lobbyId);
    queues.set(lobbyId, queue);

    // Try to load from database
    await queue.loadFromDB();
  }
  return queues.get(lobbyId);
}

function deleteQueue(lobbyId) {
  const queue = queues.get(lobbyId);
  if (queue && db.isAvailable()) {
    db.query('DELETE FROM queue_songs WHERE lobby_id = $1', [lobbyId]).catch(err => {
      console.error('Failed to delete queue from DB:', err.message);
    });
  }
  return queues.delete(lobbyId);
}

function hasQueue(lobbyId) {
  return queues.has(lobbyId);
}

/**
 * Remove queue entries for lobby IDs not in the provided set of valid IDs.
 * Called by lobby cleanup to prevent orphaned Map entries from accumulating.
 */
function cleanupOrphanedQueues(validLobbyIds) {
  for (const lobbyId of queues.keys()) {
    if (!validLobbyIds.has(lobbyId)) {
      deleteQueue(lobbyId);
    }
  }
}

module.exports = {
  Queue,
  getQueue,
  getQueueAsync,
  deleteQueue,
  hasQueue,
  cleanupOrphanedQueues
};
