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

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_queue_songs_lobby ON queue_songs(lobby_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_lobbies_last_activity ON lobbies(last_activity);
    CREATE INDEX IF NOT EXISTS idx_songs_url ON songs(url);
    CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);
  `;

  await pool.query(createLobbiesTable);
  await pool.query(createPlaybackStateTable);
  await pool.query(createQueueSongsTable);
  await pool.query(createSongsTable);
  await pool.query(createIndexes);

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
 * Clean up expired lobbies (24 hours from last activity)
 */
async function cleanupExpiredLobbies() {
  if (!pool) return 0;

  const expiryTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours

  const result = await pool.query(
    'DELETE FROM lobbies WHERE last_activity < $1 RETURNING id',
    [expiryTime]
  );

  return result.rowCount;
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

module.exports = {
  init,
  isAvailable,
  query,
  getClient,
  cleanupExpiredLobbies,
  close
};
