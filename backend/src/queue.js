const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory storage: lobbyId -> Queue
const queues = new Map();

class Queue {
  constructor(lobbyId) {
    this.lobbyId = lobbyId;
    this.songs = [];
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

  removeSong(songId) {
    const index = this.songs.findIndex(s => s.id === songId);
    if (index === -1) return null;
    const [removed] = this.songs.splice(index, 1);

    // Remove from database if available
    if (db.isAvailable()) {
      this._deleteSong(songId).catch(err => {
        console.error('Failed to delete song from DB:', err.message);
      });
    }

    return removed;
  }

  async _deleteSong(songId) {
    await db.query('DELETE FROM queue_songs WHERE id = $1', [songId]);
  }

  reorderSong(songId, newIndex) {
    const currentIndex = this.songs.findIndex(s => s.id === songId);
    if (currentIndex === -1) return false;
    if (newIndex < 0 || newIndex >= this.songs.length) return false;

    const [song] = this.songs.splice(currentIndex, 1);
    this.songs.splice(newIndex, 0, song);

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._updateSortOrders().catch(err => {
        console.error('Failed to update sort orders:', err.message);
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
    return this.songs[0] || null;
  }

  advanceQueue() {
    const song = this.songs.shift() || null;

    // Remove from database if available
    if (song && db.isAvailable()) {
      this._deleteSong(song.id).then(() => {
        return this._updateSortOrders();
      }).catch(err => {
        console.error('Failed to advance queue in DB:', err.message);
      });
    }

    return song;
  }

  /**
   * Move current song (first) to end of queue - for repeat-all mode
   */
  moveCurrentToEnd() {
    if (this.songs.length === 0) return null;
    const current = this.songs.shift();
    this.songs.push(current);

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._updateSortOrders().catch(err => {
        console.error('Failed to update sort orders:', err.message);
      });
    }

    return current;
  }

  clear() {
    this.songs = [];

    // Clear from database if available
    if (db.isAvailable()) {
      db.query('DELETE FROM queue_songs WHERE lobby_id = $1', [this.lobbyId]).catch(err => {
        console.error('Failed to clear queue from DB:', err.message);
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

module.exports = {
  Queue,
  getQueue,
  getQueueAsync,
  deleteQueue,
  hasQueue
};
