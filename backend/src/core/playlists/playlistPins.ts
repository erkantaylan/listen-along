/**
 * Per-user playlist pins (the sidebar's "Pinned" group): Postgres
 * `playlist_pins` (see core/playlists/schema.ts), or memory when there is no database.
 *
 * A pin belongs to one user and is never visible to anyone else. It says
 * nothing about access: callers check playlistAccess first, and the list view
 * only annotates playlists the viewer can already see, so a pin on a playlist
 * that went private stays hidden (it comes back if the playlist goes public
 * again). Not to be confused with the older shared `lobbies.pinned` flag.
 */
import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

const memory = new Map<string, Map<string, number>>(); // userId -> Map(playlistId -> pinnedAt ms)

export class PlaylistGoneError extends Error {}

// playlistId -> pinnedAt (ms) for one user. Lookup failures read as "no pins": the
// playlist list must still load.
export async function pinsForUser(userId: string | null | undefined): Promise<Map<string, number>> {
  if (!userId) return new Map();
  if (!db.isAvailable()) return new Map(memory.get(userId) || []);
  try {
    const r = await db.query<{ lobby_id: string; pinned_at: string }>('SELECT lobby_id, pinned_at FROM playlist_pins WHERE user_id = $1', [userId]);
    return new Map(r.rows.map(row => [row.lobby_id, Number(row.pinned_at)]));
  } catch (err) {
    console.error('Failed to load playlist pins:', (err as Error).message);
    return new Map();
  }
}

// Idempotent: pinning again keeps the original time. Returns pinnedAt.
export async function pin(userId: string, playlistId: string): Promise<number> {
  const now = Date.now();
  if (!db.isAvailable()) {
    if (!memory.has(userId)) memory.set(userId, new Map());
    const mine = memory.get(userId)!;
    if (!mine.has(playlistId)) mine.set(playlistId, now);
    return mine.get(playlistId)!;
  }
  try {
    await db.query(
      'INSERT INTO playlist_pins (user_id, lobby_id, pinned_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, lobby_id) DO NOTHING',
      [userId, playlistId, now]
    );
  } catch (err) {
    // Foreign key: the playlist was deleted between the access check and here.
    if ((err as { code?: string }).code === '23503') throw new PlaylistGoneError('Playlist not found');
    throw err;
  }
  return (await pinsForUser(userId)).get(playlistId) || now;
}

export async function unpin(userId: string, playlistId: string): Promise<void> {
  if (!db.isAvailable()) {
    const mine = memory.get(userId);
    if (mine) mine.delete(playlistId);
    return;
  }
  await db.query('DELETE FROM playlist_pins WHERE user_id = $1 AND lobby_id = $2', [userId, playlistId]);
}

// A deleted playlist: the foreign key cascades in Postgres, memory needs this.
export function forgetPlaylist(playlistId: string): void {
  for (const mine of memory.values()) mine.delete(playlistId);
}
