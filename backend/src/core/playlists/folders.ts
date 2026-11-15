/**
 * Playlist folders: a user's own way of organising the playlists sidebar, like
 * Spotify's folders. Personal: a folder and what is filed in it belong to one
 * user and say nothing about the playlists (nobody else sees them, and they
 * change nothing about who may see or edit a playlist).
 *
 * One level: a folder holds playlists, not folders. A playlist is in at most
 * one folder per user (primary key (user_id, playlist_id)); anything the user can
 * see may be filed (their own playlists and public ones).
 *
 *   GET    /api/playlist-folders                           { folders: [{ id, name, position, createdAt, playlistIds }], limits }
 *   POST   /api/playlist-folders                           { name, playlistId? } -> 201 { folder } (playlistId: filed in it at once)
 *   PATCH  /api/playlist-folders/:id                       { name } -> { folder }
 *   DELETE /api/playlist-folders/:id                       its playlists go back to the top level, never deleted
 *   PUT    /api/playlist-folders/:id/playlists/:playlistId  file a playlist here (out of any other folder)
 *   DELETE /api/playlist-folders/:id/playlists/:playlistId  take it out of this folder (to the top level)
 *
 * The visibility rule is the pins' (core/playlists/playlistPins.ts): a playlist the caller
 * cannot see is a 404 "Playlist not found" exactly like one that does not
 * exist (checked first, from the in-memory playlists, before any database
 * work), and it is left out of every list. A filed playlist that goes private
 * keeps its row, hidden, and is back in its folder when it is public again; one
 * that is deleted takes its rows with it (ON DELETE CASCADE; in memory, pruned
 * when listed). A folder that is not the caller's is a 404 "Folder not found",
 * whoever owns it. The database enforces that a playlist is only filed in a
 * folder of the same user (a composite foreign key).
 *
 * Callers: approved accounts by the auth guard's default for /api/...
 * (policyFor): the web's session cookie and the Android app's `lam_` session
 * (a user session at the account's level). CLI tokens (`la_`) are not a
 * session here (401), and a legacy ownerless token has no user at all.
 * Each change emits playlists:changed to the caller's own room only, so the
 * user's other tabs refetch; nobody else hears of it.
 */
import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, Router } from 'express';
import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

export const MAX_FOLDERS = 100;
export const MAX_NAME = 50;

/** A folder as the API shows it. playlistIds: only playlists the caller can see now, in filing order. */
export interface FolderView {
  id: string;
  name: string;
  position: number;
  /** ms */
  createdAt: number;
  playlistIds: string[];
}

/** GET /api/playlist-folders */
export interface FolderList {
  folders: FolderView[];
  limits: { folders: number; nameLength: number };
}

/** What the area needs from the composition root. */
export interface FolderDeps {
  /** The caller's users.id (the guard already required an approved account), or null. */
  userIdFor(req: Request): Promise<string | null>;
  /** Whether the user can see this playlist now (playlistAccess.canView on the live playlist). */
  canSee(playlistId: string, userId: string): Promise<boolean>;
  /** Whether the playlist exists at all (in-memory mode drops rows of deleted ones). */
  exists(playlistId: string): Promise<boolean>;
  /** playlists:changed to this user's own sockets. */
  notifyUser(userId: string): void;
}

interface FolderRow { id: string; name: string; position: number; created_at: string | number }
interface ItemRow { playlist_id: string; folder_id: string; position: number }

class NotFound extends Error {
  readonly code: 'FOLDER_NOT_FOUND' | 'NOT_FOUND';
  constructor(code: 'FOLDER_NOT_FOUND' | 'NOT_FOUND') {
    super(code === 'NOT_FOUND' ? 'Playlist not found' : 'Folder not found');
    this.code = code;
  }
}
class LimitReached extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Playlist ids are 8 characters of a uuid (core/playlists/playlist.ts); anything else cannot be one.
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Control characters and line breaks have no place in a sidebar row.
const BAD_NAME_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A folder name from a request body: { name } or { error }. */
export function cleanFolderName(value: unknown): { name: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'name must be a string' };
  const name = value.trim();
  if (!name) return { error: 'Give the folder a name' };
  if (name.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or less` };
  if (BAD_NAME_RE.test(name)) return { error: 'The name cannot contain line breaks or control characters' };
  return { name };
}

// ------------------------------------------------------------------ the store

interface MemoryFolder { id: string; name: string; position: number; createdAt: number }
interface MemoryUser { folders: Map<string, MemoryFolder>; items: Map<string, { folderId: string; position: number }> }

/** Folders in Postgres (playlist_folders, playlist_folder_items), or in memory without a database. */
export function createFolderStore() {
  const memory = new Map<string, MemoryUser>();
  const mine = (userId: string): MemoryUser => {
    let m = memory.get(userId);
    if (!m) { m = { folders: new Map(), items: new Map() }; memory.set(userId, m); }
    return m;
  };
  const nextPosition = (values: Iterable<{ position: number }>) => {
    let max = -1;
    for (const v of values) max = Math.max(max, v.position);
    return max + 1;
  };

  async function load(userId: string): Promise<{ folders: MemoryFolder[]; items: { playlistId: string; folderId: string; position: number }[] }> {
    if (!db.isAvailable()) {
      const m = mine(userId);
      return {
        folders: [...m.folders.values()].map((f) => ({ ...f })),
        items: [...m.items].map(([playlistId, it]) => ({ playlistId, ...it })),
      };
    }
    const f = await db.query<FolderRow>('SELECT id::text AS id, name, position, created_at FROM playlist_folders WHERE user_id = $1', [userId]);
    const i = await db.query<ItemRow>('SELECT playlist_id, folder_id::text AS folder_id, position FROM playlist_folder_items WHERE user_id = $1', [userId]);
    return {
      folders: f.rows.map((r) => ({ id: r.id, name: r.name, position: Number(r.position), createdAt: Number(r.created_at) })),
      items: i.rows.map((r) => ({ playlistId: r.playlist_id, folderId: r.folder_id, position: Number(r.position) })),
    };
  }

  /** In memory only: a deleted playlist's rows (Postgres cascades). */
  function forget(userId: string, playlistId: string): void {
    memory.get(userId)?.items.delete(playlistId);
  }

  async function create(userId: string, name: string): Promise<MemoryFolder> {
    const folder: MemoryFolder = { id: crypto.randomUUID(), name, position: 0, createdAt: Date.now() };
    if (!db.isAvailable()) {
      const m = mine(userId);
      if (m.folders.size >= MAX_FOLDERS) throw new LimitReached();
      folder.position = nextPosition(m.folders.values());
      m.folders.set(folder.id, folder);
      return { ...folder };
    }
    // The limit and the position are decided under a per-user lock, so two
    // creates at once cannot both take the hundredth place.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('playlist_folders'), hashtext($1))", [userId]);
      const r = await client.query<{ n: number; next: number }>(
        'SELECT COUNT(*)::int AS n, COALESCE(MAX(position) + 1, 0)::int AS next FROM playlist_folders WHERE user_id = $1',
        [userId]
      );
      if (r.rows[0].n >= MAX_FOLDERS) throw new LimitReached();
      folder.position = r.rows[0].next;
      await client.query(
        'INSERT INTO playlist_folders (id, user_id, name, position, created_at) VALUES ($1, $2, $3, $4, $5)',
        [folder.id, userId, name, folder.position, folder.createdAt]
      );
      await client.query('COMMIT');
      return folder;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function rename(userId: string, folderId: string, name: string): Promise<void> {
    if (!db.isAvailable()) {
      const f = memory.get(userId)?.folders.get(folderId);
      if (!f) throw new NotFound('FOLDER_NOT_FOUND');
      f.name = name;
      return;
    }
    const r = await db.query('UPDATE playlist_folders SET name = $3 WHERE id = $2 AND user_id = $1', [userId, folderId, name]);
    if (!r.rowCount) throw new NotFound('FOLDER_NOT_FOUND');
  }

  // Deleting a folder deletes its filing rows (cascade), never a playlist.
  async function remove(userId: string, folderId: string): Promise<void> {
    if (!db.isAvailable()) {
      const m = memory.get(userId);
      if (!m || !m.folders.delete(folderId)) throw new NotFound('FOLDER_NOT_FOUND');
      for (const [playlistId, it] of m.items) if (it.folderId === folderId) m.items.delete(playlistId);
      return;
    }
    const r = await db.query('DELETE FROM playlist_folders WHERE id = $2 AND user_id = $1', [userId, folderId]);
    if (!r.rowCount) throw new NotFound('FOLDER_NOT_FOUND');
  }

  // File a playlist in one of the user's folders (moving it out of any other), at its end.
  async function file(userId: string, folderId: string, playlistId: string): Promise<void> {
    if (!db.isAvailable()) {
      const m = memory.get(userId);
      if (!m || !m.folders.has(folderId)) throw new NotFound('FOLDER_NOT_FOUND');
      const inFolder = [...m.items.values()].filter((it) => it.folderId === folderId);
      m.items.set(playlistId, { folderId, position: nextPosition(inFolder) });
      return;
    }
    try {
      const r = await db.query(
        `INSERT INTO playlist_folder_items (user_id, playlist_id, folder_id, position)
         SELECT f.user_id, $3, f.id,
                COALESCE((SELECT MAX(i.position) + 1 FROM playlist_folder_items i WHERE i.folder_id = f.id), 0)
         FROM playlist_folders f WHERE f.id = $2 AND f.user_id = $1
         ON CONFLICT (user_id, playlist_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position`,
        [userId, folderId, playlistId]
      );
      if (!r.rowCount) throw new NotFound('FOLDER_NOT_FOUND');
    } catch (err) {
      // Foreign key on lobbies: the playlist was deleted after the check.
      if ((err as { code?: string }).code === '23503') throw new NotFound('NOT_FOUND');
      throw err;
    }
  }

  // Out of this folder, to the top level; true when it was in it.
  async function unfile(userId: string, folderId: string, playlistId: string): Promise<boolean> {
    if (!db.isAvailable()) {
      const m = memory.get(userId);
      if (!m || !m.folders.has(folderId)) throw new NotFound('FOLDER_NOT_FOUND');
      if (m.items.get(playlistId)?.folderId !== folderId) return false;
      m.items.delete(playlistId);
      return true;
    }
    const f = await db.query('SELECT 1 FROM playlist_folders WHERE id = $2 AND user_id = $1', [userId, folderId]);
    if (!f.rowCount) throw new NotFound('FOLDER_NOT_FOUND');
    const r = await db.query('DELETE FROM playlist_folder_items WHERE user_id = $1 AND playlist_id = $2 AND folder_id = $3', [userId, playlistId, folderId]);
    return !!r.rowCount;
  }

  return { load, forget, create, rename, remove, file, unfile };
}

export type FolderStore = ReturnType<typeof createFolderStore>;

// ------------------------------------------------------------------ the routes

/** The folders API, mounted by main.ts (after apiLimiter for its path). */
export function createPlaylistFolderRouter(deps: FolderDeps, store: FolderStore = createFolderStore()): Router {
  const router = express.Router();
  const BASE = '/api/playlist-folders';

  const notFound = (res: Response, err: NotFound) => res.status(404).json({ error: err.message, code: err.code });

  // Wrap an async route: the caller's id first, then the handler; known
  // refusals become their answers, anything else a JSON 500.
  type Handler = (req: Request<Record<string, string>>, res: Response, userId: string) => Promise<unknown>;
  const route = (label: string, fn: Handler) => async (req: Request<Record<string, string>>, res: Response) => {
    try {
      const userId = await deps.userIdFor(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      await fn(req, res, userId);
    } catch (err) {
      if (err instanceof NotFound) return notFound(res, err);
      if (err instanceof LimitReached) {
        return res.status(409).json({ error: `You can have at most ${MAX_FOLDERS} folders`, code: 'FOLDER_LIMIT' });
      }
      console.error(`[folders] ${label} failed:`, (err as Error).message);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
    }
  };

  // The ids from the path: a folder id that is not a uuid cannot be one of the
  // caller's; a playlist id is checked against what the caller can see, the
  // same answer for missing and hidden.
  const folderIdOf = (req: Request<Record<string, string>>): string => {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) throw new NotFound('FOLDER_NOT_FOUND');
    return id.toLowerCase();
  };
  async function visiblePlaylistId(raw: unknown, userId: string): Promise<string> {
    const id = typeof raw === 'string' ? raw : '';
    if (!PLAYLIST_ID_RE.test(id) || !(await deps.canSee(id, userId))) throw new NotFound('NOT_FOUND');
    return id;
  }

  async function listFor(userId: string): Promise<FolderView[]> {
    const { folders, items } = await store.load(userId);
    const byFolder = new Map<string, { playlistId: string; position: number }[]>();
    for (const it of items) {
      if (!(await deps.canSee(it.playlistId, userId))) {
        if (!(await deps.exists(it.playlistId))) store.forget(userId, it.playlistId);
        continue; // hidden (went private): kept, not shown
      }
      const list = byFolder.get(it.folderId) || [];
      list.push(it);
      byFolder.set(it.folderId, list);
    }
    return folders
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        name: f.name,
        position: f.position,
        createdAt: f.createdAt,
        playlistIds: (byFolder.get(f.id) || []).sort((a, b) => a.position - b.position || a.playlistId.localeCompare(b.playlistId)).map((it) => it.playlistId),
      }));
  }

  async function folderView(userId: string, folderId: string): Promise<FolderView> {
    const view = (await listFor(userId)).find((f) => f.id === folderId);
    if (!view) throw new NotFound('FOLDER_NOT_FOUND');
    return view;
  }

  router.get(BASE, route('list folders', async (req, res, userId) => {
    const body: FolderList = { folders: await listFor(userId), limits: { folders: MAX_FOLDERS, nameLength: MAX_NAME } };
    res.json(body);
  }));

  router.post(BASE, express.json(), route('create folder', async (req, res, userId) => {
    const body = (req.body || {}) as { name?: unknown; playlistId?: unknown };
    const cleaned = cleanFolderName(body.name);
    if ('error' in cleaned) return res.status(400).json({ error: cleaned.error, code: 'BAD_REQUEST' });
    // "New folder…" from a playlist's menu: the playlist must be one the caller
    // sees, checked before anything is made.
    const playlistId = body.playlistId === undefined || body.playlistId === null ? null : await visiblePlaylistId(body.playlistId, userId);
    const folder = await store.create(userId, cleaned.name);
    if (playlistId) await store.file(userId, folder.id, playlistId);
    deps.notifyUser(userId);
    res.status(201).json({ folder: await folderView(userId, folder.id) });
  }));

  router.patch(`${BASE}/:id`, express.json(), route('rename folder', async (req, res, userId) => {
    const folderId = folderIdOf(req);
    const cleaned = cleanFolderName((req.body || {}).name);
    if ('error' in cleaned) return res.status(400).json({ error: cleaned.error, code: 'BAD_REQUEST' });
    await store.rename(userId, folderId, cleaned.name);
    deps.notifyUser(userId);
    res.json({ folder: await folderView(userId, folderId) });
  }));

  router.delete(`${BASE}/:id`, route('delete folder', async (req, res, userId) => {
    const folderId = folderIdOf(req);
    await store.remove(userId, folderId);
    deps.notifyUser(userId);
    res.json({ id: folderId, deleted: true });
  }));

  router.put(`${BASE}/:id/playlists/:playlistId`, route('file playlist', async (req, res, userId) => {
    const playlistId = await visiblePlaylistId(req.params.playlistId, userId);
    const folderId = folderIdOf(req);
    await store.file(userId, folderId, playlistId);
    deps.notifyUser(userId);
    res.json({ playlistId, folderId });
  }));

  router.delete(`${BASE}/:id/playlists/:playlistId`, route('unfile playlist', async (req, res, userId) => {
    const playlistId = await visiblePlaylistId(req.params.playlistId, userId);
    const folderId = folderIdOf(req);
    const removed = await store.unfile(userId, folderId, playlistId);
    if (removed) deps.notifyUser(userId);
    res.json({ playlistId, folderId: null, removed });
  }));

  return router;
}
