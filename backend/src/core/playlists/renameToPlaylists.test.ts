// The lobby -> playlist rename in place (core/playlists/schema.ts `before`):
// a database as the last release before it left it (table lobbies, lobby_id
// columns, their constraints and indexes) is renamed with every row kept; a
// second boot changes nothing; an empty `lobbies` next to `playlists` (what an
// older image leaves when it is started against the renamed database) is
// dropped, one with rows stops the boot; the older images' DROP cannot take
// the renamed table.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pgModule from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../../shared/db.ts';

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}

function dockerOk() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

const skipReason = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !dockerOk() ? 'Docker not available' : false;

// The playlist tables exactly as the release before the rename creates them.
const OLD_SCHEMA = `
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider VARCHAR(20) NOT NULL DEFAULT 'local',
    provider_id VARCHAR(255), status VARCHAR(20) DEFAULT 'approved', created_at BIGINT NOT NULL);
  CREATE TABLE lobbies (id VARCHAR(8) PRIMARY KEY, host_id VARCHAR(255), name VARCHAR(50),
    visibility VARCHAR(10) NOT NULL DEFAULT 'public', created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL,
    pinned BOOLEAN DEFAULT FALSE);
  CREATE INDEX idx_lobbies_last_activity ON lobbies(last_activity);
  CREATE TABLE queue_songs (id UUID PRIMARY KEY, lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
    url TEXT NOT NULL, title TEXT DEFAULT 'Unknown', duration REAL DEFAULT 0, added_by VARCHAR(255) DEFAULT 'anonymous',
    thumbnail TEXT, added_at BIGINT NOT NULL, sort_order INTEGER NOT NULL);
  CREATE INDEX idx_queue_songs_lobby ON queue_songs(lobby_id, sort_order);
  CREATE TABLE playlist_pins (user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE, pinned_at BIGINT NOT NULL, PRIMARY KEY (user_id, lobby_id));
  CREATE INDEX idx_playlist_pins_lobby ON playlist_pins(lobby_id);
  CREATE TABLE song_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), youtube_id VARCHAR(32), url TEXT, title TEXT,
    artist TEXT, requested_by VARCHAR(255) NOT NULL DEFAULT 'anonymous', requested_by_id VARCHAR(255), lobby_id VARCHAR(8),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

describe('the lobby -> playlist rename', { skip: skipReason, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client | undefined;
  const one = async (sql: string) => (await pg!.query(sql)).rows[0];
  const exists = async (name: string) => (await one(`SELECT to_regclass('public.${name}') IS NOT NULL AS ok`)).ok as boolean;

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_rename').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    pg = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(OLD_SCHEMA);
    const u = (await one(`INSERT INTO users (provider, provider_id, created_at) VALUES ('dev', 'a', 1) RETURNING id`)).id;
    await pg.query(`INSERT INTO lobbies (id, host_id, name, visibility, created_at, last_activity) VALUES
      ('pub00001', '${u}', 'Public one', 'public', 1, 2), ('prv00001', '${u}', 'Private one', 'private', 3, 4)`);
    await pg.query(`INSERT INTO queue_songs (id, lobby_id, url, added_at, sort_order) VALUES
      (gen_random_uuid(), 'pub00001', 'library:x', 5, 0), (gen_random_uuid(), 'prv00001', 'library:y', 6, 0)`);
    await pg.query(`INSERT INTO playlist_pins (user_id, lobby_id, pinned_at) VALUES ('${u}', 'pub00001', 7)`);
    await pg.query(`INSERT INTO song_requests (title, lobby_id) VALUES ('Wanted', 'prv00001')`);
  });

  after(async () => {
    if (pg) await pg.end();
    await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  it('renames the table, the columns, their constraints and indexes, and keeps every row', async () => {
    assert.ok(await db.init());
    assert.equal(await exists('lobbies'), false);
    assert.deepEqual((await pg!.query(`SELECT id, name, visibility FROM playlists ORDER BY id`)).rows,
      [{ id: 'prv00001', name: 'Private one', visibility: 'private' }, { id: 'pub00001', name: 'Public one', visibility: 'public' }]);
    assert.equal((await one(`SELECT count(*)::int AS n FROM queue_songs WHERE playlist_id IN ('pub00001', 'prv00001')`)).n, 2);
    assert.equal((await one(`SELECT playlist_id FROM playlist_pins`)).playlist_id, 'pub00001');
    assert.equal((await one(`SELECT playlist_id FROM song_requests`)).playlist_id, 'prv00001');
    const cols = await pg!.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'lobby_id' AND table_schema = 'public'`);
    assert.deepEqual(cols.rows, []);
    const names = (await pg!.query(`SELECT conname FROM pg_constraint WHERE conname LIKE '%lobb%' UNION ALL
      SELECT indexname FROM pg_indexes WHERE indexname LIKE '%lobb%'`)).rows;
    assert.deepEqual(names, [], 'no constraint or index keeps the old name');
    for (const n of ['playlists_pkey', 'idx_playlists_last_activity', 'idx_queue_songs_playlist', 'idx_playlist_pins_playlist',
      'queue_songs_playlist_id_fkey', 'playlist_pins_playlist_id_fkey']) {
      assert.ok((await one(`SELECT (SELECT count(*) FROM pg_constraint WHERE conname = '${n}') + (SELECT count(*) FROM pg_indexes WHERE indexname = '${n}') AS n`)).n > 0, n);
    }
    // The foreign keys still cascade from the renamed table.
    await pg!.query(`DELETE FROM playlists WHERE id = 'pub00001'`);
    assert.equal((await one(`SELECT count(*)::int AS n FROM queue_songs WHERE playlist_id = 'pub00001'`)).n, 0);
  });

  it('a second boot changes nothing', async () => {
    const before = await pg!.query(`SELECT * FROM playlists ORDER BY id`);
    await db.close();
    assert.ok(await db.init());
    assert.deepEqual((await pg!.query(`SELECT * FROM playlists ORDER BY id`)).rows, before.rows);
  });

  it('an older image\'s DROP leaves the renamed table alone', async () => {
    await assert.rejects(pg!.query('DROP TABLE IF EXISTS playlist_songs, playlists CASCADE'), /is not a table/);
    assert.equal(await exists('playlists'), true);
  });

  it('an empty lobbies next to playlists (an older image was started) is dropped at the next boot', async () => {
    await pg!.query(`CREATE TABLE lobbies (id VARCHAR(8) PRIMARY KEY, host_id VARCHAR(255), name VARCHAR(50),
      visibility VARCHAR(10) NOT NULL DEFAULT 'public', created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL)`);
    await pg!.query(`CREATE INDEX idx_lobbies_last_activity ON lobbies(last_activity)`);
    await db.close();
    assert.ok(await db.init());
    assert.equal(await exists('lobbies'), false);
    assert.equal(await exists('idx_playlists_last_activity'), true);
    assert.equal((await one(`SELECT count(*)::int AS n FROM playlists`)).n, 1);
  });

  it('a lobbies with rows next to playlists stops the boot and changes nothing', async () => {
    await pg!.query(`CREATE TABLE lobbies (id VARCHAR(8) PRIMARY KEY, created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL)`);
    await pg!.query(`INSERT INTO lobbies VALUES ('new00001', 1, 1)`);
    await db.close();
    assert.equal(await db.init(), false, 'no database rather than a guess');
    assert.equal((await one(`SELECT count(*)::int AS n FROM lobbies`)).n, 1);
    assert.equal((await one(`SELECT count(*)::int AS n FROM playlists`)).n, 1);
    await pg!.query(`DROP TABLE lobbies`);
    assert.ok(await db.init());
  });

  it('a boot that dies inside the rename changes nothing (one statement, one transaction)', async () => {
    // The rename block, run again by hand inside a transaction that is rolled back.
    const { before: steps } = await import('./schema.ts');
    await pg!.query(`ALTER TABLE playlists RENAME TO lobbies`);
    await pg!.query('BEGIN');
    await pg!.query(steps[1]);
    assert.equal(await exists('playlists'), true, 'renamed inside the transaction');
    await pg!.query('ROLLBACK');
    assert.equal(await exists('lobbies'), true, 'rolled back: still lobbies');
    assert.equal(await exists('playlists'), false);
    await db.close();
    assert.ok(await db.init());
    assert.equal(await exists('playlists'), true);
  });
});
