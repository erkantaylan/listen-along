// The music library: songs, their replace / edit history, broken-song reports,
// and the legacy yt-dlp cache table. Run by shared/db.ts, in the order of its
// SCHEMA list. Only the schema lives here so far; library.js, songReports.js
// and the rest move into this folder with the core.
import type { Migration } from '../../shared/db.ts';

export const tables: readonly string[] = [
  // The legacy yt-dlp cache (library.migrateLegacyCache registers it into the library).
  `
    CREATE TABLE IF NOT EXISTS songs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url TEXT NOT NULL UNIQUE,
      title TEXT DEFAULT 'Unknown',
      duration REAL DEFAULT 0,
      file_path TEXT,
      thumbnail_url TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `,
  // Music library (songs uploaded by the CLI, plus the migrated legacy cache).
  // Own UUID id; youtube_id is optional but unique when set (NULLs never clash).
  `
    CREATE TABLE IF NOT EXISTS library_songs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      youtube_id VARCHAR(32) UNIQUE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_sec REAL,
      file_path TEXT NOT NULL,
      mime_type VARCHAR(64) NOT NULL DEFAULT 'audio/mp4',
      size_bytes BIGINT,
      sha256 CHAR(64) NOT NULL UNIQUE,
      source_url TEXT,
      uploaded_by VARCHAR(255) NOT NULL,
      uploaded_by_token UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  // Audit trail of "replace the audio of a library song" (library.replaceSong).
  // No FK on song_id: the history outlives a deleted song.
  `
    CREATE TABLE IF NOT EXISTS library_song_replacements (
      id BIGSERIAL PRIMARY KEY,
      song_id UUID NOT NULL,
      replaced_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      replaced_by VARCHAR(255),
      replaced_by_token UUID,
      old_youtube_id VARCHAR(32),
      old_source_url TEXT,
      old_sha256 CHAR(64),
      old_title TEXT,
      old_artist TEXT,
      old_album TEXT,
      old_duration_sec REAL,
      new_youtube_id VARCHAR(32),
      new_source_url TEXT,
      new_sha256 CHAR(64),
      new_title TEXT,
      new_artist TEXT,
      new_album TEXT,
      new_duration_sec REAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  // "Mark as broken — needs replacement" reports (songReports.js). One OPEN
  // report per user per song (partial unique index); re-marking updates the
  // reason. A report is resolved when the song's audio is replaced
  // (resolution 'replaced', in library.replaceSong's transaction) or an admin
  // dismisses it ('dismissed'). Deleting the song deletes its reports.
  `
    CREATE TABLE IF NOT EXISTS library_song_reports (
      id BIGSERIAL PRIMARY KEY,
      song_id UUID NOT NULL REFERENCES library_songs(id) ON DELETE CASCADE,
      reported_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      reported_by VARCHAR(255),
      reason VARCHAR(200),
      auto BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_by VARCHAR(255),
      resolution VARCHAR(20)
    )
  `,
];

export const migrations: readonly Migration[] = [
  // Migration: source_url (the original link, e.g. the YouTube watch URL).
  // Must run before idx_library_songs_source_url, which indexes this column.
  `
    ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS source_url TEXT
  `,
  // Backfill: songs with a YouTube id but no source link get the watch URL.
  `
    UPDATE library_songs SET source_url = 'https://www.youtube.com/watch?v=' || youtube_id
    WHERE source_url IS NULL AND youtube_id IS NOT NULL
  `,
  // Migration: which account uploaded a library song (the token's owner;
  // NULL for legacy tokens and the migrated cache). uploaded_by keeps the
  // display name snapshot the UI shows.
  `
    ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
  `,
  // Migration: duplicate detection. meta_key = normalized "artist|title"
  // (songMatch.js), meta_key_version = the normalization it was computed
  // with; library.backfillMetaKeys() fills / refreshes them in the
  // background after boot. sha256 (file bytes) already exists, NOT NULL UNIQUE.
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS meta_key TEXT`,
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS meta_key_version SMALLINT`,
  `CREATE INDEX IF NOT EXISTS idx_library_songs_meta_key ON library_songs(meta_key)`,
  // When a song's audio was last replaced (NULL = never); also busts caches.
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ`,

  `CREATE INDEX IF NOT EXISTS idx_song_replacements_song ON library_song_replacements(song_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_song_replacements_old_yt ON library_song_replacements(old_youtube_id)`,
  // Migration: kind 'audio' (a replace) or 'details' (title / artist / album
  // only, sha unchanged), and for a replace job what ran it and who asked.
  `ALTER TABLE library_song_replacements ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'audio'`,
  `ALTER TABLE library_song_replacements ADD COLUMN IF NOT EXISTS job_id UUID`,
  `ALTER TABLE library_song_replacements ADD COLUMN IF NOT EXISTS worker_name VARCHAR(100)`,
  `ALTER TABLE library_song_replacements ADD COLUMN IF NOT EXISTS requested_by VARCHAR(255)`,

  `ALTER TABLE library_song_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `ALTER TABLE library_song_reports ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255)`,
  // auto: filed by the web player when the song failed to play (songReports.js), not by a person.
  `ALTER TABLE library_song_reports ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false`,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_song_reports_open_user
      ON library_song_reports(song_id, reported_by_user_id) WHERE resolved_at IS NULL
  `,
  `CREATE INDEX IF NOT EXISTS idx_song_reports_open ON library_song_reports(song_id) WHERE resolved_at IS NULL`,

  // Migration: upload records. Which worker uploaded a song (and its name
  // as a snapshot, shown as "uploaded by <worker> (<owner>)"), the job it
  // ran, and who asked for it (job requester or song request).
  // download_workers is core/jobs' table: every area's tables exist before
  // any migration runs.
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_worker_id UUID REFERENCES download_workers(id) ON DELETE SET NULL`,
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_worker VARCHAR(100)`,
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS upload_job_id UUID`,
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS requested_by VARCHAR(255)`,
  `CREATE INDEX IF NOT EXISTS idx_library_songs_uploader ON library_songs(uploaded_by_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_library_songs_worker ON library_songs(uploaded_by_worker_id)`,
  `CREATE INDEX IF NOT EXISTS idx_library_songs_requester ON library_songs(requested_by_user_id)`,

  { sql: `CREATE INDEX IF NOT EXISTS idx_songs_url ON songs(url);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_library_songs_created ON library_songs(created_at DESC);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_library_songs_source_url ON library_songs(source_url);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_library_songs_file_path ON library_songs(file_path);`, mustSucceed: true },
];
