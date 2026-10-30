/**
 * PostgreSQL database module for lobby persistence
 */

const { Pool } = require('pg');

// Connection pool
let pool = null;

/**
 * Initialize database connection and create tables
 */
async function init() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log('DATABASE_URL not set, using in-memory storage');
    return false;
  }

  try {
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Log (don't crash on) errors from idle pooled connections. pg emits 'error'
    // on the pool when an idle backend dies (Postgres restart / proxy idle-kill);
    // with no listener Node would throw it and take down the process.
    pool.on('error', (err) => console.error('[pg pool] idle client error', err));

    // Test connection
    await pool.query('SELECT NOW()');
    console.log('Connected to PostgreSQL');

    // Create tables
    await createTables();

    return true;
  } catch (err) {
    console.error('Failed to connect to PostgreSQL:', err.message);
    pool = null;
    return false;
  }
}

/**
 * Create database tables if they don't exist
 */
async function createTables() {
  const createLobbiesTable = `
    CREATE TABLE IF NOT EXISTS lobbies (
      id VARCHAR(8) PRIMARY KEY,
      host_id VARCHAR(255),
      name VARCHAR(50),
      visibility VARCHAR(10) NOT NULL DEFAULT 'public',
      created_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `;

  const createQueueSongsTable = `
    CREATE TABLE IF NOT EXISTS queue_songs (
      id UUID PRIMARY KEY,
      lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT DEFAULT 'Unknown',
      duration REAL DEFAULT 0,
      added_by VARCHAR(255) DEFAULT 'anonymous',
      thumbnail TEXT,
      added_at BIGINT NOT NULL,
      sort_order INTEGER NOT NULL
    )
  `;

  const createSongsTable = `
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
  `;

  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(255),
      username VARCHAR(255),
      emoji VARCHAR(10),
      provider VARCHAR(20) NOT NULL DEFAULT 'local',
      provider_id VARCHAR(255),
      email VARCHAR(255),
      name VARCHAR(255),
      avatar_url TEXT,
      status VARCHAR(20) DEFAULT 'approved',
      created_at BIGINT NOT NULL,
      updated_at BIGINT,
      last_seen BIGINT,
      UNIQUE NULLS NOT DISTINCT(provider, provider_id)
    )
  `;

  const createUserProvidersTable = `
    CREATE TABLE IF NOT EXISTS user_providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      name VARCHAR(255),
      avatar_url TEXT,
      linked_at BIGINT NOT NULL,
      UNIQUE(provider, provider_id)
    )
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_queue_songs_lobby ON queue_songs(lobby_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_lobbies_last_activity ON lobbies(last_activity);
    CREATE INDEX IF NOT EXISTS idx_songs_url ON songs(url);
    CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);
    CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE INDEX IF NOT EXISTS idx_user_providers_user ON user_providers(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_providers_provider ON user_providers(provider, provider_id);
    CREATE INDEX IF NOT EXISTS idx_library_songs_created ON library_songs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_library_songs_source_url ON library_songs(source_url);
    CREATE INDEX IF NOT EXISTS idx_library_songs_file_path ON library_songs(file_path);
    CREATE INDEX IF NOT EXISTS idx_song_requests_status ON song_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_song_requests_youtube ON song_requests(youtube_id);
  `;

  await pool.query(createLobbiesTable);
  await pool.query(createQueueSongsTable);
  await pool.query(createSongsTable);
  await pool.query(createUsersTable);
  await pool.query(createUserProvidersTable);

  // Music library (songs uploaded by the CLI, plus the migrated legacy cache).
  // Own UUID id; youtube_id is optional but unique when set (NULLs never clash).
  await pool.query(`
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
  `);
  // Migration: source_url (the original link, e.g. the YouTube watch URL).
  // Must run before createIndexes, which indexes this column.
  await pool.query(`
    ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS source_url TEXT
  `).catch(() => {});
  // Backfill: songs with a YouTube id but no source link get the watch URL.
  await pool.query(`
    UPDATE library_songs SET source_url = 'https://www.youtube.com/watch?v=' || youtube_id
    WHERE source_url IS NULL AND youtube_id IS NOT NULL
  `).catch(() => {});

  // CLI upload tokens. Only the SHA-256 of the token is stored.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      token_prefix VARCHAR(16),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `);
  // Migration: tokens belong to a user account (created from the profile
  // page). Tokens made before this keep user_id NULL ("legacy, no owner") and
  // keep working. Deleting the account deletes its tokens.
  await pool.query(`
    ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`).catch(() => {});
  // Migration: which account uploaded a library song (the token's owner;
  // NULL for legacy tokens and the migrated cache). uploaded_by keeps the
  // display name snapshot the UI shows.
  await pool.query(`
    ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
  `).catch(() => {});
  // Migration: duplicate detection. meta_key = normalized "artist|title"
  // (songMatch.js), meta_key_version = the normalization it was computed
  // with; library.backfillMetaKeys() fills / refreshes them in the
  // background after boot. sha256 (file bytes) already exists, NOT NULL UNIQUE.
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS meta_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS meta_key_version SMALLINT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_songs_meta_key ON library_songs(meta_key)`).catch(() => {});
  // When a song's audio was last replaced (NULL = never); also busts caches.
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ`).catch(() => {});

  // Audit trail of "replace the audio of a library song" (library.replaceSong).
  // No FK on song_id: the history outlives a deleted song.
  await pool.query(`
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
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_song_replacements_song ON library_song_replacements(song_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_song_replacements_old_yt ON library_song_replacements(old_youtube_id)`).catch(() => {});

  // "Mark as broken — needs replacement" reports (songReports.js). One OPEN
  // report per user per song (partial unique index); re-marking updates the
  // reason. A report is resolved when the song's audio is replaced
  // (resolution 'replaced', in library.replaceSong's transaction) or an admin
  // dismisses it ('dismissed'). Deleting the song deletes its reports.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_song_reports (
      id BIGSERIAL PRIMARY KEY,
      song_id UUID NOT NULL REFERENCES library_songs(id) ON DELETE CASCADE,
      reported_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      reported_by VARCHAR(255),
      reason VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_by VARCHAR(255),
      resolution VARCHAR(20)
    )
  `);
  await pool.query(`ALTER TABLE library_song_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`).catch(() => {});
  await pool.query(`ALTER TABLE library_song_reports ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255)`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_song_reports_open_user
      ON library_song_reports(song_id, reported_by_user_id) WHERE resolved_at IS NULL
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_song_reports_open ON library_song_reports(song_id) WHERE resolved_at IS NULL`).catch(() => {});

  // Song requests: a web user queued something that is not in the library.
  // lobby_id has no FK on purpose — the request outlives a deleted lobby.
  await pool.query(`
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
  `);

  // Downloaders ("workers"): `la worker` processes on users' own machines
  // that connect out to the server and run download jobs (workerHub.js).
  // One row per (owner, name); a legacy ownerless token keys on token_id.
  // hostname / platform / os_release / last_ip are admin-only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS download_workers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token_id UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
      owner_name VARCHAR(255),
      name VARCHAR(100) NOT NULL,
      hostname VARCHAR(255),
      platform VARCHAR(32),
      arch VARCHAR(32),
      os_release VARCHAR(128),
      cli_version VARCHAR(32),
      ytdlp_version VARCHAR(64),
      node_version VARCHAR(32),
      last_ip VARCHAR(64),
      jobs_done INTEGER NOT NULL DEFAULT 0,
      jobs_failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_connected_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_download_workers_user ON download_workers(user_id)`).catch(() => {});

  // Download jobs: a song request (automatic) or the web "Download" box.
  // Routed to a connected worker (workerHub.js); survive restarts (an
  // 'assigned' job whose worker is gone goes back to 'queued').
  // status: queued | assigned | done | failed | cancelled.
  // request_id / playlist_id / song_id have no FKs that cascade: the job
  // history outlives a deleted request, playlist or song.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS download_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source VARCHAR(16) NOT NULL DEFAULT 'web',
      kind VARCHAR(16) NOT NULL DEFAULT 'search',
      input TEXT NOT NULL,
      title TEXT,
      request_id UUID,
      playlist_id VARCHAR(8),
      requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      requested_by VARCHAR(255),
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      worker_id UUID REFERENCES download_workers(id) ON DELETE SET NULL,
      worker_name VARCHAR(100),
      worker_owner VARCHAR(255),
      attempts INTEGER NOT NULL DEFAULT 0,
      stage VARCHAR(32),
      progress TEXT,
      result JSONB,
      error_code VARCHAR(64),
      error_message TEXT,
      song_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status, created_at)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_download_jobs_requester ON download_jobs(requested_by_user_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_download_jobs_request ON download_jobs(request_id)`).catch(() => {});

  // Migration: upload records. Which worker uploaded a song (and its name
  // as a snapshot, shown as "uploaded by <worker> (<owner>)"), the job it
  // ran, and who asked for it (job requester or song request).
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_worker_id UUID REFERENCES download_workers(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS uploaded_by_worker VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS upload_job_id UUID`).catch(() => {});
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE library_songs ADD COLUMN IF NOT EXISTS requested_by VARCHAR(255)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_songs_uploader ON library_songs(uploaded_by_user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_songs_worker ON library_songs(uploaded_by_worker_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_songs_requester ON library_songs(requested_by_user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_song_requests_requester ON song_requests(requested_by_id)`).catch(() => {});

  // The personal-playlist feature was removed; drop its tables so existing
  // deployments are cleaned up (CASCADE also clears playlist_songs).
  await pool.query(`DROP TABLE IF EXISTS playlist_songs, playlists CASCADE`).catch(() => {});

  await pool.query(createIndexes);

  // Migrations for existing databases
  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS name VARCHAR(50)
  `).catch(() => {}); // Ignore if column already exists or DB doesn't support IF NOT EXISTS

  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE
  `).catch(() => {}); // Ignore if column already exists

  // "Jam" (synchronized) lobbies were removed: every lobby is a shared queue
  // each listener plays at their own pace. Drop the per-lobby mode, the shared
  // queue cursor and the server-side playback state so existing deployments
  // load every lobby (including former Jam ones) the same way.
  await pool.query(`ALTER TABLE lobbies DROP COLUMN IF EXISTS listening_mode`).catch(() => {});
  await pool.query(`ALTER TABLE lobbies DROP COLUMN IF EXISTS current_index`).catch(() => {});
  await pool.query(`DROP TABLE IF EXISTS playback_state`).catch(() => {});

  // Playlists (lobbies) are 'public' or 'private' (owner only). Replaces the
  // earlier is_public flag: a lobby that was already private AND has an owner
  // stays private, everything else (including ownerless rows, which can never
  // be private) becomes public. Idempotent: the backfill only runs while the
  // old column still exists, and drops it afterwards.
  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'public'
  `).catch(() => {});
  const legacyVisibility = await pool.query(`
    SELECT 1 FROM information_schema.columns WHERE table_name = 'lobbies' AND column_name = 'is_public'
  `).catch(() => ({ rows: [] }));
  if (legacyVisibility.rows.length > 0) {
    await pool.query(`
      UPDATE lobbies SET visibility = 'private' WHERE is_public = FALSE AND host_id IS NOT NULL
    `);
    await pool.query(`ALTER TABLE lobbies DROP COLUMN IF EXISTS is_public`);
  }

  // Per-playlist chat was removed (a global chat replaces it); drop its table
  // and history on existing deployments.
  await pool.query(`DROP TABLE IF EXISTS chat_messages`).catch(() => {});

  // Users table migrations (OAuth support)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji VARCHAR(10)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT`).catch(() => {});
  await pool.query(`ALTER TABLE users ALTER COLUMN provider SET DEFAULT 'local'`).catch(() => {});
  await pool.query(`ALTER TABLE users ALTER COLUMN status SET DEFAULT 'approved'`).catch(() => {});
  // Never touch existing accounts' status here: this runs on every boot, and
  // an admin's pending / denied / rejected decision must survive a restart.
  // (An old "promote every pending user" line did exactly that.)
  // Drop old last_login NOT NULL constraint (replaced by updated_at). Guarded so
  // it only runs when the column exists — otherwise Postgres logs a (caught but
  // noisy) ERROR on every boot for newer schemas that have no last_login column.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'last_login'
      ) THEN
        ALTER TABLE users ALTER COLUMN last_login DROP NOT NULL;
      END IF;
    END $$;
  `).catch(() => {});

  // Profile feature: add display_name column for user-chosen name
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`).catch(() => {});

  // People panel: when the user was last online (ms). Set when they connect
  // and when their last socket goes away (social.js / presence.js).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen BIGINT`).catch(() => {});

  // The one global chat (social.js / chat.js). Kept forever; read newest
  // first with keyset pagination on id. Deliberately NOT named chat_messages:
  // that was the old per-playlist chat table, which is dropped above on every
  // boot. author_name is a snapshot used when the user row is gone.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS global_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      author_name VARCHAR(255),
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  // Migrate existing users' provider data into user_providers junction table
  await pool.query(`
    INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
    SELECT id, provider, provider_id, email, name, avatar_url, COALESCE(created_at, $1)
    FROM users
    WHERE provider IS NOT NULL AND provider != 'local'
      AND provider_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_providers up WHERE up.user_id = users.id AND up.provider = users.provider
      )
  `, [Date.now()]).catch(() => {});

  console.log('Database tables initialized');
}

/**
 * Check if database is available
 */
function isAvailable() {
  return pool !== null;
}

/**
 * Execute a query
 */
async function query(text, params) {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool.query(text, params);
}

/**
 * Get a client from the pool for transactions
 */
async function getClient() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool.connect();
}

/**
 * Time-based lobby expiry has been removed (hq-9gvy). Lobbies persist until a
 * creator (or admin) explicitly deletes them — idleness alone never deletes a
 * lobby. This no-op remains only so any stale caller does not crash; it never
 * deletes rows.
 */
async function cleanupExpiredLobbies() {
  return 0;
}

/**
 * Close database connection
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Get the connection pool (for session store, etc.)
 */
function getPool() {
  return pool;
}

module.exports = {
  init,
  isAvailable,
  query,
  getClient,
  getPool,
  cleanupExpiredLobbies,
  close
};
