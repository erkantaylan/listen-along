// Each playlist's song list (its "queue"), in memory with the database behind
// it (table queue_songs, column playlist_id).
import { v4 as uuidv4 } from 'uuid';
import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';
import { library } from '../library/index.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

/** A queue entry, as the clients get it (queue:update, /api/playlists/:id/songs). */
export interface QueueSong {
  id: string;
  url: string;
  title: string;
  duration: number;
  addedBy: string;
  thumbnail: string | null;
  /** from the library song on load (not a column); null for an entry the library does not have */
  artistName?: string | null;
  addedAt: number;
}

/** What addSong takes. */
export interface NewQueueSong {
  url: string;
  title?: string | null;
  duration?: number | null;
  addedBy?: string | null;
  thumbnail?: string | null;
  artistName?: string | null;
}

/** What updateSong may change. */
export interface QueueSongChange {
  url?: string;
  title?: string;
  duration?: number | null;
  thumbnail?: string | null;
  artistName?: string | null;
}

/** A `queue_songs` row as loadFromDB reads it. */
interface QueueSongRow {
  id: string;
  url: string;
  title: string;
  /** REAL, read through parseFloat */
  duration: number | string | null;
  added_by: string;
  thumbnail: string | null;
  /** BIGINT */
  added_at: string;
}

// In-memory storage: playlistId -> Queue
const queues = new Map<string, Queue>();

// A playlist's shared song list. There is no shared "now playing" cursor: every
// listener walks the list at their own pace in the browser.
export class Queue {
  playlistId: string;
  songs: QueueSong[];
  _dbChain: Promise<unknown>;

  constructor(playlistId: string) {
    this.playlistId = playlistId;
    this.songs = [];
    // DB writes run one after another, in the order the in-memory changes
    // happened (an add followed quickly by its removal must not race).
    this._dbChain = Promise.resolve();
  }

  _write(label: string, fn: () => Promise<unknown>): Promise<unknown> {
    this._dbChain = this._dbChain.then(fn).catch(err => {
      console.error(`${label}:`, err.message);
    });
    return this._dbChain;
  }

  /** Resolves once every DB write queued so far has finished. */
  flush(): Promise<unknown> {
    return this._dbChain;
  }

  addSong({ url, title, duration, addedBy, thumbnail, artistName }: NewQueueSong): QueueSong {
    const song: QueueSong = {
      id: uuidv4(),
      url,
      title: title || 'Unknown',
      duration: duration || 0,
      addedBy: addedBy || 'anonymous',
      thumbnail: thumbnail || null,
      artistName: artistName || null,
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

  async _persistSong(song: QueueSong, sortOrder: number): Promise<void> {
    await db.query(
      `INSERT INTO queue_songs (id, playlist_id, url, title, duration, added_by, thumbnail, added_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [song.id, this.playlistId, song.url, song.title, song.duration, song.addedBy, song.thumbnail, song.addedAt, sortOrder]
    );
  }

  removeSong(songId: unknown): QueueSong | null {
    const index = this.songs.findIndex(s => s.id === songId);
    if (index === -1) return null;
    const [removed] = this.songs.splice(index, 1);

    // Remove from database if available
    if (db.isAvailable()) {
      this._write('Failed to delete song from DB', () => this._deleteSong(songId));
    }

    return removed;
  }

  async _deleteSong(songId: unknown): Promise<void> {
    await db.query('DELETE FROM queue_songs WHERE id = $1', [songId]);
  }

  /**
   * Put a previously removed entry back (undo of a remove), keeping its id,
   * addedBy and addedAt. The index is clamped to the list.
   * @returns the entry, or null if its id is already queued
   */
  insertSong(song: QueueSong | null | undefined, index: unknown): QueueSong | null {
    if (!song || !song.id || this.songs.some(s => s.id === song.id)) return null;
    const at = Math.max(0, Math.min(Number.isInteger(index) ? index as number : this.songs.length, this.songs.length));
    this.songs.splice(at, 0, song);
    if (db.isAvailable()) {
      this._write('Failed to restore song', async () => {
        await this._persistSong(song, at);
        await this._updateSortOrders();
      });
    }
    return song;
  }

  reorderSong(songId: unknown, newIndex: unknown): boolean {
    const currentIdx = this.songs.findIndex(s => s.id === songId);
    if (currentIdx === -1) return false;
    // Compared as the client sent it (a non-number compares false both ways and is moved to it).
    const to = newIndex as number;
    if (to < 0 || to >= this.songs.length) return false;

    const [song] = this.songs.splice(currentIdx, 1);
    this.songs.splice(to, 0, song);

    // Update sort orders in database if available
    if (db.isAvailable()) {
      this._write('Failed to update sort orders', () => this._updateSortOrders());
    }

    return true;
  }

  // One statement: a playlist can hold thousands of songs and every move rewrites them all.
  async _updateSortOrders(): Promise<void> {
    await db.query(
      `UPDATE queue_songs q SET sort_order = o.position - 1
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
       WHERE q.id = o.id AND q.sort_order IS DISTINCT FROM o.position - 1`,
      [this.songs.map(s => s.id)]
    );
  }

  /**
   * Change an entry's url / title / duration / thumbnail in place (keeps its
   * id, position and addedBy), e.g. after its library song was replaced.
   * @returns the updated entry
   */
  updateSong(songId: string, { url, title, duration, thumbnail, artistName }: QueueSongChange): QueueSong | null {
    const song = this.songs.find(s => s.id === songId);
    if (!song) return null;
    if (url) song.url = url;
    if (title) song.title = title;
    if (duration !== undefined) song.duration = duration || 0;
    if (thumbnail !== undefined) song.thumbnail = thumbnail || null;
    if (artistName !== undefined) song.artistName = artistName || null;
    if (db.isAvailable()) {
      this._write('Failed to update song', () => db.query(
        'UPDATE queue_songs SET url = $2, title = $3, duration = $4, thumbnail = $5 WHERE id = $1',
        [song.id, song.url, song.title, song.duration, song.thumbnail]
      ));
    }
    return song;
  }

  getSongs(): QueueSong[] {
    return [...this.songs];
  }

  clear(): void {
    this.songs = [];

    // Clear from database if available
    if (db.isAvailable()) {
      this._write('Failed to clear queue from DB', () => db.query('DELETE FROM queue_songs WHERE playlist_id = $1', [this.playlistId]));
    }
  }

  /**
   * artistName is not stored on the entry (its title holds "Title - Artist"):
   * it comes from the library song. Unmatched entries (requests) keep null.
   */
  async _loadArtists(): Promise<void> {
    const { isUuid, parseYoutubeId, queueArtist } = library;
    const ids: string[] = [];
    const ytIds: string[] = [];
    for (const s of this.songs) {
      const url = String(s.url || '');
      if (url.startsWith('library:') && isUuid(url.slice(8))) ids.push(url.slice(8));
      const yt = parseYoutubeId(url);
      if (yt) ytIds.push(yt);
    }
    if (!ids.length && !ytIds.length) return;
    try {
      const { rows } = await db.query<{ id: string; youtube_id: string | null; artist: string }>(
        `SELECT id::text AS id, youtube_id, artist FROM library_songs
         WHERE id = ANY($1::uuid[]) OR youtube_id = ANY($2::text[])`,
        [ids, ytIds]
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      const byYt = new Map(rows.filter(r => r.youtube_id).map(r => [r.youtube_id, r]));
      for (const s of this.songs) {
        const url = String(s.url || '');
        const row = (url.startsWith('library:') && byId.get(url.slice(8))) || byYt.get(parseYoutubeId(url));
        s.artistName = row ? queueArtist(row) : null;
      }
    } catch (err) {
      console.error('Failed to load queue artists:', (err as Error).message);
    }
  }

  /**
   * Load queue from database. A failed load THROWS: an empty list here would
   * look like an empty playlist to every client, and a write on it (an add, a
   * clear) would be written over the real one. (The artists are only shown
   * names: their lookup failing leaves them null, as before.)
   */
  async loadFromDB(): Promise<void> {
    if (!db.isAvailable()) return;

    let result;
    try {
      result = await db.query<QueueSongRow>(
        'SELECT id, url, title, duration, added_by, thumbnail, added_at FROM queue_songs WHERE playlist_id = $1 ORDER BY sort_order',
        [this.playlistId]
      );
    } catch (err) {
      console.error('Failed to load queue from DB:', (err as Error).message);
      throw new QueueUnavailableError(this.playlistId, err);
    }

    this.songs = result.rows.map(row => ({
      id: row.id,
      url: row.url,
      title: row.title,
      duration: parseFloat(String(row.duration)) || 0,
      addedBy: row.added_by,
      thumbnail: row.thumbnail,
      addedAt: parseInt(row.added_at)
    }));
    await this._loadArtists();
  }
}

/** A playlist's songs could not be loaded (the database failed): never treat it as an empty playlist. */
export class QueueUnavailableError extends Error {
  code = 'QUEUE_UNAVAILABLE';
  constructor(playlistId: string, cause: unknown) {
    super(`Could not load the songs of playlist ${playlistId}`);
    this.cause = cause;
  }
}

// Loads in flight, so that concurrent first requests share one load and none
// of them sees a queue before it is loaded.
const loading = new Map<string, Promise<Queue>>();

export function getQueue(playlistId: string): Queue {
  if (!queues.has(playlistId)) {
    queues.set(playlistId, new Queue(playlistId));
  }
  return queues.get(playlistId)!;
}

/**
 * Get queue and load from database if available. The queue is kept only once
 * it loaded; a failed load rejects (QueueUnavailableError) and the next call
 * tries again. Concurrent calls share the load in flight.
 */
export async function getQueueAsync(playlistId: string): Promise<Queue> {
  const have = queues.get(playlistId);
  if (have) return have;
  let pending = loading.get(playlistId);
  if (!pending) {
    const queue = new Queue(playlistId);
    pending = queue.loadFromDB()
      .then(() => {
        // Kept only now, loaded. (A queue made meanwhile by getQueue() stays.)
        if (!queues.has(playlistId)) queues.set(playlistId, queue);
        return queues.get(playlistId)!;
      })
      .finally(() => { loading.delete(playlistId); });
    loading.set(playlistId, pending);
  }
  return pending;
}

export function deleteQueue(playlistId: string): boolean {
  const queue = queues.get(playlistId);
  if (queue && db.isAvailable()) {
    db.query('DELETE FROM queue_songs WHERE playlist_id = $1', [playlistId]).catch(err => {
      console.error('Failed to delete queue from DB:', err.message);
    });
  }
  return queues.delete(playlistId);
}

export function hasQueue(playlistId: string): boolean {
  return queues.has(playlistId);
}

/**
 * Remove queue entries for playlist IDs not in the provided set of valid IDs.
 * Called by the playlists' cleanup to prevent orphaned Map entries from accumulating.
 */
export function cleanupOrphanedQueues(validPlaylistIds: Set<string>): void {
  for (const playlistId of queues.keys()) {
    if (!validPlaylistIds.has(playlistId)) {
      deleteQueue(playlistId);
    }
  }
}

/**
 * Forget every queue in memory, as a restart does (the database keeps them).
 * For tests: an ES module is not loaded afresh when it is required again.
 */
export function forgetAll(): void {
  queues.clear();
  loading.clear();
}
