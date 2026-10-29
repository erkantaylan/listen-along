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
      listening_mode VARCHAR(20) DEFAULT 'synchronized',
      is_public BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `;

  const createPlaybackStateTable = `
    CREATE TABLE IF NOT EXISTS playback_state (
      lobby_id VARCHAR(8) PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
      current_track JSONB,
      position REAL DEFAULT 0,
      is_playing BOOLEAN DEFAULT FALSE,
      started_at BIGINT,
      shuffle_enabled BOOLEAN DEFAULT FALSE,
      shuffled_indices JSONB DEFAULT '[]',
      shuffle_index INTEGER DEFAULT 0,
      repeat_mode VARCHAR(10) DEFAULT 'off'
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

  const createChatMessagesTable = `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY,
      lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      user_id VARCHAR(255) NOT NULL,
      username VARCHAR(255) NOT NULL,
      emoji VARCHAR(10),
      content TEXT NOT NULL,
      created_at BIGINT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_chat_messages_lobby ON chat_messages(lobby_id, created_at);
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
  await pool.query(createPlaybackStateTable);
  await pool.query(createQueueSongsTable);
  await pool.query(createSongsTable);
  await pool.query(createChatMessagesTable);
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

  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS listening_mode VARCHAR(20) DEFAULT 'synchronized'
  `).catch(() => {}); // Ignore if column already exists

  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS current_index INTEGER DEFAULT -1
  `).catch(() => {}); // Ignore if column already exists

  // Lobby visibility: public by default. Existing rows backfill to TRUE so no
  // lobby silently disappears on deploy.
  await pool.query(`
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE
  `).catch(() => {}); // Ignore if column already exists

  await pool.query(`
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS song_mention TEXT
  `).catch(() => {}); // Ignore if column already exists

  await pool.query(`
    ALTER TABLE playback_state ADD COLUMN IF NOT EXISTS shuffle_history JSONB DEFAULT '[]'
  `).catch(() => {}); // Ignore if column already exists

  // Users table migrations (OAuth support)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji VARCHAR(10)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT`).catch(() => {});
  await pool.query(`ALTER TABLE users ALTER COLUMN provider SET DEFAULT 'local'`).catch(() => {});
  await pool.query(`ALTER TABLE users ALTER COLUMN status SET DEFAULT 'approved'`).catch(() => {});
  // Approval gating removed — promote anyone still waiting (leave explicit 'denied' alone)
  await pool.query(`UPDATE users SET status = 'approved' WHERE status = 'pending'`).catch(() => {});
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
