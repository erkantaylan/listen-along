/**
 * Playlists over HTTP, for the web app, the CLI (`la playlist`,
 * `la download/upload --playlist`) and the Android app.
 * Mounted at /api/playlists; /api/lobbies stays as an alias for old clients.
 *
 *   GET    /api/playlists                       the playlists the caller can see
 *   POST   /api/playlists                       create { name?, visibility? }
 *   GET    /api/playlists/:id                   one playlist (+ its listeners)
 *   PATCH  /api/playlists/:id                   rename / change visibility (owner)
 *   PATCH  /api/playlists/:id/visibility        older form of the same
 *   PUT|DELETE /api/playlists/:id/pin           the caller's own sidebar pin
 *   DELETE /api/playlists/:id                   delete (owner)
 *   GET    /api/playlists/:id/songs             its queue, as API rows
 *   POST   /api/playlists/:id/songs             add library songs
 *   DELETE /api/playlists/:id/songs/:ref        remove an entry / every entry of a song
 *   POST   /api/playlists/:id/songs/:entryId/move
 *
 * Every route checks playlistAccess: a playlist the caller cannot see is a
 * 404 (never a 403), so private playlists cannot be probed. Callers are a
 * web session (cookie) or a CLI Bearer token (see the auth guard in
 * auth/authRoutes.ts and requireViewer). Errors are JSON { error, code }. Song
 * changes go through the same queue code as the socket handlers and
 * broadcast queue:update to the playlist room.
 */

import express from 'express';
import type { Request, Response, Router } from 'express';
import * as access from './playlistAccess.ts';
import type { Viewer } from './playlistAccess.ts';
import type * as playlistStore from './playlist.ts';
import type { PlaylistSummary, PlaylistWithUsers } from './playlist.ts';
import type * as pinStore from './playlistPins.ts';
import type { Queue, QueueSong } from '../queue/index.ts';
import type { library as libraryModule } from '../library/index.ts';
import type { Account, UserAuth } from '../../auth/index.ts';
import type { DbModule } from '../../shared/db.ts';
import type { Io, LibrarySongRow, Playlist } from '../../shared/types.ts';

/** Owner display names by users.id (shared with the playlist socket handlers: one cache). */
export type OwnerNames = (ids: Array<string | null | undefined>) => Promise<Map<string, string | null>>;

export interface PlaylistRoutesDeps {
  io: Io;
  db: Pick<DbModule, 'isAvailable' | 'query'>;
  /** playlist.ts */
  playlist: typeof playlistStore;
  /** queue.ts */
  getQueueAsync: (playlistId: string) => Promise<Queue>;
  library: typeof libraryModule;
  playlistPins: typeof pinStore;
  userAuth: Pick<UserAuth, 'userIdFor' | 'getAccount'>;
  adminAuth: { isAdmin(req: Request): boolean };
  getSocial: () => { lobbyChanged(playlistId: string): void } | null;
  /** the Socket.IO room of one account */
  userRoom: (userId: string) => string;
  notifyPlaylistsChanged: (playlist: Playlist, opts?: { everyone?: boolean }) => void;
  destroyPlaylist: (playlistId: string, opts?: { reason?: string }) => Promise<void>;
  addLibrarySongToPlaylist: (playlistId: string, song: LibrarySongRow, addedBy: string, opts?: { skipIfQueued?: boolean }) => Promise<QueueSong | null>;
}

/** What a user sees about a playlist they are allowed to see (playlistInfo). */
export interface PlaylistInfo {
  id: string;
  name: string | null;
  visibility: Playlist['visibility'];
  ownerId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  canManage: boolean;
  canEdit: boolean;
  /** the old shared flag (lobby:pin) */
  pinned: boolean;
  /** the viewer's own pin */
  pinnedByMe: boolean;
  pinnedAt: number | null;
  userCount: number;
  songCount: number;
  createdAt: number;
}

/** A caller of a playlist route (requireViewer). */
interface NamedViewer extends Viewer {
  name: string | null;
}

/** A song reference resolved (resolveLibraryRef). */
type ResolvedRef = { song: LibrarySongRow; code?: undefined; error?: undefined } | { song?: undefined; code: string; error: string };

/** A library row as the song views read it. */
interface SongLookupRow {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
}

/**
 * @returns the router, and ownerNames (shared with the playlist socket handlers: one cache)
 */
export function createPlaylistRoutes({
  io, db, playlist, getQueueAsync, library, playlistPins, userAuth, adminAuth, getSocial, userRoom,
  notifyPlaylistsChanged, destroyPlaylist, addLibrarySongToPlaylist,
}: PlaylistRoutesDeps): { router: Router; ownerNames: OwnerNames } {
  const router = express.Router();

  const PLAYLIST_BASES = ['/api/playlists', '/api/lobbies'];
  const playlistPaths = (suffix = '') => PLAYLIST_BASES.map(b => b + suffix);

  // Owner display names (users.display_name / name), cached briefly.
  const ownerNameCache = new Map<string, { name: string | null; at: number }>(); // userId -> { name, at }
  const OWNER_NAME_TTL = 60 * 1000;
  const ownerNames: OwnerNames = async (ids) => {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    const now = Date.now();
    for (const id of new Set(ids.filter((x): x is string => Boolean(x)))) {
      const hit = ownerNameCache.get(id);
      if (hit && now - hit.at < OWNER_NAME_TTL) out.set(id, hit.name);
      else missing.push(id);
    }
    if (missing.length && db.isAvailable()) {
      try {
        const r = await db.query<{ id: string; name: string | null }>(
          'SELECT id::text AS id, COALESCE(display_name, name, username) AS name FROM users WHERE id::text = ANY($1)',
          [missing]
        );
        for (const row of r.rows) {
          out.set(row.id, row.name || null);
          ownerNameCache.set(row.id, { name: row.name || null, at: now });
        }
      } catch (err) {
        console.error('Owner name lookup failed:', (err as Error).message);
      }
    }
    return out;
  };

  // What a user sees about a playlist they are allowed to see.
  // `pinned` is the old shared flag (lobby:pin); `pinnedByMe` the viewer's own pin.
  async function playlistInfo(
    l: Playlist & { users?: Map<string, unknown>; userCount?: number }, userId: string | null,
    names: Map<string, string | null> | null = null, pins: Map<string, number> | null = null,
  ): Promise<PlaylistInfo> {
    const queue = await getQueueAsync(l.id);
    const nameMap = names || await ownerNames([l.ownerId]);
    const myPins = pins || await playlistPins.pinsForUser(userId);
    return {
      id: l.id,
      name: l.name || null,
      visibility: l.visibility,
      ownerId: l.ownerId || null,
      ownerName: (l.ownerId && nameMap.get(l.ownerId)) || l.ownerName || null,
      isOwner: access.isOwner(l, userId),
      canManage: access.canManage(l, userId),
      canEdit: access.canEdit(l, userId),
      pinned: l.pinned || false,
      pinnedByMe: myPins.has(l.id),
      pinnedAt: myPins.get(l.id) || null,
      userCount: l.users ? l.users.size : (l.userCount || 0),
      songCount: queue.getSongs().length,
      createdAt: l.createdAt
    };
  }

  // Tell everyone looking at a playlist that its name/visibility changed.
  async function broadcastPlaylistUpdated(playlistId: string) {
    const l = await playlist.getPlaylistAsync(playlistId);
    if (!l) return;
    const names = await ownerNames([l.ownerId]);
    io.to(playlistId).emit('lobby:updated', {
      lobbyId: playlistId,
      name: l.name || null,
      visibility: l.visibility,
      ownerId: l.ownerId || null,
      ownerName: (l.ownerId && names.get(l.ownerId)) || l.ownerName || null
    });
  }

  // A playlist went private: every socket in its room that is not the owner's
  // loses it, exactly as if it had been deleted.
  function evictNonOwners(playlistId: string, ownerId: string | null) {
    const room = io.sockets.adapter.rooms.get(playlistId);
    if (!room) return;
    for (const socketId of [...room]) {
      const s = io.sockets.sockets.get(socketId);
      if (!s || (ownerId && s.data.userId === ownerId)) continue;
      s.emit('lobby:closed', { lobbyId: playlistId, message: 'This playlist is no longer available.' });
      if (s.data.evict) s.data.evict(playlistId);
      else s.leave(playlistId);
    }
  }

  // Who is calling a playlist route: { userId, legacy, name }, or null after
  // answering 401. A Bearer token (CLI) was verified by the auth guard
  // (req.apiUser): it acts as the token's owner, or — for a legacy ownerless
  // token — as an ownerless member (playlistAccess viewer rules). Otherwise the
  // signed-in web user (the central-login session, or the dev sign-in; the
  // guard already required an approved account).
  async function requireViewer(req: Request, res: Response): Promise<NamedViewer | null> {
    if (req.apiUser) {
      const { userId, name } = req.apiUser;
      return { userId: userId || null, legacy: !userId, name: name || null };
    }
    const userId = await userAuth.userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    let name: string | null = null;
    try {
      const account: Account | null = await userAuth.getAccount(userId);
      name = account && account.name ? String(account.name).trim().slice(0, 30) : null;
    } catch {}
    return { userId, legacy: false, name };
  }

  // The playlist, or null after answering 404 when it is missing or hidden.
  async function findVisiblePlaylist(req: Request, res: Response, viewer: Viewer): Promise<PlaylistWithUsers | null> {
    const l = await playlist.getPlaylistAsync(req.params.id);
    if (!access.viewerCanView(l, viewer)) {
      res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
      return null;
    }
    // viewerCanView refused a missing one.
    return l!;
  }

  // Wrap an async route: unexpected errors become a JSON 500.
  const playlistRoute = (label: string, fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`Playlist ${label} error:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
    });
  };

  // Playlists the caller can see: every public one plus their own private ones.
  router.get(playlistPaths(), playlistRoute('list playlists', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const visible: PlaylistSummary[] = playlist.getAllPlaylists().filter(l => access.viewerCanView(l, viewer));
    const names = await ownerNames(visible.map(l => l.ownerId));
    const pins = await playlistPins.pinsForUser(viewer.userId);
    const playlists = await Promise.all(visible.map(l => playlistInfo(l, viewer.userId, names, pins)));
    // `lobbies` is the old key, kept for older clients.
    res.json({ playlists, lobbies: playlists });
  }));

  // Create a playlist owned by the caller. Body: { name?, visibility? }.
  // A legacy (ownerless) CLI token creates an ownerless playlist, which is
  // always public: asking it for a private one is refused.
  router.post(playlistPaths(), express.json(), playlistRoute('create playlist', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const { name, visibility = 'public' } = req.body || {};
    if (!playlist.VISIBILITIES.includes(visibility)) {
      return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
    }
    if (viewer.legacy && visibility === 'private') {
      return res.status(403).json({
        error: 'This token has no owner (legacy token): it can only create public playlists. Create a token on your profile page.',
        code: 'FORBIDDEN'
      });
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return res.status(400).json({ error: 'name must be a string', code: 'BAD_REQUEST' });
    }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length > 50) return res.status(400).json({ error: 'Name must be 50 characters or less', code: 'BAD_REQUEST' });
    if (trimmed && playlist.isNameTaken(trimmed, null, l => access.viewerCanView(l, viewer))) {
      return res.status(409).json({ error: 'A playlist with that name already exists', code: 'CONFLICT' });
    }
    const created = await playlist.createPlaylistAsync(viewer.userId, null, trimmed || null, visibility, viewer.name);
    const info = await playlistInfo(created, viewer.userId);
    notifyPlaylistsChanged(created);
    res.status(201).json({ ...info, link: `/playlist/${created.id}` });
  }));

  router.get(playlistPaths('/:id'), playlistRoute('get playlist', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    res.json({ ...(await playlistInfo(l, viewer.userId)), users: playlist.getPlaylistUsers(l.id) });
  }));

  // Rename and/or change visibility. Body: { name?, visibility? }. Both are
  // owner-only (an ownerless legacy playlist can be renamed by an admin only).
  async function updatePlaylist(req: Request, res: Response, { name, visibility }: { name?: unknown; visibility?: unknown }) {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    if (visibility !== undefined) {
      if (!playlist.VISIBILITIES.includes(visibility as string)) {
        return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
      }
      if (!access.viewerCanManage(l, viewer)) {
        return res.status(403).json({ error: 'Only the owner can change visibility', code: 'FORBIDDEN' });
      }
    }
    if (name !== undefined) {
      if (!access.viewerCanRename(l, viewer, { admin: adminAuth.isAdmin(req) })) {
        return res.status(403).json({ error: 'Only the owner can rename', code: 'FORBIDDEN' });
      }
      const result = await playlist.renamePlaylist(l.id, name, other => access.viewerCanView(other, viewer));
      if (!result) return res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
      if (result.error !== undefined) {
        const conflict = /already exists/.test(result.error);
        return res.status(conflict ? 409 : 400).json({ error: result.error, code: conflict ? 'CONFLICT' : 'BAD_REQUEST' });
      }
    }
    const visibilityChanged = visibility !== undefined && visibility !== l.visibility;
    if (visibilityChanged) {
      await playlist.setVisibility(l.id, visibility);
      if (visibility === 'private') evictNonOwners(l.id, l.ownerId);
    }
    await broadcastPlaylistUpdated(l.id);
    const social = getSocial();
    if (social) social.lobbyChanged(l.id);
    if (name !== undefined) {
      // It was just found and renamed.
      const fresh = (await playlist.getPlaylistAsync(l.id))!;
      io.to(l.id).emit('lobby:renamed', { lobbyId: l.id, name: fresh.name });
    }
    // It was just found.
    const fresh = (await playlist.getPlaylistAsync(l.id))!;
    notifyPlaylistsChanged(fresh, { everyone: visibilityChanged });
    res.json(await playlistInfo(fresh, viewer.userId));
  }

  router.patch(playlistPaths('/:id'), express.json(), playlistRoute('update playlist', (req, res) => {
    const { name, visibility } = req.body || {};
    return updatePlaylist(req, res, { name, visibility });
  }));

  // Older form: { is_public: boolean } or { visibility }.
  router.patch(playlistPaths('/:id/visibility'), express.json(), playlistRoute('update visibility', (req, res) => {
    const body = req.body || {};
    let visibility = body.visibility;
    if (visibility === undefined && typeof body.is_public === 'boolean') visibility = body.is_public ? 'public' : 'private';
    if (visibility === undefined) return res.status(400).json({ error: "visibility must be 'public' or 'private'", code: 'BAD_REQUEST' });
    return updatePlaylist(req, res, { visibility });
  }));

  // The caller's own pin (sidebar). Idempotent; PUT pins, DELETE unpins. A
  // playlist the caller cannot see is a 404 like everywhere else. A legacy
  // ownerless token has no user to keep a pin for. Other devices of the same
  // user follow via playlists:changed in their own room only.
  async function setPlaylistPin(req: Request, res: Response, pinned: boolean) {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    if (viewer.legacy) {
      return res.status(403).json({
        error: 'This token has no owner (legacy token), so it has no pins. Create a token on your profile page.',
        code: 'FORBIDDEN'
      });
    }
    // Not a legacy token: a user.
    const userId = viewer.userId!;
    let pinnedAt: number | null = null;
    try {
      if (pinned) pinnedAt = await playlistPins.pin(userId, l.id);
      else await playlistPins.unpin(userId, l.id);
    } catch (err) {
      if (err instanceof playlistPins.PlaylistGoneError) return res.status(404).json({ error: 'Playlist not found', code: 'NOT_FOUND' });
      throw err;
    }
    io.to(userRoom(userId)).emit('playlists:changed');
    res.json({ id: l.id, pinnedByMe: pinned, pinnedAt });
  }

  router.put(playlistPaths('/:id/pin'), playlistRoute('pin playlist', (req, res) => setPlaylistPin(req, res, true)));
  router.delete(playlistPaths('/:id/pin'), playlistRoute('unpin playlist', (req, res) => setPlaylistPin(req, res, false)));

  // Delete as the owner. Ownerless playlists can only be deleted by an admin
  // (DELETE /api/dashboard/lobbies/:id).
  router.delete(playlistPaths('/:id'), playlistRoute('delete playlist', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    if (!access.viewerCanManage(l, viewer)) {
      return res.status(403).json({ error: 'Only the owner can delete this playlist', code: 'FORBIDDEN' });
    }
    await destroyPlaylist(l.id, { reason: 'This playlist has been deleted by its owner.' });
    console.log(`Playlist ${l.id} deleted by owner ${viewer.userId}`);
    res.json({ success: true, id: l.id });
  }));

  // --- A playlist's songs (its queue of library songs) ---------------------
  // Same permission as the web app: whoever can see a playlist can edit its
  // songs. Changes go through the same queue code as the socket handlers and
  // broadcast queue:update to the playlist room, so open web clients update.

  const MAX_SONGS_PER_ADD = 200;

  // Queue entries as the API shows them: position (1-based), the entry id
  // (used to remove / move it) and the library song behind it.
  async function playlistSongViews(songs: QueueSong[]) {
    const byId = new Map<string, SongLookupRow>();
    const byYt = new Map<string, SongLookupRow>();
    if (db.isAvailable() && songs.length) {
      const ids: string[] = [];
      const ytIds: string[] = [];
      for (const s of songs) {
        if (typeof s.url !== 'string') continue;
        if (s.url.startsWith('library:') && library.isUuid(s.url.slice(8))) ids.push(s.url.slice(8));
        const yt = library.parseYoutubeId(s.url);
        if (yt) ytIds.push(yt);
      }
      try {
        const r = await db.query<SongLookupRow>(
          `SELECT id::text AS id, youtube_id, title, artist, album, duration_sec FROM library_songs
           WHERE id = ANY($1::uuid[]) OR youtube_id = ANY($2::text[])`,
          [ids, ytIds]
        );
        for (const row of r.rows) {
          byId.set(row.id, row);
          if (row.youtube_id) byYt.set(row.youtube_id, row);
        }
      } catch (err) {
        console.error('Playlist song lookup failed:', (err as Error).message);
      }
    }
    return songs.map((s, i) => {
      const yt = library.parseYoutubeId(s.url || '');
      const lib = (s.url && s.url.startsWith('library:') && byId.get(s.url.slice(8))) || (yt && byYt.get(yt)) || null;
      return {
        position: i + 1,
        entry_id: s.id,
        library_id: lib ? lib.id : null,
        youtube_id: (lib && lib.youtube_id) || yt || null,
        title: s.title,
        artist: lib ? lib.artist : null,
        duration_sec: Number(s.duration) || (lib && lib.duration_sec !== null ? Number(lib.duration_sec) : null) || null,
        url: s.url,
        thumbnail: s.thumbnail || null,
        added_by: s.addedBy || null,
        added_at: s.addedAt || null,
        available: db.isAvailable() ? !!lib : null
      };
    });
  }

  // A song reference from an API body: a library song id (uuid), "yt:<id>", a
  // bare 11-char YouTube id or a YouTube URL, or { library_id } / { youtube_id }.
  // Returns { song } or { code, error }.
  async function resolveLibraryRef(ref: unknown): Promise<ResolvedRef> {
    let libraryId: string | null = null;
    let youtubeId: string | null = null;
    if (ref && typeof ref === 'object') {
      const o = ref as { library_id?: unknown; youtube_id?: unknown };
      if (typeof o.library_id === 'string') libraryId = o.library_id.trim();
      else if (typeof o.youtube_id === 'string') youtubeId = library.parseYoutubeId(o.youtube_id.replace(/^yt:/i, ''));
      else return { code: 'INVALID', error: 'Expected { library_id } or { youtube_id }' };
      if (libraryId !== null && !library.isUuid(libraryId)) return { code: 'INVALID', error: 'library_id must be a UUID' };
      if (libraryId === null && !youtubeId) return { code: 'INVALID', error: 'Invalid youtube_id' };
    } else if (typeof ref === 'string' && ref.trim()) {
      const s = ref.trim();
      if (library.isUuid(s)) libraryId = s;
      else youtubeId = library.parseYoutubeId(s.replace(/^yt:/i, ''));
      if (!libraryId && !youtubeId) return { code: 'INVALID', error: 'Not a library song id, yt:<id> or YouTube URL' };
    } else {
      return { code: 'INVALID', error: 'Empty song reference' };
    }
    const song = libraryId ? await library.getById(libraryId) : await library.getByYoutubeId(youtubeId);
    if (!song) return { code: 'NOT_IN_LIBRARY', error: 'Not in the library' };
    return { song };
  }

  router.get(playlistPaths('/:id/songs'), playlistRoute('list playlist songs', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    const queue = await getQueueAsync(l.id);
    res.json({ playlist: await playlistInfo(l, viewer.userId), songs: await playlistSongViews(queue.getSongs()) });
  }));

  // Add library songs. Body: { songs: [ref, ...], allow_duplicates?: boolean }.
  // A song already in the playlist is skipped unless allow_duplicates. Answers
  // 200 with one result per ref (added | already_in_playlist | not_in_library |
  // invalid) even if some failed.
  router.post(playlistPaths('/:id/songs'), express.json(), playlistRoute('add playlist songs', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    const body = req.body || {};
    const refs = Array.isArray(body.songs) ? body.songs : null;
    if (!refs || !refs.length) return res.status(400).json({ error: 'songs must be a non-empty array of library ids or yt:<id>', code: 'BAD_REQUEST' });
    if (refs.length > MAX_SONGS_PER_ADD) return res.status(400).json({ error: `At most ${MAX_SONGS_PER_ADD} songs per request`, code: 'BAD_REQUEST' });
    if (!db.isAvailable()) return res.status(503).json({ error: 'The music library is unavailable (no database)', code: 'NO_DATABASE' });
    const allowDuplicates = body.allow_duplicates === true;
    const addedBy = viewer.name || 'CLI';
    const results: Array<Record<string, unknown> & { status: string }> = [];
    for (const ref of refs) {
      const input = ref;
      const resolved = await resolveLibraryRef(ref);
      if (!resolved.song) {
        results.push({ input, status: resolved.code === 'INVALID' ? 'invalid' : 'not_in_library', code: resolved.code, error: resolved.error });
        continue;
      }
      const entry = await addLibrarySongToPlaylist(l.id, resolved.song, addedBy, { skipIfQueued: !allowDuplicates });
      const song = library.toPublic(resolved.song);
      if (!entry) results.push({ input, status: 'already_in_playlist', song });
      else results.push({ input, status: 'added', song, entry_id: entry.id });
    }
    const queue = await getQueueAsync(l.id);
    const added = results.filter(r => r.status === 'added').length;
    if (added) {
      io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
      console.log(`${added} song(s) added to playlist ${l.id} over the API by ${addedBy}`);
    }
    await queue.flush(); // persisted before we answer
    const count = (s: string) => results.filter(r => r.status === s).length;
    res.json({
      playlist_id: l.id,
      summary: { total: results.length, added, already_in_playlist: count('already_in_playlist'), not_in_library: count('not_in_library'), invalid: count('invalid') },
      results,
      song_count: queue.getSongs().length
    });
  }));

  // Remove songs. :ref is a queue entry id (removes that entry), or a library
  // song id / yt:<id> / YouTube id (removes every entry of that song).
  router.delete(playlistPaths('/:id/songs/:ref'), playlistRoute('remove playlist song', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    const queue = await getQueueAsync(l.id);
    const ref = String(req.params.ref || '').trim();
    let targets = queue.getSongs().filter(s => s.id === ref);
    if (!targets.length) {
      let song: LibrarySongRow | null = null;
      if (library.isUuid(ref) && db.isAvailable()) song = await library.getById(ref);
      const yt = library.parseYoutubeId(ref.replace(/^yt:/i, ''));
      const found = song;
      if (found) targets = queue.getSongs().filter(s => library.isQueued([s], found));
      else if (yt) targets = queue.getSongs().filter(s => library.parseYoutubeId(s.url || '') === yt);
    }
    if (!targets.length) return res.status(404).json({ error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
    const removed: Array<{ entry_id: string; title: string; url: string }> = [];
    for (const t of targets) {
      const r = queue.removeSong(t.id);
      if (r) removed.push({ entry_id: r.id, title: r.title, url: r.url });
    }
    io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
    await queue.flush();
    res.json({ playlist_id: l.id, removed, song_count: queue.getSongs().length });
  }));

  // Move one entry. Body: { position } (1-based; or index, 0-based).
  router.post(playlistPaths('/:id/songs/:entryId/move'), express.json(), playlistRoute('move playlist song', async (req, res) => {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;
    const l = await findVisiblePlaylist(req, res, viewer);
    if (!l) return;
    const body = req.body || {};
    const index = Number.isInteger(body.position) ? body.position - 1 : body.index;
    const queue = await getQueueAsync(l.id);
    if (!queue.getSongs().some(s => s.id === req.params.entryId)) {
      return res.status(404).json({ error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
    }
    if (!Number.isInteger(index) || index < 0 || index >= queue.getSongs().length) {
      return res.status(400).json({ error: `position must be between 1 and ${queue.getSongs().length}`, code: 'BAD_REQUEST' });
    }
    queue.reorderSong(req.params.entryId, index);
    io.to(l.id).emit('queue:update', { lobbyId: l.id, songs: queue.getSongs() });
    await queue.flush();
    res.json({ playlist_id: l.id, songs: await playlistSongViews(queue.getSongs()) });
  }));

  return { router, ownerNames };
}
