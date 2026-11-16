/**
 * A playlist's queue over Socket.IO (the web app):
 *
 *   queue:add       { playlistId, query?, url?, title?, libraryId?, picks?, addedBy? }
 *                   -> queue:adding / queue:requested / queue:error, queue:update to the room
 *   queue:remove    { playlistId, songId }      (undo within a minute: queue:restore)
 *   queue:restore   { playlistId, songId }
 *   queue:reorder   { playlistId, songId, newIndex }
 *   queue:clear     { playlistId }
 *   queue:get       playlistId                   -> queue:update to this socket
 *
 * For one release the id is also read from, and queue:update also carries,
 * its name from before the rename (shared/legacyWire.ts).
 * Changes need editablePlaylist (the socket is in the playlist's room and may
 * edit it); queue:get needs visiblePlaylist. Both come from the playlist socket
 * handlers' per-connection context, so a hidden playlist looks missing.
 * addedBy / requester come from the account, never from the client.
 */

import { cleanPicks } from '../requests/index.ts';
import { playlistIdOf, withLegacyId } from '../../shared/legacyWire.ts';
import type { PlaylistIdPayload } from '../../shared/legacyWire.ts';
import type { Resolver, SongRequest, NewRequest } from '../requests/index.ts';
import { createSocketRateLimit } from '../../shared/memoryRateLimit.ts';
import type { AppSocket, LibrarySongRow, Playlist } from '../../shared/types.ts';
import { QueueUnavailableError } from './queue.ts';
import type { Queue, QueueSong } from './queue.ts';

// Songs removed from a queue in the last minute, so the remover can undo
// (queue:restore). key: `${playlistId}:${songId}` -> { song, index, at }.
const REMOVED_SONG_TTL = 60 * 1000;

/** What the handlers use of the Socket.IO server (the real one fits). */
export interface QueueIo {
  to(room: string): { emit(event: string, payload?: unknown): unknown };
}

export interface QueueSocketsDeps {
  io: QueueIo;
  db: { isAvailable(): boolean };
  /** queue.ts */
  getQueueAsync: (playlistId: string) => Promise<Queue>;
  /** songResolver.createResolver() */
  resolver: Resolver;
  /** requests.ts */
  songRequests: { createRequest(r: NewRequest): Promise<{ request: SongRequest; created: boolean }> };
  /** reactions: a library song into a playlist's queue (null: not added) */
  addLibrarySongToPlaylist: (playlistId: string, song: LibrarySongRow, addedBy: string, opts?: { skipIfQueued?: boolean }) => Promise<QueueSong | null>;
  /** reactions: the download job of a new request */
  queueRequestJob: (request: SongRequest, requestedByUserId: string) => unknown;
  /** every approved account's sockets */
  APP_ROOM: string;
}

/** The connection's context, from the playlist socket handlers (playlistSockets.ts). */
export interface QueueSocketContext {
  /** from the handshake, never the client */
  userId: string;
  /** the playlist when this socket may see it (a hidden one is missing) */
  visiblePlaylist: (playlistId: unknown) => Promise<Playlist | null>;
  /** ... and may edit it (in its room) */
  editablePlaylist: (playlistId: unknown) => Promise<Playlist | null>;
  /** the account's name (the client's only without a database) */
  displayName: (clientName: unknown) => Promise<string>;
}

/** queue:add (every field as the client sent it). */
interface QueueAddPayload extends PlaylistIdPayload {
  query?: unknown;
  url?: unknown;
  title?: unknown;
  libraryId?: unknown;
  picks?: unknown;
  addedBy?: unknown;
}

/** queue:remove / restore / reorder / clear. */
interface QueueEditPayload extends PlaylistIdPayload {
  songId?: unknown;
  newIndex?: unknown;
}

export interface QueueSockets {
  register(socket: AppSocket, ctx: QueueSocketContext): void;
}

export function createQueueSockets({ io, db, getQueueAsync, resolver, songRequests, addLibrarySongToPlaylist, queueRequestJob, APP_ROOM }: QueueSocketsDeps): QueueSockets {
  const removedSongs = new Map<string, { song: QueueSong; index: number; at: number }>();
  function stashRemovedSong(playlistId: string, song: QueueSong, index: number) {
    const now = Date.now();
    for (const [k, v] of removedSongs) if (now - v.at > REMOVED_SONG_TTL) removedSongs.delete(k);
    removedSongs.set(`${playlistId}:${song.id}`, { song, index, at: now });
  }

  /**
   * The queue handlers of one connection.
   */
  function register(socket: AppSocket, { userId, visiblePlaylist, editablePlaylist, displayName }: QueueSocketContext): void {
    // Per-socket rate limiting for expensive operations
    const checkSocketRateLimit = createSocketRateLimit();

    // A playlist whose songs could not be loaded (the database failed) is an
    // error, never an empty playlist: nothing is changed, the client is told.
    // Each handler takes the client's one payload, untyped on the wire.
    const onQueue = (event: string, handler: (payload: never) => Promise<void>) => {
      socket.on(event, async (payload: unknown) => {
        try {
          await handler(payload as never);
        } catch (err) {
          if (!(err instanceof QueueUnavailableError)) throw err;
          socket.emit('queue:error', { message: 'This playlist could not be loaded, try again', code: err.code });
        }
      });
    };

    // Add song to queue. Only songs in the library can be queued; anything else
    // becomes a song request (the server never downloads) that is auto-added to
    // this playlist's queue once someone uploads it with the CLI.
    // addedBy / requester come from the account, never from the client (only
    // without a database, where there are no accounts, is its name used).
    // picks: YouTube video ids chosen in the web's pick dialog (POST
    // /api/jobs/picks). Those exact videos are added or requested, with no
    // search; without it everything works as before (query / url / libraryId).
    onQueue('queue:add', async (payload: QueueAddPayload = {}) => {
      const { query, url, title, libraryId, picks: rawPicks, addedBy: clientAddedBy } = payload;
      const rawId = playlistIdOf(payload);
      if (!checkSocketRateLimit()) {
        socket.emit('queue:error', { message: 'Too many requests, please slow down' });
        return;
      }

      const playlist = await editablePlaylist(rawId);
      if (!playlist) {
        socket.emit('queue:error', { message: 'Playlist not found' });
        return;
      }
      // editablePlaylist found it by this id: a string.
      const playlistId = rawId as string;

      if (!db.isAvailable()) {
        socket.emit('queue:error', { message: 'The music library is unavailable (no database)' });
        return;
      }

      const picks = rawPicks === undefined ? null : cleanPicks(rawPicks);
      if (rawPicks !== undefined && !picks) {
        socket.emit('queue:error', { message: 'Could not add that selection' });
        return;
      }

      const input = url || query;
      if (!libraryId && !picks) socket.emit('queue:adding', { status: 'Looking it up…' });

      let result;
      try {
        // The resolver checks these as it goes (a library id, a text, a title).
        result = picks ? await resolver.resolve({ picks }) : await resolver.resolve({ input, libraryId: libraryId as string | undefined, title: title as string | undefined });
      } catch (err) {
        console.error('queue:add resolve error:', err);
        socket.emit('queue:error', { message: 'Could not add that song' });
        return;
      }

      const addedBy = await displayName(clientAddedBy);
      const requester = { requestedBy: addedBy, requestedById: userId, playlistId };

      if (result.type === 'error') {
        socket.emit('queue:error', { message: result.message });
        return;
      }

      if (result.type === 'library') {
        // Adding by library id (library page) is refused for a song the playlist
        // already has queued; search / links may still queue a song twice.
        const song = await addLibrarySongToPlaylist(playlistId, result.song, addedBy, { skipIfQueued: !!libraryId });
        if (!song) {
          socket.emit('queue:error', { message: 'Already in the queue', libraryId });
          return;
        }
        console.log(`Song added to playlist ${playlistId}: ${song.title}`);
        const queue = await getQueueAsync(playlistId);
        io.to(playlistId).emit('queue:update', withLegacyId({ playlistId, songs: queue.getSongs() }));
        return;
      }

      if (result.type === 'request') {
        try {
          const { request, created } = await songRequests.createRequest({ ...result.request, ...requester });
          const name = request.title || request.youtube_id || 'That song';
          socket.emit('queue:requested', {
            request,
            created,
            message: created
              ? `"${name}" isn't in the library yet. It has been requested and will be added to the queue once uploaded.`
              : `"${name}" isn't in the library yet. It was already requested.`
          });
          if (created) {
            io.to(APP_ROOM).emit('requests:updated');
            queueRequestJob(request, userId);
          }
        } catch (err) {
          console.error('Request create error:', (err as Error).message);
          socket.emit('queue:error', { message: 'Could not record the request' });
        }
        return;
      }

      // Playlist: queue what the library has, request the rest.
      let added = 0;
      let requested = 0;
      for (const item of result.items) {
        try {
          if (item.type === 'library') {
            await addLibrarySongToPlaylist(playlistId, item.song, addedBy);
            added++;
          } else {
            const { request, created } = await songRequests.createRequest({ ...item.request, ...requester });
            if (created) { requested++; queueRequestJob(request, userId); }
          }
        } catch (err) {
          console.error(`[playlist] item failed: ${(err as Error).message}`);
        }
      }
      const queue = await getQueueAsync(playlistId);
      io.to(playlistId).emit('queue:update', withLegacyId({ playlistId, songs: queue.getSongs() }));
      if (requested) io.to(APP_ROOM).emit('requests:updated');
      const capped = result.total > result.items.length ? ` (first ${result.items.length} of ${result.total})` : '';
      const notInLibrary = result.items.length - added;
      socket.emit('queue:adding', {
        status: `Playlist${capped}: added ${added} song${added !== 1 ? 's' : ''}` +
          (notInLibrary ? `, ${notInLibrary} not in the library yet (requested)` : '')
      });
    });

    // Remove song from queue
    onQueue('queue:remove', async (payload: QueueEditPayload = {}) => {
      const { songId } = payload;
      const playlistId = playlistIdOf(payload);
      if (!(await editablePlaylist(playlistId))) return;
      // Found by this id: a string.
      const id = playlistId as string;

      const queue = await getQueueAsync(id);
      const index = queue.getSongs().findIndex(s => s.id === songId);
      const removed = queue.removeSong(songId);
      if (removed) {
        stashRemovedSong(id, removed, index);
        console.log(`Song removed from playlist ${id}: ${removed.title}`);
        io.to(id).emit('queue:update', withLegacyId({ playlistId: id, songs: queue.getSongs() }));
      }
    });

    // Undo a remove: put a song removed in the last minute back where it was.
    onQueue('queue:restore', async (payload: QueueEditPayload = {}) => {
      const { songId } = payload;
      const playlistId = playlistIdOf(payload);
      if (!(await editablePlaylist(playlistId))) return;
      const id = playlistId as string;
      const key = `${id}:${songId}`;
      const stashed = removedSongs.get(key);
      if (!stashed || Date.now() - stashed.at > REMOVED_SONG_TTL) return;
      removedSongs.delete(key);
      const queue = await getQueueAsync(id);
      if (queue.insertSong(stashed.song, stashed.index)) {
        io.to(id).emit('queue:update', withLegacyId({ playlistId: id, songs: queue.getSongs() }));
      }
    });

    // Reorder song in queue
    onQueue('queue:reorder', async (payload: QueueEditPayload = {}) => {
      const { songId, newIndex } = payload;
      const playlistId = playlistIdOf(payload);
      if (!(await editablePlaylist(playlistId))) return;
      const id = playlistId as string;
      const queue = await getQueueAsync(id);
      const success = queue.reorderSong(songId, newIndex);
      if (success) {
        console.log(`Song reordered in playlist ${id}: moved to position ${newIndex}`);
        io.to(id).emit('queue:update', withLegacyId({ playlistId: id, songs: queue.getSongs() }));
      }
    });

    // Clear all songs from queue
    onQueue('queue:clear', async (payload: QueueEditPayload = {}) => {
      const playlistId = playlistIdOf(payload);
      if (!(await editablePlaylist(playlistId))) return;
      const id = playlistId as string;
      const queue = await getQueueAsync(id);
      queue.clear();
      io.to(id).emit('queue:update', withLegacyId({ playlistId: id, songs: queue.getSongs() }));
    });

    // Get current queue state
    onQueue('queue:get', async (playlistId: unknown) => {
      if (!(await visiblePlaylist(playlistId))) return;
      const id = playlistId as string;
      const queue = await getQueueAsync(id);
      socket.emit('queue:update', withLegacyId({ playlistId: id, songs: queue.getSongs() }));
    });
  }

  return { register };
}
