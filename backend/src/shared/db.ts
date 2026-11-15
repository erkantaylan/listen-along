/**
 * PostgreSQL: the pool, the query helpers, and the one schema runner.
 *
 * Without DATABASE_URL there is no pool (isAvailable() false) and every store
 * keeps its data in memory. With it, init() connects, then creates and
 * migrates the schema; if that fails the pool is dropped again, and stores that
 * must not fall back to memory (sign-in, sessions, settings: `dbExpected`)
 * fail closed instead.
 *
 * The schema lives with the area that owns it, as a `schema.ts` exporting
 * `{ tables, migrations }` (SCHEMA below). init() runs every area's tables, then
 * every area's migrations, in the order of that list. Rules (CLAUDE.md,
 * "Database Migrations"):
 * - `tables`: CREATE TABLE IF NOT EXISTS only, in foreign-key order. Each must
 *   succeed.
 * - `migrations`: everything else, in the order it must run: every column
 *   added after its table first shipped (ALTER TABLE … ADD COLUMN IF NOT
 *   EXISTS, also written into the CREATE), indexes, backfills, drops. Append,
 *   never reorder: an ALTER's position decides where the column lands.
 * - Never rewrite users' statuses here (this runs on every boot), and never
 *   name a table chat_messages (features/social drops that one every boot).
 *
 * The module object (the default export, and what require() returns) is the
 * live one: tests replace its functions, so call them as `db.query(...)`.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import * as sharedSchema from './schema.ts';
import * as authSchema from '../auth/schema.ts';
import * as playlistsSchema from '../core/playlists/schema.ts';
import * as queueSchema from '../core/queue/schema.ts';
import * as librarySchema from '../core/library/schema.ts';
import * as requestsSchema from '../core/requests/schema.ts';
import * as jobsSchema from '../core/jobs/schema.ts';
import * as socialSchema from '../features/social/schema.ts';

/** What a query answers (the parts of pg's result the code uses). */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

/** Anything that runs a query: the pool (db.query) or a client in a transaction. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** What stores use of this module. */
export interface Db extends Queryable {
  /** false without DATABASE_URL, or before init() connected. */
  isAvailable(): boolean;
}

/**
 * One step after the tables:
 * - a string: its error is ignored (the column / index already exists, or an
 *   older Postgres), as every `.catch(() => {})` migration always was;
 * - `{ sql, mustSucceed: true }`: a failure stops init() (no database);
 * - a function: a conditional backfill, one with parameters, or its own error
 *   handling.
 */
export type Migration =
  | string
  | { sql: string; mustSucceed: true }
  | ((db: Queryable) => Promise<unknown>);

/** An area's schema.ts. */
export interface AreaSchema {
  /** CREATE TABLE IF NOT EXISTS statements; each must succeed. */
  tables: readonly string[];
  migrations: readonly Migration[];
}

/**
 * Every area's schema, in foreign-key order: a table comes after the tables
 * it references. Tables of all areas run first, then the migrations of all
 * areas, both in this order.
 */
export const SCHEMA: ReadonlyArray<{ area: string; schema: AreaSchema }> = [
  { area: 'shared', schema: sharedSchema },
  { area: 'auth', schema: authSchema },
  { area: 'core/playlists', schema: playlistsSchema },
  { area: 'core/queue', schema: queueSchema },
  { area: 'core/library', schema: librarySchema },
  { area: 'core/requests', schema: requestsSchema },
  { area: 'core/jobs', schema: jobsSchema },
  { area: 'features/social', schema: socialSchema },
];

// Connection pool
let pool: Pool | null = null;

/**
 * Initialize database connection and create tables
 */
async function init(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log('DATABASE_URL not set, using in-memory storage');
    return false;
  }

  try {
    pool = new pg.Pool({
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
    console.error('Failed to connect to PostgreSQL:', (err as Error).message);
    pool = null;
    return false;
  }
}

/**
 * Create the tables if they don't exist, then run the migrations (SCHEMA).
 */
async function createTables(): Promise<void> {
  const q: Queryable = { query };

  for (const { schema } of SCHEMA) {
    for (const sql of schema.tables) await q.query(sql);
  }
  for (const { schema } of SCHEMA) {
    for (const step of schema.migrations) await runMigration(q, step);
  }

  console.log('Database tables initialized');
}

async function runMigration(q: Queryable, step: Migration): Promise<void> {
  if (typeof step === 'string') {
    await q.query(step).catch(() => {});
  } else if (typeof step === 'function') {
    await step(q);
  } else {
    await q.query(step.sql);
  }
}

/**
 * Check if database is available
 */
function isAvailable(): boolean {
  return pool !== null;
}

/**
 * Execute a query
 */
async function query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  // The rows are what the SQL selects: R is the caller's word for it (pg's
  // own result type has `any` rows).
  const result = await pool.query(text, params);
  return result;
}

/**
 * Get a client from the pool for transactions
 */
async function getClient(): Promise<PoolClient> {
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
async function cleanupExpiredLobbies(): Promise<number> {
  return 0;
}

/**
 * Close database connection
 */
async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Get the connection pool (for session store, etc.)
 */
function getPool(): Pool | null {
  return pool;
}

/** The module's functions; tests replace them on this object. */
export interface DbModule extends Db {
  init(): Promise<boolean>;
  getClient(): Promise<PoolClient>;
  getPool(): Pool | null;
  cleanupExpiredLobbies(): Promise<number>;
  close(): Promise<void>;
}

const db: DbModule = {
  init,
  isAvailable,
  query,
  getClient,
  getPool,
  cleanupExpiredLobbies,
  close
};

export default db;
// require('./shared/db.ts') from CommonJS returns this same object, not a
// module namespace (whose properties tests could not replace).
export { db as 'module.exports' };
