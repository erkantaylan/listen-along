/**
 * Song requests: a web user queued a song that is not in the library. The
 * server does not download it; the request waits until someone uploads it with
 * the CLI (matched by youtube_id or an explicit request_id), or an admin/CLI
 * dismisses it.
 */

import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';
import { isUuid } from '../../shared/ids.ts';
import type { LibrarySongRow } from '../../shared/types.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

export type RequestStatus = 'pending' | 'fulfilled' | 'dismissed';
export const STATUSES: string[] = ['pending', 'fulfilled', 'dismissed'];

/** A `song_requests` row (core/requests/schema.ts). */
export interface SongRequestRow {
  id: string;
  youtube_id: string | null;
  url: string | null;
  title: string | null;
  artist: string | null;
  requested_by: string;
  requested_by_id: string | null;
  /** the playlist it came from (no FK: the request outlives it) */
  playlist_id: string | null;
  status: RequestStatus;
  song_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A request as the API sends it. */
export interface SongRequest {
  id: string;
  youtube_id: string | null;
  url: string | null;
  title: string | null;
  artist: string | null;
  requested_by: string;
  playlist_id: string | null;
  status: RequestStatus;
  song_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPublic(row: SongRequestRow): SongRequest {
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    url: row.url || null,
    title: row.title || null,
    artist: row.artist || null,
    requested_by: row.requested_by,
    playlist_id: row.playlist_id || null,
    status: row.status,
    song_id: row.song_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function clean(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

/** What a new request is made of (createRequest). */
export interface NewRequest {
  youtubeId?: string | null;
  url?: string | null;
  title?: string | null;
  artist?: string | null;
  requestedBy?: string | null;
  requestedById?: string | null;
  /** the playlist it was queued in */
  playlistId?: string | null;
}

/**
 * Create a pending request, or return the existing pending one for the same
 * song in the same playlist (youtube_id, else url, else title).
 */
export async function createRequest({ youtubeId, url, title, artist, requestedBy, requestedById, playlistId }: NewRequest): Promise<{ request: SongRequest; created: boolean }> {
  const fields = {
    youtube_id: clean(youtubeId, 32),
    url: clean(url, 2000),
    title: clean(title, 300),
    artist: clean(artist, 300),
    requested_by: clean(requestedBy, 255) || 'anonymous',
    requested_by_id: clean(requestedById, 255),
    playlist_id: clean(playlistId, 8),
  };
  if (!fields.youtube_id && !fields.url && !fields.title) throw new Error('A request needs a youtube_id, url or title');

  let existing;
  if (fields.youtube_id) {
    existing = await db.query<SongRequestRow>(
      "SELECT * FROM song_requests WHERE status = 'pending' AND youtube_id = $1 AND playlist_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.youtube_id, fields.playlist_id]
    );
  } else if (fields.url) {
    existing = await db.query<SongRequestRow>(
      "SELECT * FROM song_requests WHERE status = 'pending' AND url = $1 AND playlist_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.url, fields.playlist_id]
    );
  } else {
    existing = await db.query<SongRequestRow>(
      "SELECT * FROM song_requests WHERE status = 'pending' AND youtube_id IS NULL AND url IS NULL AND lower(title) = lower($1) AND playlist_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.title, fields.playlist_id]
    );
  }
  if (existing.rows[0]) return { request: toPublic(existing.rows[0]), created: false };

  const r = await db.query<SongRequestRow>(
    `INSERT INTO song_requests (youtube_id, url, title, artist, requested_by, requested_by_id, playlist_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [fields.youtube_id, fields.url, fields.title, fields.artist, fields.requested_by, fields.requested_by_id, fields.playlist_id]
  );
  return { request: toPublic(r.rows[0]), created: true };
}

export async function listRequests({ status = 'pending', limit = 500 }: { status?: string; limit?: number } = {}): Promise<SongRequest[]> {
  const params: unknown[] = [];
  let where = '';
  if (status !== 'all') {
    params.push(status);
    where = 'WHERE status = $1';
  }
  params.push(limit);
  const order = status === 'pending' ? 'created_at ASC' : 'updated_at DESC';
  const r = await db.query<SongRequestRow>(`SELECT * FROM song_requests ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
  return r.rows.map(toPublic);
}

export async function getRequest(id: unknown): Promise<SongRequest | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<SongRequestRow>('SELECT * FROM song_requests WHERE id = $1', [id]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/** Mark a request dismissed (e.g. the CLI could not find it). Returns null if missing. */
export async function dismissRequest(id: unknown): Promise<SongRequest | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<SongRequestRow>(
    "UPDATE song_requests SET status = 'dismissed', updated_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/**
 * Mark pending requests fulfilled by a library song: all pending requests
 * for the song's youtube_id, plus the explicit requestId if given (which may
 * have had no youtube_id, e.g. a text-only request).
 * @returns the requests that were fulfilled now
 */
export async function fulfillRequests(
  song: Pick<LibrarySongRow, 'id' | 'youtube_id'>, requestId: string | null = null, extraYoutubeId: string | null = null,
): Promise<SongRequest[]> {
  // extraYoutubeId: the youtube_id the uploader claimed, which can differ from
  // the stored song's when an upload is a byte-identical duplicate (409).
  const ytIds = [...new Set([song.youtube_id, extraYoutubeId].filter(Boolean))];
  const r = await db.query<SongRequestRow>(
    `UPDATE song_requests SET status = 'fulfilled', song_id = $1, updated_at = now()
     WHERE status = 'pending'
       AND (youtube_id = ANY($2::text[]) OR id = $3)
     RETURNING *`,
    [song.id, ytIds, isUuid(requestId) ? requestId : null]
  );
  return r.rows.map(toPublic);
}
