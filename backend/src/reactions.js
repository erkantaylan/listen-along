/**
 * Cross-area reactions: plain functions that run when something in one area
 * has to change others, so areas never require each other (they get these
 * functions through their deps instead):
 *
 *   emitJob                    a download job changed: the activity log
 *                              (features/activity) and the requester's jobs:update
 *   addJobSongsToPlaylist      a web job's songs go into its target playlist
 *   workersChanged             workers:update to every approved socket, coalesced
 *   queueRequestJob            a new song request becomes a download job
 *   notifyPlaylistsChanged     playlists:changed (sidebars refetch); a private
 *                              playlist's only to its owner
 *   accountStatusChanged       an admin changed a status: caches, sockets, sessions
 *   destroyLobby               a playlist is deleted everywhere
 *   addLibrarySongToLobby      a library song into a playlist's queue
 *   emitUnavailableSongs       which queue entries are not in the library
 *   handleLibrarySongAdded     an upload: library views, requests fulfilled,
 *                              songs into the requesting playlists
 *   handleLibrarySongReplaced  / handleLibrarySongDetailsChanged: every queue
 *                              holding the song is rewritten (rewriteQueueEntries)
 *                              and players are told (library:updated)
 */

const access = require('./playlistAccess');
const { isBlocked } = require('./auth/index.ts');

/**
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {{ isAvailable: () => boolean, query: Function }} deps.db
 * @param {typeof import('./lobby')} deps.lobby
 * @param {(lobbyId: string) => Promise<object>} deps.getQueueAsync - queue.js
 * @param {(lobbyId: string) => boolean} deps.hasQueue - queue.js
 * @param {(lobbyId: string) => void} deps.deleteQueue - queue.js
 * @param {typeof import('./library')} deps.library
 * @param {{ cacheCover: (id: string, url: string) => Promise<unknown> }} deps.covers
 * @param {typeof import('./downloadJobs')} deps.downloadJobs
 * @param {{ forgetPlaylist: (lobbyId: string) => void }} deps.playlistPins
 * @param {{ invalidate: (userId: string) => void }} deps.userAuth
 * @param {{ removeForUser: (userId: string) => Promise<string[]> }|null} deps.sessionStore - central login only
 * @param {{ jobChanged: (row: object) => void }} deps.activityFeed
 * @param {() => { stats: () => object, dispatch: () => void }} deps.getWorkerHub - made after these (it calls emitJob)
 * @param {() => ({ profileChanged: Function, lobbyChanged: Function }|null)} deps.getSocial - made in start()
 * @param {string} deps.APP_ROOM
 * @param {(userId: string) => string} deps.userRoom
 * @param {(idHash: string) => string} deps.sessionRoom
 */
function createReactions({
  io, db, lobby, getQueueAsync, hasQueue, deleteQueue, library, covers, downloadJobs, playlistPins, userAuth, sessionStore,
  activityFeed, getWorkerHub, getSocial, APP_ROOM, userRoom, sessionRoom,
}) {
  function emitJob(row) {
    if (!row) return;
    // Everyone's activity log (features/activity), then the requester's own, richer view.
    activityFeed.jobChanged(row);
    if (!row.requested_by_user_id) return;
    io.to(userRoom(row.requested_by_user_id)).emit('jobs:update', { job: downloadJobs.toPublic(row), workers: getWorkerHub().stats() });
  }
  // A web download job targets a playlist: add what it got (as the requester,
  // if they can still edit it). Song-request jobs need nothing here: the
  // request flow (handleLibrarySongAdded) adds to the requesting playlist.
  async function addJobSongsToPlaylist(job, songs) {
    if (!job || job.source !== 'web' || !job.playlist_id || !db.isAvailable()) return;
    const l = await lobby.getLobbyAsync(job.playlist_id);
    if (!l || !access.canEdit(l, job.requested_by_user_id)) return;
    let added = 0;
    for (const song of songs) {
      if (!song) continue;
      if (await addLibrarySongToLobby(job.playlist_id, song, job.requested_by || 'Someone', { skipIfQueued: true })) added++;
    }
    if (added) {
      const queue = await getQueueAsync(job.playlist_id);
      io.to(job.playlist_id).emit('queue:update', { lobbyId: job.playlist_id, songs: queue.getSongs() });
    }
  }

  // The worker counts every approved socket shows (workers:update). Coalesce
  // bursts (connect + dispatch + finish).
  let workersChangedTimer = null;
  function workersChanged() {
    if (workersChangedTimer) return;
    workersChangedTimer = setTimeout(() => {
      workersChangedTimer = null;
      io.to(APP_ROOM).emit('workers:update', getWorkerHub().stats());
    }, 200);
  }

  // A song request was created: it becomes a download job (automatic).
  async function queueRequestJob(request, requestedByUserId) {
    try {
      const row = await downloadJobs.createForRequest(request, { requestedByUserId });
      if (!row) return;
      emitJob(row);
      getWorkerHub().dispatch();
    } catch (err) {
      console.error('[jobs] could not queue a job for request', request && request.id, err.message);
    }
  }

  // Sidebars refetch /api/playlists on this signal. It carries nothing, and a
  // private playlist's changes only reach its owner. `everyone`: the playlist
  // just changed visibility, so others gain or lose it.
  function notifyPlaylistsChanged(l, { everyone = false } = {}) {
    if (!everyone && l && access.isPrivate(l) && l.ownerId) io.to(userRoom(l.ownerId)).emit('playlists:changed');
    else io.to(APP_ROOM).emit('playlists:changed');
  }

  // An admin changed an account's status: forget the cached status at once, and
  // a denied / rejected account loses its open sockets (the handshake refuses
  // new ones) and, with central login, every session (so it is signed out
  // everywhere; signing in again is refused while it stays blocked). Its CLI
  // tokens stop by themselves (tokens.verifyToken needs an approved owner).
  async function accountStatusChanged(userId, status) {
    userAuth.invalidate(userId);
    const social = getSocial();
    if (social) social.profileChanged(String(userId));
    if (!isBlocked(status)) return;
    io.in(userRoom(String(userId))).disconnectSockets(true);
    if (sessionStore) {
      try {
        const gone = await sessionStore.removeForUser(String(userId));
        for (const h of gone) io.in(sessionRoom(h)).disconnectSockets(true);
        if (gone.length) console.log(`[oidc] user ${userId} is ${status}: ${gone.length} session(s) ended`);
      } catch (err) {
        // Still locked out: every request checks the status.
        console.error(`[oidc] could not end the sessions of user ${userId}:`, err.message);
      }
    }
  }

  // Tear down a lobby everywhere: notify + disconnect members, clear
  // queue state, then delete the row from BOTH memory and the DB.
  // Shared by the admin (dashboard) and creator delete paths. Uses the async
  // delete so the row does not resurrect on restart (there is no longer any
  // time-based cleanup to remove stale rows — hq-9gvy).
  async function destroyLobby(lobbyId, { reason } = {}) {
    const before = await lobby.getLobbyAsync(lobbyId);
    io.to(lobbyId).emit('lobby:closed', {
      lobbyId,
      message: reason || 'This playlist has been deleted.'
    });
    const room = io.sockets.adapter.rooms.get(lobbyId);
    for (const socketId of room ? [...room] : []) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.data.evict) s.data.evict(lobbyId);
    }
    io.in(lobbyId).socketsLeave(lobbyId);

    deleteQueue(lobbyId);

    await lobby.deleteLobbyAsync(lobbyId);
    playlistPins.forgetPlaylist(lobbyId);
    const social = getSocial();
    if (social) social.lobbyChanged(lobbyId);
    notifyPlaylistsChanged(before);
  }

  // Append a library song to a lobby's queue. Caller broadcasts the queue:update.
  // skipIfQueued: add nothing (returns null) when the song is already in the
  // queue. Checked here, with no await before addSong, so two quick adds of the
  // same song cannot both get through.
  async function addLibrarySongToLobby(lobbyId, librarySong, addedBy, { skipIfQueued = false } = {}) {
    const queue = await getQueueAsync(lobbyId);
    if (skipIfQueued && library.isQueued(queue.getSongs(), librarySong)) return null;
    const entry = library.toQueueEntry(librarySong);
    const song = queue.addSong({ ...entry, artistName: library.queueArtist(librarySong), addedBy: addedBy || 'anonymous' });
    if (entry.thumbnail) {
      covers.cacheCover(song.id, entry.thumbnail).catch(err => {
        console.error(`Failed to cache cover for ${song.id}:`, err.message);
      });
    }
    return song;
  }

  // Tell a socket/room which queue entries are not playable (not in library).
  async function emitUnavailableSongs(target, songs) {
    if (!db.isAvailable() || !songs || !songs.length) return;
    try {
      const missing = await library.findUnavailableUrls(songs.map(s => s.url));
      for (const url of missing) {
        target.emit('download:status', { url, status: 'unavailable', error: 'Not in the library yet' });
      }
    } catch (err) {
      console.error('Availability check failed:', err.message);
    }
  }

  // A song's audio (and metadata) was replaced under the same id. Queue entries
  // keep pointing at it by url, which may change (a new youtube_id): rewrite
  // every entry of every playlist that held the old song to the new url /
  // title / duration / cover, then tell clients. Players that are playing it
  // get library:updated { replaced } and reload the new file at the same
  // position (frontend player.reloadReplaced).
  async function handleLibrarySongReplaced(librarySong, previous) {
    const pub = library.toPublic(librarySong);
    const { entry, oldUrls, rewritten } = await rewriteQueueEntries(librarySong, previous, { covers: true });
    io.to(APP_ROOM).emit('library:updated', {
      song: pub,
      replaced: { id: librarySong.id, oldUrls, url: entry.url, file_version: pub.file_version },
    });
    for (const url of new Set([entry.url, librarySong.source_url].filter(Boolean))) {
      io.to(APP_ROOM).emit('download:status', { url, status: 'ready', percent: 100 });
    }
    if (rewritten) console.log(`[library] replaced ${librarySong.id}: rewrote ${rewritten} queue entr${rewritten === 1 ? 'y' : 'ies'}`);
  }

  // Only the title, artist or album changed: queue entries follow, and players
  // update what they show without touching the audio (library:updated { details }).
  async function handleLibrarySongDetailsChanged(librarySong, previous) {
    const { entry, oldUrls } = await rewriteQueueEntries(librarySong, previous, { covers: false });
    io.to(APP_ROOM).emit('library:updated', {
      song: library.toPublic(librarySong),
      details: { id: librarySong.id, oldUrls, url: entry.url },
    });
    // An active replace job keeps the song's details (library.updateDetails wrote
    // them): whoever shows the job gets the new ones.
    if (db.isAvailable()) {
      downloadJobs.activeReplaceJob(librarySong.id).then((row) => { if (row) emitJob(row); }).catch(() => {});
    }
  }

  // Every entry of every playlist holding the song gets its current url / title
  // / duration / cover; viewers get queue:update.
  async function rewriteQueueEntries(librarySong, previous, { covers: withCovers }) {
    const entry = library.toQueueEntry(librarySong);
    const oldUrls = [...new Set([library.queueUrlFor(previous), `library:${previous.id}`, previous.source_url].filter(Boolean))];
    // Queues already in memory, plus (below) any in the DB that hold the song.
    const lobbyIds = new Set(lobby.getAllLobbies().map(l => l.id).filter(id => hasQueue(id)));
    if (db.isAvailable()) {
      // Playlists not loaded in memory yet still have their queue in the DB.
      const ytId = previous.youtube_id || null;
      const r = await db.query(
        `SELECT DISTINCT lobby_id FROM queue_songs WHERE url = ANY($1::text[])
           OR ($2::text IS NOT NULL AND url LIKE '%' || $2 || '%')`,
        [oldUrls, ytId]
      ).catch(() => ({ rows: [] }));
      for (const row of r.rows) lobbyIds.add(row.lobby_id);
    }
    let rewritten = 0;
    for (const lobbyId of lobbyIds) {
      try {
        const queue = await getQueueAsync(lobbyId);
        const hits = queue.getSongs().filter(s => library.isQueued([s], previous));
        if (!hits.length) continue;
        for (const s of hits) {
          queue.updateSong(s.id, { ...entry, artistName: library.queueArtist(librarySong) });
          if (withCovers && entry.thumbnail) covers.cacheCover(s.id, entry.thumbnail).catch(() => {});
          rewritten++;
        }
        io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
      } catch (err) {
        console.error(`[library] could not rewrite queue of ${lobbyId} after a change:`, err.message);
      }
    }
    return { entry, oldUrls, rewritten };
  }

  // A song was uploaded (or an upload hit an existing song that fulfils
  // requests): refresh library views, mark matching queue entries playable, and
  // add the song to the queue of every lobby that requested it.
  async function handleLibrarySongAdded(librarySong, fulfilled = []) {
    const pub = library.toPublic(librarySong);
    io.to(APP_ROOM).emit('library:updated', { song: pub });
    // Waiting download jobs for these requests have nothing left to do.
    if (fulfilled.length && db.isAvailable()) {
      downloadJobs.settleForFulfilledRequests(fulfilled.map(r => r.id), librarySong)
        .then((rows) => rows.forEach(emitJob)).catch(() => {});
    }
    const urls = new Set([library.queueUrlFor(librarySong)]);
    if (librarySong.source_url) urls.add(librarySong.source_url);
    for (const url of urls) io.to(APP_ROOM).emit('download:status', { url, status: 'ready', percent: 100 });

    const byLobby = new Map();
    for (const r of fulfilled) {
      if (r.lobby_id && !byLobby.has(r.lobby_id)) byLobby.set(r.lobby_id, r);
    }
    for (const [lobbyId, request] of byLobby) {
      try {
        const lobbyData = await lobby.getLobbyAsync(lobbyId);
        if (!lobbyData) continue;
        const queue = await getQueueAsync(lobbyId);
        const alreadyQueued = queue.getSongs().some(s => urls.has(s.url));
        if (!alreadyQueued) {
          await addLibrarySongToLobby(lobbyId, librarySong, request.requested_by);
          io.to(lobbyId).emit('queue:update', { lobbyId, songs: queue.getSongs() });
        }
        io.to(lobbyId).emit('request:fulfilled', {
          request,
          song: pub,
          addedToQueue: !alreadyQueued,
          message: `"${pub.title}" is now in the library${alreadyQueued ? '' : ' and was added to the queue'} (requested by ${request.requested_by})`
        });
      } catch (err) {
        console.error(`[library] could not add fulfilled request to lobby ${lobbyId}:`, err.message);
      }
    }
  }

  return {
    emitJob,
    addJobSongsToPlaylist,
    workersChanged,
    queueRequestJob,
    notifyPlaylistsChanged,
    accountStatusChanged,
    destroyLobby,
    addLibrarySongToLobby,
    emitUnavailableSongs,
    handleLibrarySongAdded,
    handleLibrarySongReplaced,
    handleLibrarySongDetailsChanged,
    rewriteQueueEntries,
  };
}

module.exports = { createReactions };
