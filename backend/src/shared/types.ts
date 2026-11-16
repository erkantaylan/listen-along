// Domain types shared by more than one area. Type-only: nothing here exists at
// run time, so import it with `import type`.
//
// Row types are written from the SQL in each area's schema.ts (CREATE TABLE
// plus the ALTER migrations after it), with node-postgres' default parsing: BIGINT and
// NUMERIC arrive as strings, REAL / INTEGER / SMALLINT as numbers,
// TIMESTAMPTZ as Date, JSONB parsed, and a nullable column as `| null`.
// Change them with the schema.
import type { DefaultEventsMap, Server, Socket } from 'socket.io';

/** What the server keeps on a connection (`socket.data`). Never anything the client sent. */
export interface SocketData {
  /** users.id of the account, from the handshake (app/sockets.ts); absent for an anonymous socket */
  userId?: string;
  /** the central-login session's hash (app/sockets.ts) */
  sessionId?: string;
  /** set by social once the account may use chat and the people panel */
  social?: boolean;
  /** resolves when social's per-connection setup is done: true when the account may use it */
  socialReady?: Promise<boolean>;
  /** core/playlists/playlistSockets.ts: leaves a playlist that went private */
  evict?: (playlistId: string) => void;
}

/** The Socket.IO server (app/sockets.ts createSocketServer). Event names and payloads are not typed (yet). */
export type Io = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
/** One Socket.IO connection. */
export type AppSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/** The database's shapes live with it (db.ts); re-exported here for the areas that import them from this file. */
export type { QueryResult, Queryable, Db } from './db.ts';

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
  /** ms of silence at the very start / end (core/library/silence.ts); null = not measured yet */
  lead_silence_ms: number | null;
  trail_silence_ms: number | null;
}

export type Visibility = 'public' | 'private';

/**
 * A playlist as core/playlists/playlist.ts keeps it in memory (rowToPlaylist / createPlaylist; table
 * `playlists`). core/playlists/playlistAccess.ts decides who sees it.
 */
export interface Playlist {
  id: string;
  /** users.id of the owner (column host_id); null for legacy ownerless playlists */
  ownerId: string | null;
  ownerName: string | null;
  name: string | null;
  visibility: Visibility;
  /** the old shared pin (playlists.pinned), not the per-user one */
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
