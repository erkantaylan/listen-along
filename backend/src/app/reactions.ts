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
 *   destroyPlaylist               a playlist is deleted everywhere
 *   addLibrarySongToPlaylist      a library song into a playlist's queue
 *   emitUnavailableSongs       which queue entries are not in the library
 *   handleLibrarySongAdded     an upload: library views, requests fulfilled,
 *                              songs into the requesting playlists
 *   handleLibrarySongReplaced  / handleLibrarySongDetailsChanged: every queue
 *                              holding the song is rewritten (rewriteQueueEntries)
 *                              and players are told (library:updated)
 */

import { access } from '../core/playlists/index.ts';
import type { playlist as playlistModule, playlistPins as pinsModule } from '../core/playlists/index.ts';
import type { Queue, QueueSong } from '../core/queue/index.ts';
import type { library as libraryModule, covers as coversModule, SongRequestView } from '../core/library/index.ts';
import type { downloadJobs as jobsModule, WorkerHub } from '../core/jobs/index.ts';
import type { SongRequest } from '../core/requests/index.ts';
import { isBlocked } from '../auth/index.ts';
import type { SessionStore, UserAuth } from '../auth/index.ts';
import type { ActivityFeed } from '../features/activity/index.ts';
import type { Db, Io, JobWithJoins, LibrarySongRow, Playlist } from '../shared/types.ts';

export interface ReactionsDeps {
  io: Io;
  db: Db;
  /** core/playlists playlist.ts */
  playlist: Pick<typeof playlistModule, 'getPlaylistAsync' | 'deletePlaylistAsync' | 'getAllPlaylists'>;
  getQueueAsync: (playlistId: string) => Promise<Queue>;
  hasQueue: (playlistId: string) => boolean;
  deleteQueue: (playlistId: string) => boolean;
  library: typeof libraryModule;
  covers: Pick<typeof coversModule, 'cacheCover'>;
  downloadJobs: typeof jobsModule;
  playlistPins: Pick<typeof pinsModule, 'forgetPlaylist'>;
  userAuth: Pick<UserAuth, 'invalidate'>;
  /** central login only */
  sessionStore: Pick<SessionStore, 'removeForUser'> | null;
  activityFeed: Pick<ActivityFeed, 'jobChanged'>;
  /** made after these (it calls emitJob) */
  getWorkerHub: () => Pick<WorkerHub, 'stats' | 'dispatch'>;
  /** made in start() */
  getSocial: () => { profileChanged(userId: string): unknown; lobbyChanged(playlistId: string): void } | null;
  APP_ROOM: string;
  userRoom: (userId: string) => string;
  sessionRoom: (idHash: string) => string;
}

/** Something to emit to: a socket or a room. */
interface Emitter { emit(event: string, payload?: unknown): unknown }

export function createReactions({
  io, db, playlist, getQueueAsync, hasQueue, deleteQueue, library, covers, downloadJobs, playlistPins, userAuth, sessionStore,
  activityFeed, getWorkerHub, getSocial, APP_ROOM, userRoom, sessionRoom,
}: ReactionsDeps) {
  function emitJob(row: JobWithJoins | null | undefined): void {
    if (!row) return;
    // Everyone's activity log (features/activity), then the requester's own, richer view.
    activityFeed.jobChanged(row);
    if (!row.requested_by_user_id) return;
    io.to(userRoom(row.requested_by_user_id)).emit('jobs:update', { job: downloadJobs.toPublic(row), workers: getWorkerHub().stats() });
  }
  // A web download job targets a playlist: add what it got (as the requester,
  // if they can still edit it). Song-request jobs need nothing here: the
  // request flow (handleLibrarySongAdded) adds to the requesting playlist.
  async function addJobSongsToPlaylist(job: JobWithJoins | null | undefined, songs: Array<LibrarySongRow | null>): Promise<void> {
    if (!job || job.source !== 'web' || !job.playlist_id || !db.isAvailable()) return;
    const l = await playlist.getPlaylistAsync(job.playlist_id);
    if (!l || !access.canEdit(l, job.requested_by_user_id)) return;
    let added = 0;
    for (const song of songs) {
      if (!song) continue;
      if (await addLibrarySongToPlaylist(job.playlist_id, song, job.requested_by || 'Someone', { skipIfQueued: true })) added++;
    }
    if (added) {
      const queue = await getQueueAsync(job.playlist_id);
      io.to(job.playlist_id).emit('queue:update', { lobbyId: job.playlist_id, songs: queue.getSongs() });
    }
  }

  // The worker counts every approved socket shows (workers:update). Coalesce
  // bursts (connect + dispatch + finish).
  let workersChangedTimer: NodeJS.Timeout | null = null;
  function workersChanged(): void {
    if (workersChangedTimer) return;
    workersChangedTimer = setTimeout(() => {
      workersChangedTimer = null;
      io.to(APP_ROOM).emit('workers:update', getWorkerHub().stats());
    }, 200);
  }

  // A song request was created: it becomes a download job (automatic).
  async function queueRequestJob(request: SongRequest, requestedByUserId: string | null): Promise<void> {
    try {
      const row = await downloadJobs.createForRequest(request, { requestedByUserId });
      if (!row) return;
      emitJob(row);
      getWorkerHub().dispatch();
    } catch (err) {
      console.error('[jobs] could not queue a job for request', request && request.id, (err as Error).message);
    }
  }

  // Sidebars refetch /api/playlists on this signal. It carries nothing, and a
  // private playlist's changes only reach its owner. `everyone`: the playlist
  // just changed visibility, so others gain or lose it.
  function notifyPlaylistsChanged(l: Playlist | null | undefined, { everyone = false }: { everyone?: boolean } = {}): void {
    if (!everyone && l && access.isPrivate(l) && l.ownerId) io.to(userRoom(l.ownerId)).emit('playlists:changed');
    else io.to(APP_ROOM).emit('playlists:changed');
  }

  // An admin changed an account's status: forget the cached status at once, and
  // a denied / rejected account loses its open sockets (the handshake refuses
  // new ones) and, with central login, every session (so it is signed out
  // everywhere; signing in again is refused while it stays blocked). Its CLI
  // tokens stop by themselves (tokens.verifyToken needs an approved owner).
  async function accountStatusChanged(userId: string, status: string): Promise<void> {
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
        console.error(`[oidc] could not end the sessions of user ${userId}:`, (err as Error).message);
      }
    }
  }

  // Tear down a playlist everywhere: notify + disconnect members, clear
  // queue state, then delete the row from BOTH memory and the DB.
  // Shared by the admin (dashboard) and creator delete paths. Uses the async
  // delete so the row does not resurrect on restart (there is no longer any
  // time-based cleanup to remove stale rows — hq-9gvy).
  async function destroyPlaylist(playlistId: string, { reason }: { reason?: string } = {}): Promise<void> {
    const before = await playlist.getPlaylistAsync(playlistId);
    io.to(playlistId).emit('lobby:closed', {
      lobbyId: playlistId,
      message: reason || 'This playlist has been deleted.'
    });
    const room = io.sockets.adapter.rooms.get(playlistId);
    for (const socketId of room ? [...room] : []) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.data.evict) s.data.evict(playlistId);
    }
    io.in(playlistId).socketsLeave(playlistId);

    deleteQueue(playlistId);

    await playlist.deletePlaylistAsync(playlistId);
    playlistPins.forgetPlaylist(playlistId);
    const social = getSocial();
    if (social) social.lobbyChanged(playlistId);
    notifyPlaylistsChanged(before);
  }

  // Append a library song to a playlist's queue. Caller broadcasts the queue:update.
  // skipIfQueued: add nothing (returns null) when the song is already in the
  // queue. Checked here, with no await before addSong, so two quick adds of the
  // same song cannot both get through.
  async function addLibrarySongToPlaylist(
    playlistId: string, librarySong: LibrarySongRow, addedBy: string | null | undefined, { skipIfQueued = false }: { skipIfQueued?: boolean } = {},
  ): Promise<QueueSong | null> {
    const queue = await getQueueAsync(playlistId);
    if (skipIfQueued && library.isQueued(queue.getSongs(), librarySong)) return null;
    const entry = library.toQueueEntry(librarySong);
    const song = queue.addSong({ ...entry, artistName: library.queueArtist(librarySong), addedBy: addedBy || 'anonymous' });
    if (entry.thumbnail) {
      covers.cacheCover(song.id, entry.thumbnail).catch(err => {
        console.error(`Failed to cache cover for ${song.id}:`, (err as Error).message);
      });
    }
    return song;
  }

  // Tell a socket/room which queue entries are not playable (not in library).
  async function emitUnavailableSongs(target: Emitter, songs: QueueSong[] | null | undefined): Promise<void> {
    if (!db.isAvailable() || !songs || !songs.length) return;
    try {
      const missing = await library.findUnavailableUrls(songs.map(s => s.url));
      for (const url of missing) {
        target.emit('download:status', { url, status: 'unavailable', error: 'Not in the library yet' });
      }
    } catch (err) {
      console.error('Availability check failed:', (err as Error).message);
    }
  }

  // A song's audio (and metadata) was replaced under the same id. Queue entries
  // keep pointing at it by url, which may change (a new youtube_id): rewrite
  // every entry of every playlist that held the old song to the new url /
  // title / duration / cover, then tell clients. Players that are playing it
  // get library:updated { replaced } and reload the new file at the same
  // position (frontend player.reloadReplaced).
  async function handleLibrarySongReplaced(librarySong: LibrarySongRow, previous: LibrarySongRow): Promise<void> {
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
  async function handleLibrarySongDetailsChanged(librarySong: LibrarySongRow, previous: LibrarySongRow): Promise<void> {
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
  async function rewriteQueueEntries(librarySong: LibrarySongRow, previous: LibrarySongRow, { covers: withCovers }: { covers: boolean }) {
    const entry = library.toQueueEntry(librarySong);
    const oldUrls = [...new Set([library.queueUrlFor(previous), `library:${previous.id}`, previous.source_url].filter(Boolean))];
    // Queues already in memory, plus (below) any in the DB that hold the song.
    const playlistIds = new Set(playlist.getAllPlaylists().map(l => l.id).filter(id => hasQueue(id)));
    if (db.isAvailable()) {
      // Playlists not loaded in memory yet still have their queue in the DB.
      const ytId = previous.youtube_id || null;
      const r = await db.query<{ playlist_id: string }>(
        `SELECT DISTINCT playlist_id FROM queue_songs WHERE url = ANY($1::text[])
           OR ($2::text IS NOT NULL AND url LIKE '%' || $2 || '%')`,
        [oldUrls, ytId]
      ).catch(() => ({ rows: [] as Array<{ playlist_id: string }> }));
      for (const row of r.rows) playlistIds.add(row.playlist_id);
    }
    let rewritten = 0;
    for (const playlistId of playlistIds) {
      try {
        const queue = await getQueueAsync(playlistId);
        const hits = queue.getSongs().filter(s => library.isQueued([s], previous));
        if (!hits.length) continue;
        for (const s of hits) {
          queue.updateSong(s.id, { ...entry, artistName: library.queueArtist(librarySong) });
          if (withCovers && entry.thumbnail) covers.cacheCover(s.id, entry.thumbnail).catch(() => {});
          rewritten++;
        }
        io.to(playlistId).emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
      } catch (err) {
        console.error(`[library] could not rewrite queue of ${playlistId} after a change:`, (err as Error).message);
      }
    }
    return { entry, oldUrls, rewritten };
  }

  // A song was uploaded (or an upload hit an existing song that fulfils
  // requests): refresh library views, mark matching queue entries playable, and
  // add the song to the queue of every playlist that requested it.
  async function handleLibrarySongAdded(librarySong: LibrarySongRow, fulfilled: SongRequestView[] = []): Promise<void> {
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

    const byPlaylist = new Map();
    for (const r of fulfilled) {
      if (r.lobby_id && !byPlaylist.has(r.lobby_id)) byPlaylist.set(r.lobby_id, r);
    }
    for (const [playlistId, request] of byPlaylist) {
      try {
        const data = await playlist.getPlaylistAsync(playlistId);
        if (!data) continue;
        const queue = await getQueueAsync(playlistId);
        const alreadyQueued = queue.getSongs().some(s => urls.has(s.url));
        if (!alreadyQueued) {
          await addLibrarySongToPlaylist(playlistId, librarySong, request.requested_by);
          io.to(playlistId).emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
        }
        io.to(playlistId).emit('request:fulfilled', {
          request,
          song: pub,
          addedToQueue: !alreadyQueued,
          message: `"${pub.title}" is now in the library${alreadyQueued ? '' : ' and was added to the queue'} (requested by ${request.requested_by})`
        });
      } catch (err) {
        console.error(`[library] could not add fulfilled request to lobby ${playlistId}:`, (err as Error).message);
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
    destroyPlaylist,
    addLibrarySongToPlaylist,
    emitUnavailableSongs,
    handleLibrarySongAdded,
    handleLibrarySongReplaced,
    handleLibrarySongDetailsChanged,
    rewriteQueueEntries,
  };
}

