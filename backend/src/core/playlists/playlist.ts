// The playlists, in memory with the database behind them (table `playlists`),
// and who is listening to each one right now (sockets, memory only).
import { v4 as uuidv4 } from 'uuid';
import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';
import type { Playlist, Visibility } from '../../shared/types.ts';
import { cleanupOrphanedQueues } from '../queue/index.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

/** A socket listed as a playlist's listener. */
export interface Listener {
  socketId: string;
  username: string;
  emoji: string | null;
  joinedAt: number;
  /** what this listener is playing: { title, thumbnail } */
  currentTrack: { title: string; thumbnail: string | null } | null;
}

/** A playlist with its listeners (getPlaylist / createPlaylist answer this shape). */
export type PlaylistWithUsers = Playlist & { users: Map<string, Listener> };

/** One row of getAllPlaylists: the playlist and how many listen. */
export type PlaylistSummary = Playlist & { userCount: number };

/** A `playlists` row as PLAYLIST_COLUMNS selects it (core/playlists/schema.ts). */
interface PlaylistRow {
  id: string;
  host_id: string | null;
  name: string | null;
  visibility: string | null;
  /** BIGINT */
  created_at: string;
  /** BIGINT */
  last_activity: string;
  pinned: boolean | null;
}

// In-memory storage (fallback if no database). getPlaylist (sync) attaches the
// listeners to the stored object itself.
export const playlists = new Map<string, Playlist & { users?: Map<string, Listener> }>();
// User connections are always in-memory (transient socket state)
const playlistUsers = new Map<string, Map<string, Listener>>();

// Periodic sweep only reclaims orphaned queue/playback state — it never deletes
// playlists. Time-based playlist expiry was removed in hq-9gvy.
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute

function generatePlaylistId(): string {
  return uuidv4().substring(0, 8);
}

// visibility is 'public' (seen and edited by every logged-in user) or
// 'private' (owner only); see playlistAccess.ts for the rules. ownerId is the
// users.id of the creator (DB column host_id), null for legacy / anonymous
// playlists.
export const VISIBILITIES: string[] = ['public', 'private'];
export function normalizeVisibility(v: unknown): Visibility {
  return v === 'private' ? 'private' : 'public';
}

function rowToPlaylist(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    ownerId: row.host_id || null,
    ownerName: null,
    name: row.name || null,
    visibility: normalizeVisibility(row.visibility),
    pinned: row.pinned || false,
    createdAt: parseInt(row.created_at),
    lastActivity: parseInt(row.last_activity)
  };
}

const PLAYLIST_COLUMNS = 'id, host_id, name, visibility, created_at, last_activity, pinned';

// Every playlist is a shared queue that each listener plays at their own pace.
// A private playlist needs an owner; without one it is created public.
async function createPlaylist(
  ownerId: string | null = null, customId: string | null = null, name: string | null = null,
  visibility: unknown = 'public', ownerName: string | null = null,
): Promise<PlaylistWithUsers> {
  const id = customId || generatePlaylistId();
  const now = Date.now();
  const vis = ownerId ? normalizeVisibility(visibility) : 'public';

  const playlist: Playlist = {
    id,
    ownerId: ownerId || null,
    ownerName: ownerName || null,
    name: name || null,
    visibility: vis,
    pinned: false,
    createdAt: now,
    lastActivity: now
  };

  if (db.isAvailable()) {
    try {
      await db.query(
        'INSERT INTO playlists (id, host_id, name, visibility, created_at, last_activity, pinned) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO UPDATE SET last_activity = $6',
        [id, ownerId || null, name || null, vis, now, now, false]
      );
    } catch (err) {
      console.error('Failed to persist lobby:', (err as Error).message);
    }
  }

  playlists.set(id, playlist);
  playlistUsers.set(id, new Map());

  return { ...playlist, users: new Map() };
}

async function getPlaylist(id: unknown): Promise<PlaylistWithUsers | undefined> {
  // Ids are strings; anything else is looked up as given (and not found in memory).
  const key = id as string;
  // Try memory first
  let playlist = playlists.get(key);

  // If not in memory but DB available, try to load from DB
  if (!playlist && db.isAvailable()) {
    try {
      const result = await db.query<PlaylistRow>(
        `SELECT ${PLAYLIST_COLUMNS} FROM playlists WHERE id = $1`,
        [id]
      );
      if (result.rows.length > 0) {
        playlist = rowToPlaylist(result.rows[0]);
        playlists.set(key, playlist);
        if (!playlistUsers.has(key)) {
          playlistUsers.set(key, new Map());
        }
      }
    } catch (err) {
      console.error('Failed to load lobby from DB:', (err as Error).message);
    }
  }

  if (!playlist) return undefined;

  // Attach users Map for compatibility
  return {
    ...playlist,
    users: playlistUsers.get(key) || new Map()
  };
}

async function updateLastActivity(playlistId: string): Promise<void> {
  const playlist = playlists.get(playlistId);
  if (!playlist) return;

  playlist.lastActivity = Date.now();

  if (db.isAvailable()) {
    try {
      await db.query(
        'UPDATE playlists SET last_activity = $1 WHERE id = $2',
        [playlist.lastActivity, playlistId]
      );
    } catch (err) {
      console.error('Failed to update lobby activity:', (err as Error).message);
    }
  }
}

/** joinPlaylist's answer: the playlist with its listeners, and the new listener. */
export interface Joined {
  playlist: PlaylistWithUsers;
  user: Listener;
}

async function joinPlaylist(playlistId: string, socketId: string, username: string | null | undefined, emoji: string | null | undefined): Promise<Joined | null> {
  const playlist = await getPlaylist(playlistId);
  if (!playlist) return null;

  const user: Listener = {
    socketId,
    username: username || `User-${socketId.substring(0, 4)}`,
    emoji: emoji || null,
    joinedAt: Date.now(),
    currentTrack: null  // { title, thumbnail } - what user is currently listening to
  };

  let users = playlistUsers.get(playlistId);
  if (!users) {
    users = new Map();
    playlistUsers.set(playlistId, users);
  }
  users.set(socketId, user);

  await updateLastActivity(playlistId);

  return { playlist: { ...playlist, users }, user };
}

async function leavePlaylist(playlistId: string, socketId: string): Promise<Listener | null | undefined> {
  const playlist = playlists.get(playlistId);
  if (!playlist) return null;

  const users = playlistUsers.get(playlistId);
  if (!users) return undefined;

  const user = users.get(socketId);
  if (user) {
    users.delete(socketId);
    await updateLastActivity(playlistId);
  }
  return user;
}

export function getPlaylistUsers(playlistId: string): Listener[] {
  const users = playlistUsers.get(playlistId);
  if (!users) return [];
  return Array.from(users.values());
}

export function updateUser(playlistId: string, socketId: string, updates: { username?: unknown; emoji?: string | null }): Listener | null {
  const users = playlistUsers.get(playlistId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  if (updates.username !== undefined) {
    const trimmed = String(updates.username).trim();
    if (trimmed && trimmed.length <= 30) {
      user.username = trimmed;
    }
  }
  if (updates.emoji !== undefined) {
    user.emoji = updates.emoji || null;
  }
  return user;
}

export function setUserCurrentTrack(playlistId: string, socketId: string, track: { title: string; thumbnail: string | null } | null): Listener | null {
  const users = playlistUsers.get(playlistId);
  if (!users) return null;

  const user = users.get(socketId);
  if (!user) return null;

  user.currentTrack = track ? { title: track.title, thumbnail: track.thumbnail } : null;
  return user;
}

// Names are unique among the playlists a user can see. `visibleTo(playlist)`
// limits the check so a clash never reveals someone else's private playlist.
export function isNameTaken(name: string | null | undefined, excludePlaylistId: string | null = null, visibleTo: ((p: Playlist) => boolean) | null = null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  for (const [id, l] of playlists) {
    if (excludePlaylistId && id === excludePlaylistId) continue;
    if (visibleTo && !visibleTo(l)) continue;
    if (l.name && l.name.toLowerCase().trim() === lower) return true;
  }
  return false;
}

/** renamePlaylist's answer (null: no such playlist). */
export type RenameResult = { error: string } | { playlist: Playlist; error?: undefined };

export async function renamePlaylist(playlistId: string, newName: unknown, visibleTo: ((p: Playlist) => boolean) | null = null): Promise<RenameResult | null> {
  const playlist = playlists.get(playlistId);
  if (!playlist) return null;

  const trimmed = newName ? String(newName).trim() : '';
  if (!trimmed) return { error: 'Name cannot be empty' };
  if (trimmed.length > 50) return { error: 'Name must be 50 characters or less' };
  if (isNameTaken(trimmed, playlistId, visibleTo)) return { error: 'A playlist with that name already exists' };

  playlist.name = trimmed;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE playlists SET name = $1 WHERE id = $2', [trimmed, playlistId]);
    } catch (err) {
      console.error('Failed to update lobby name in DB:', (err as Error).message);
    }
  }

  return { playlist };
}

export async function pinPlaylist(playlistId: string, pinned: boolean): Promise<{ playlist: Playlist } | null> {
  const playlist = playlists.get(playlistId);
  if (!playlist) return null;

  playlist.pinned = pinned;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE playlists SET pinned = $1 WHERE id = $2', [pinned, playlistId]);
    } catch (err) {
      console.error('Failed to update lobby pinned state:', (err as Error).message);
    }
  }

  return { playlist };
}

// Set a playlist's visibility ('public' | 'private'). Ownership is enforced
// by the caller (playlistAccess.canManage); this only persists the value.
export async function setVisibility(playlistId: string, visibility: unknown): Promise<{ playlist: Playlist | null; visibility: Visibility }> {
  const vis = normalizeVisibility(visibility);
  const playlist = playlists.get(playlistId);
  if (playlist) playlist.visibility = vis;

  if (db.isAvailable()) {
    try {
      await db.query('UPDATE playlists SET visibility = $1 WHERE id = $2', [vis, playlistId]);
    } catch (err) {
      console.error('Failed to update lobby visibility:', (err as Error).message);
    }
  }

  return { playlist: playlist || null, visibility: vis };
}

async function deletePlaylistAsync(id: string): Promise<boolean> {
  if (db.isAvailable()) {
    try {
      await db.query('DELETE FROM playlists WHERE id = $1', [id]);
    } catch (err) {
      console.error('Failed to delete lobby from DB:', (err as Error).message);
    }
  }

  playlistUsers.delete(id);
  return playlists.delete(id);
}

// Time-based playlist deletion was removed in hq-9gvy: idle playlists are NEVER
// deleted, in memory or in the DB. They persist until a creator (or admin)
// explicitly deletes them. This sweep now only reclaims orphaned queue state
// for playlist IDs that no longer exist in memory (e.g. lazily created by
// getQueue() for an already-deleted playlist) — it never removes a playlist itself.
export async function cleanupEmptyPlaylists(): Promise<void> {
  const validIds = new Set(playlists.keys());
  cleanupOrphanedQueues(validIds);
}

// Cleanup interval handle (only start in production)
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanup(): void {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupEmptyPlaylists, CLEANUP_INTERVAL);
  }
}

// Auto-start in production (not during tests)
if (process.env.NODE_ENV !== 'test') {
  startCleanup();
}

// Sync wrapper for backward compatibility with tests
function createPlaylistSync(
  ownerId: string | null = null, customId: string | null = null, name: string | null = null,
  visibility: unknown = 'public', ownerName: string | null = null,
): PlaylistWithUsers {
  const id = customId || generatePlaylistId();
  const now = Date.now();

  const users = new Map<string, Listener>();
  const playlist: PlaylistWithUsers = {
    id,
    ownerId: ownerId || null,
    ownerName: ownerName || null,
    name: name || null,
    visibility: ownerId ? normalizeVisibility(visibility) : 'public',
    pinned: false,
    createdAt: now,
    lastActivity: now,
    users
  };

  playlists.set(id, playlist);
  playlistUsers.set(id, users);

  return playlist;
}

function getPlaylistSync(id: unknown): PlaylistWithUsers | undefined {
  // Ids are strings; anything else is simply not found.
  const playlist = playlists.get(id as string);
  if (!playlist) return undefined;

  // Ensure users Map is attached
  if (!playlist.users) {
    playlist.users = playlistUsers.get(id as string) || new Map();
  }

  return playlist as PlaylistWithUsers;
}

function joinPlaylistSync(playlistId: string, socketId: string, username?: string | null, emoji?: string | null): Joined | null {
  const playlist = playlists.get(playlistId);
  if (!playlist) return null;

  const user: Listener = {
    socketId,
    username: username || `User-${socketId.substring(0, 4)}`,
    emoji: emoji || null,
    joinedAt: Date.now(),
    currentTrack: null  // { title, thumbnail } - what user is currently listening to
  };

  let users = playlistUsers.get(playlistId);
  if (!users) {
    users = new Map();
    playlistUsers.set(playlistId, users);
  }
  users.set(socketId, user);
  playlist.lastActivity = Date.now();

  return { playlist: { ...playlist, users }, user };
}

function leavePlaylistSync(playlistId: string, socketId: string): Listener | null | undefined {
  const playlist = playlists.get(playlistId);
  if (!playlist) return null;

  const users = playlistUsers.get(playlistId);
  if (!users) return undefined;

  const user = users.get(socketId);
  if (user) {
    users.delete(socketId);
    updateLastActivity(playlistId).catch(err =>
      console.error('Failed to persist last_activity on leave:', err.message)
    );
  }
  return user;
}

export async function loadPlaylistsFromDB(): Promise<void> {
  if (!db.isAvailable()) return;

  try {
    const result = await db.query<PlaylistRow>(
      `SELECT ${PLAYLIST_COLUMNS} FROM playlists ORDER BY last_activity DESC`
    );

    for (const row of result.rows) {
      if (!playlists.has(row.id)) {
        playlists.set(row.id, rowToPlaylist(row));
        if (!playlistUsers.has(row.id)) {
          playlistUsers.set(row.id, new Map());
        }
      }
    }

    console.log(`Loaded ${result.rows.length} lobbies from database`);
  } catch (err) {
    // Without them the server would answer every list with no playlists: the
    // boot stops instead (and is retried by whatever restarts it).
    console.error('Failed to load lobbies from DB:', (err as Error).message);
    throw err;
  }
}

export function getAllPlaylists(): PlaylistSummary[] {
  const result: PlaylistSummary[] = [];
  for (const [id, data] of playlists) {
    const users = playlistUsers.get(id);
    const userCount = users ? users.size : 0;
    result.push({
      id,
      name: data.name || null,
      ownerId: data.ownerId || null,
      ownerName: data.ownerName || null,
      visibility: normalizeVisibility(data.visibility),
      pinned: data.pinned || false,
      userCount,
      createdAt: data.createdAt,
      lastActivity: data.lastActivity
    });
  }
  return result;
}

function deletePlaylistSync(id: string): boolean {
  playlistUsers.delete(id);
  return playlists.delete(id);
}

/**
 * Forget every playlist and listener in memory, as a restart does (the
 * database keeps them). For tests: an ES module is not loaded afresh when it is
 * required again.
 */
export function forgetAll(): void {
  playlists.clear();
  playlistUsers.clear();
}

export {
  createPlaylistSync as createPlaylist,
  getPlaylistSync as getPlaylist,
  joinPlaylistSync as joinPlaylist,
  leavePlaylistSync as leavePlaylist,
  deletePlaylistSync as deletePlaylist,
  // Async versions for production use with database
  createPlaylist as createPlaylistAsync,
  getPlaylist as getPlaylistAsync,
  joinPlaylist as joinPlaylistAsync,
  leavePlaylist as leavePlaylistAsync,
  deletePlaylistAsync,
};
