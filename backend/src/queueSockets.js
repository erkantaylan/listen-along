/**
 * A playlist's queue over Socket.IO (the web app):
 *
 *   queue:add       { lobbyId, query?, url?, title?, libraryId?, picks?, addedBy? }
 *                   -> queue:adding / queue:requested / queue:error, queue:update to the room
 *   queue:remove    { lobbyId, songId }      (undo within a minute: queue:restore)
 *   queue:restore   { lobbyId, songId }
 *   queue:reorder   { lobbyId, songId, newIndex }
 *   queue:clear     { lobbyId }
 *   queue:get       lobbyId                   -> queue:update to this socket
 *
 * Changes need editableLobby (the socket is in the playlist's room and may
 * edit it); queue:get needs visibleLobby. Both come from the playlist socket
 * handlers' per-connection context, so a hidden playlist looks missing.
 * addedBy / requester come from the account, never from the client.
 */

const { cleanPicks } = require('./features/picker/index.ts');
const { createSocketRateLimit } = require('./shared/memoryRateLimit.ts');

// Songs removed from a queue in the last minute, so the remover can undo
// (queue:restore). key: `${lobbyId}:${songId}` -> { song, index, at }.
const REMOVED_SONG_TTL = 60 * 1000;

/**
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {{ isAvailable: () => boolean }} deps.db
 * @param {(lobbyId: string) => Promise<object>} deps.getQueueAsync - queue.js
 * @param {{ resolve: Function }} deps.resolver - songResolver.createResolver()
 * @param {{ createRequest: Function }} deps.songRequests - requests.js
 * @param {(lobbyId: string, song: object, addedBy: string, opts?: { skipIfQueued?: boolean }) => Promise<object|null>} deps.addLibrarySongToLobby
 * @param {(request: object, requestedByUserId: string) => Promise<void>} deps.queueRequestJob
 * @param {string} deps.APP_ROOM - every approved account's sockets
 */
function createQueueSockets({ io, db, getQueueAsync, resolver, songRequests, addLibrarySongToLobby, queueRequestJob, APP_ROOM }) {
  const removedSongs = new Map();
  function stashRemovedSong(lobbyId, song, index) {
    const now = Date.now();
    for (const [k, v] of removedSongs) if (now - v.at > REMOVED_SONG_TTL) removedSongs.delete(k);
    removedSongs.set(`${lobbyId}:${song.id}`, { song, index, at: now });
  }

  /**
   * The queue handlers of one connection.
   * @param {import('socket.io').Socket} socket
   * @param {object} ctx
   * @param {string} ctx.userId - from the handshake, never the client
   * @param {(lobbyId: unknown) => Promise<object|null>} ctx.visibleLobby
   * @param {(lobbyId: unknown) => Promise<object|null>} ctx.editableLobby
   * @param {(clientName: unknown) => Promise<string>} ctx.displayName
   */
  function register(socket, { userId, visibleLobby, editableLobby, displayName }) {
    // Per-socket rate limiting for expensive operations
    const checkSocketRateLimit = createSocketRateLimit();

    // Add song to queue. Only songs in the library can be queued; anything else
    // becomes a song request (the server never downloads) that is auto-added to
    // this lobby's queue once someone uploads it with the CLI.
    // addedBy / requester come from the account, never from the client (only
    // without a database, where there are no accounts, is its name used).
    // picks: YouTube video ids chosen in the web's pick dialog (POST
    // /api/jobs/picks). Those exact videos are added or requested, with no
    // search; without it everything works as before (query / url / libraryId).
    socket.on('queue:add', async ({ lobbyId, query, url, title, libraryId, picks: rawPicks, addedBy: clientAddedBy } = {}) => {
      if (!checkSocketRateLimit()) {
        socket.emit('queue:error', { message: 'Too many requests, please slow down' });
        return;
      }

      if (!(await editableLobby(lobbyId))) {
        socket.emit('queue:error', { message: 'Playlist not found' });
        return;
      }

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
        result = picks ? await resolver.resolve({ picks }) : await resolver.resolve({ input, libraryId, title });
      } catch (err) {
        console.error('queue:add resolve error:', err);
        socket.emit('queue:error', { message: 'Could not add that song' });
        return;
      }

      const addedBy = await displayName(clientAddedBy);
      const requester = { requestedBy: addedBy, requestedById: userId, lobbyId };

      if (result.type === 'error') {
        socket.emit('queue:error', { message: result.message });
        return;
      }

      if (result.type === 'library') {
        // Adding by library id (library page) is refused for a song the lobby
        // already has queued; search / links may still queue a song twice.
        const song = await addLibrarySongToLobby(lobbyId, result.song, addedBy, { skipIfQueued: !!libraryId });
        if (!song) {
          socket.emit('queue:error', { message: 'Already in the queue', libraryId });
          return;
        }
        console.log(`Song added to lobby ${lobbyId}: ${song.title}`);
        const queue = await getQueueAsync(lobbyId);
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
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
          console.error('Request create error:', err.message);
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
            await addLibrarySongToLobby(lobbyId, item.song, addedBy);
            added++;
          } else {
            const { request, created } = await songRequests.createRequest({ ...item.request, ...requester });
            if (created) { requested++; queueRequestJob(request, userId); }
          }
        } catch (err) {
          console.error(`[playlist] item failed: ${err.message}`);
        }
      }
      const queue = await getQueueAsync(lobbyId);
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      if (requested) io.to(APP_ROOM).emit('requests:updated');
      const capped = result.total > result.items.length ? ` (first ${result.items.length} of ${result.total})` : '';
      const notInLibrary = result.items.length - added;
      socket.emit('queue:adding', {
        status: `Playlist${capped}: added ${added} song${added !== 1 ? 's' : ''}` +
          (notInLibrary ? `, ${notInLibrary} not in the library yet (requested)` : '')
      });
    });

    // Remove song from queue
    socket.on('queue:remove', async ({ lobbyId, songId } = {}) => {
      if (!(await editableLobby(lobbyId))) return;

      const queue = await getQueueAsync(lobbyId);
      const index = queue.getSongs().findIndex(s => s.id === songId);
      const removed = queue.removeSong(songId);
      if (removed) {
        stashRemovedSong(lobbyId, removed, index);
        console.log(`Song removed from lobby ${lobbyId}: ${removed.title}`);
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      }
    });

    // Undo a remove: put a song removed in the last minute back where it was.
    socket.on('queue:restore', async ({ lobbyId, songId } = {}) => {
      if (!(await editableLobby(lobbyId))) return;
      const key = `${lobbyId}:${songId}`;
      const stashed = removedSongs.get(key);
      if (!stashed || Date.now() - stashed.at > REMOVED_SONG_TTL) return;
      removedSongs.delete(key);
      const queue = await getQueueAsync(lobbyId);
      if (queue.insertSong(stashed.song, stashed.index)) {
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      }
    });

    // Reorder song in queue
    socket.on('queue:reorder', async ({ lobbyId, songId, newIndex } = {}) => {
      if (!(await editableLobby(lobbyId))) return;
      const queue = await getQueueAsync(lobbyId);
      const success = queue.reorderSong(songId, newIndex);
      if (success) {
        console.log(`Song reordered in lobby ${lobbyId}: moved to position ${newIndex}`);
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      }
    });

    // Clear all songs from queue
    socket.on('queue:clear', async ({ lobbyId } = {}) => {
      if (!(await editableLobby(lobbyId))) return;
      const queue = await getQueueAsync(lobbyId);
      queue.clear();
      io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
    });

    // Get current queue state
    socket.on('queue:get', async (lobbyId) => {
      if (!(await visibleLobby(lobbyId))) return;
      const queue = await getQueueAsync(lobbyId);
      socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
    });
  }

  return { register };
}

module.exports = { createQueueSockets };
