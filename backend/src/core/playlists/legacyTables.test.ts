// The personal-playlist feature's leftover tables and the rollback guard
// (core/playlists/schema.ts `before`): db.init() drops the legacy playlist_songs
// and a legacy `playlists` (no host_id), never a `playlists` of this app's own,
// and leaves a VIEW named playlist_songs that makes an older image's
// `DROP TABLE IF EXISTS playlist_songs, playlists CASCADE` fail as a whole.
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

const OLD_DROP = 'DROP TABLE IF EXISTS playlist_songs, playlists CASCADE';

describe('legacy playlist tables and the rollback guard', { skip: skipReason, timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client | undefined;
  const relkind = async (name: string) => (await pg!.query(
    `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
    [name],
  )).rows[0]?.relkind ?? null;

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_legacy').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    pg = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    // The personal-playlist feature's tables, as a very old release left them.
    await pg.query(`
      CREATE TABLE playlists (id SERIAL PRIMARY KEY, name TEXT NOT NULL, user_id TEXT);
      CREATE TABLE playlist_songs (id SERIAL PRIMARY KEY, playlist_id INTEGER REFERENCES playlists(id), url TEXT);
      INSERT INTO playlists (name) VALUES ('old personal list');
    `);
    assert.ok(await db.init(), 'db.init on the old schema');
  });

  after(async () => {
    if (pg) await pg.end();
    await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  it('drops the legacy tables and leaves the guard view', async () => {
    assert.equal(await relkind('playlist_songs'), 'v', 'playlist_songs is the guard view');
    const cols = await pg!.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'playlists'`);
    assert.ok(!cols.rows.some((c) => c.column_name === 'user_id'), 'the legacy playlists table is gone');
  });

  it('the older images\' DROP fails as a whole and drops nothing', async () => {
    // The app's own playlists table (db.init made it): a row the old DROP must not take.
    await pg!.query(`INSERT INTO playlists (id, host_id, created_at, last_activity) VALUES ('keep0001', 'u', 1, 1) ON CONFLICT DO NOTHING`);
    await assert.rejects(pg!.query(OLD_DROP), /is not a table/);
    assert.equal(await relkind('playlists'), 'r');
    assert.equal((await pg!.query(`SELECT count(*)::int AS n FROM playlists`)).rows[0].n, 1);
  });

  it('a second boot keeps a playlists table that has host_id, and the guard', async () => {
    await db.close();
    assert.ok(await db.init());
    assert.equal(await relkind('playlists'), 'r');
    assert.equal((await pg!.query(`SELECT count(*)::int AS n FROM playlists`)).rows[0].n, 1);
    assert.equal(await relkind('playlist_songs'), 'v');
  });
});
