// Domain types shared by more than one area. Type-only: nothing here exists at
// run time, so import it with `import type`.
//
// Row types are written from the SQL in db.js (CREATE TABLE plus the ALTER
// migrations after it), with node-postgres' default parsing: BIGINT and
// NUMERIC arrive as strings, REAL / INTEGER / SMALLINT as numbers,
// TIMESTAMPTZ as Date, JSONB parsed, and a nullable column as `| null`.
// Change them with the schema.
import type { Server, Socket } from 'socket.io';

/** The Socket.IO server (socketServer.js createSocketServer). */
export type Io = Server;
/** One Socket.IO connection. `socket.data.userId` is set by the handshake (socketServer.js). */
export type AppSocket = Socket;

/** What converted code uses of db.js (CommonJS until shared/ moves): the pool's query, or a client's in a transaction. */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}
export interface Db extends Queryable {
  /** false without DATABASE_URL, or before init() connected. */
  isAvailable(): boolean;
}

/** users.status: approved = everything, pending = chat / people / own profile, denied / rejected = nothing. */
export type AccountStatus = 'approved' | 'pending' | 'denied' | 'rejected';

/** A `users` row. */
export interface UserRow {
  id: string;
  user_id: string | null;
  username: string | null;
  emoji: string | null;
  provider: string;
  provider_id: string | null;
  email: string | null;
  name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** VARCHAR with these values (DEFAULT 'approved'). */
  status: AccountStatus | null;
  oidc_sub: string | null;
  /** BIGINT epoch ms */
  created_at: string;
  updated_at: string | null;
  last_seen: string | null;
}

/** A `library_songs` row (the music library). */
export interface LibrarySongRow {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
  file_path: string;
  mime_type: string;
  /** BIGINT */
  size_bytes: string | null;
  sha256: string;
  source_url: string | null;
  uploaded_by: string;
  uploaded_by_token: string | null;
  uploaded_by_user_id: string | null;
  uploaded_by_worker_id: string | null;
  uploaded_by_worker: string | null;
  upload_job_id: string | null;
  requested_by_user_id: string | null;
  requested_by: string | null;
  meta_key: string | null;
  meta_key_version: number | null;
  created_at: Date;
  replaced_at: Date | null;
}

export type Visibility = 'public' | 'private';

/**
 * A playlist as lobby.js keeps it in memory (rowToLobby / createLobby; table
 * `lobbies`, internally still "lobby"). playlistAccess.js decides who sees it.
 */
export interface Playlist {
  id: string;
  /** users.id of the owner (column host_id); null for legacy ownerless playlists */
  ownerId: string | null;
  ownerName: string | null;
  name: string | null;
  visibility: Visibility;
  /** the old shared pin (lobbies.pinned), not the per-user one */
  pinned: boolean;
  createdAt: number;
  lastActivity: number;
}

export type JobStatus = 'queued' | 'assigned' | 'done' | 'failed' | 'cancelled';

/** A `download_jobs` row. */
export interface JobRow {
  id: string;
  /** 'web' | 'request' | 'replace' */
  source: string;
  /** 'search' | 'video' | 'playlist' */
  kind: string;
  input: string;
  title: string | null;
  request_id: string | null;
  playlist_id: string | null;
  requested_by_user_id: string | null;
  requested_by: string | null;
  status: JobStatus;
  worker_id: string | null;
  worker_name: string | null;
  worker_owner: string | null;
  attempts: number;
  stage: string | null;
  progress: string | null;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  song_id: string | null;
  replace_song_id: string | null;
  replace_title: string | null;
  replace_artist: string | null;
  replace_album: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** A job as downloadJobs.getJob / listJobs return it: the row plus its joins (JOB_SELECT). */
export interface JobWithJoins extends JobRow {
  playlist_name: string | null;
  song_title: string | null;
  song_artist: string | null;
  replace_target_id: string | null;
}
