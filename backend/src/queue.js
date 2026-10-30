const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// In-memory storage: lobbyId -> Queue
const queues = new Map();

// A lobby's shared song list. There is no shared "now playing" cursor: every
// listener walks the list at their own pace in the browser.
class Queue {
  constructor(lobbyId) {
    this.lobbyId = lobbyId;
    this.songs = [];
    // DB writes run one after another, in the order the in-memory changes
    // happened (an add followed quickly by its removal must not race).
    this._dbChain = Promise.resolve();
  }

  _write(label, fn) {
    this._dbChain = this._dbChain.then(fn).catch(err => {
      console.error(`${label}:`, err.message);
    });
    return this._dbChain;
  }

  /** Resolves once every DB write queued so far has finished. */
  flush() {
    return this._dbChain;
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
      const sortOrder = this.songs.length - 1;
      this._write('Failed to persist song', () => this._persistSong(song, sortOrder));
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
      this._write('Failed to delete song from DB', () => this._deleteSong(songId));
    }

    return removed;
  }

  async _deleteSong(songId) {
    await db.query('DELETE FROM queue_songs WHERE id = $1', [songId]);
  }

  /**
   * Put a previously removed entry back (undo of a remove), keeping its id,
   * addedBy and addedAt. The index is clamped to the list.
   * @returns {object|null} the entry, or null if its id is already queued
   */
  insertSong(song, index) {
    if (!song || !song.id || this.songs.some(s => s.id === song.id)) return null;
    const at = Math.max(0, Math.min(Number.isInteger(index) ? index : this.songs.length, this.songs.length));
    this.songs.splice(at, 0, song);
    if (db.isAvailable()) {
      this._write('Failed to restore song', async () => {
        await this._persistSong(song, at);
        await this._updateSortOrders();
      });
    }
    return song;
  }

  reorderSong(songId, newIndex) {
    const currentIdx = this.songs.findIndex(s => s.id === songId);
    if (currentIdx === -1) return false;
    if (newIndex < 0 || newIndex >= this.songs.length) return false;

    const [song] = this.songs.splice(currentIdx, 1);
    this.songs.splice(newIndex, 0, song);

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._write('Failed to update sort orders', () => this._updateSortOrders());
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

  /**
   * Change an entry's url / title / duration / thumbnail in place (keeps its
   * id, position and addedBy), e.g. after its library song was replaced.
   * @returns {object|null} the updated entry
   */
  updateSong(songId, { url, title, duration, thumbnail }) {
    const song = this.songs.find(s => s.id === songId);
    if (!song) return null;
    if (url) song.url = url;
    if (title) song.title = title;
    if (duration !== undefined) song.duration = duration || 0;
    if (thumbnail !== undefined) song.thumbnail = thumbnail || null;
    if (db.isAvailable()) {
      this._write('Failed to update song', () => db.query(
        'UPDATE queue_songs SET url = $2, title = $3, duration = $4, thumbnail = $5 WHERE id = $1',
        [song.id, song.url, song.title, song.duration, song.thumbnail]
      ));
    }
    return song;
  }

  getSongs() {
    return [...this.songs];
  }

  clear() {
    this.songs = [];

    // Clear from database if available
    if (db.isAvailable()) {
      this._write('Failed to clear queue from DB', () => db.query('DELETE FROM queue_songs WHERE lobby_id = $1', [this.lobbyId]));
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
