// Song requests (requests.ts). Run by shared/db.ts, in the order of its SCHEMA
// list.
import type { Migration } from '../../shared/db.ts';

export const tables: readonly string[] = [
  // Song requests: a web user queued something that is not in the library.
  // lobby_id has no FK on purpose — the request outlives a deleted lobby.
  `
    CREATE TABLE IF NOT EXISTS song_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      youtube_id VARCHAR(32),
      url TEXT,
      title TEXT,
      artist TEXT,
      requested_by VARCHAR(255) NOT NULL DEFAULT 'anonymous',
      requested_by_id VARCHAR(255),
      lobby_id VARCHAR(8),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      song_id UUID REFERENCES library_songs(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
];

export const migrations: readonly Migration[] = [
  `CREATE INDEX IF NOT EXISTS idx_song_requests_requester ON song_requests(requested_by_id)`,
  { sql: `CREATE INDEX IF NOT EXISTS idx_song_requests_status ON song_requests(status, created_at);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_song_requests_youtube ON song_requests(youtube_id);`, mustSucceed: true },
];
