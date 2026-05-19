const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

let PostgreSqlContainer;
try {
  PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer;
} catch {
  // testcontainers not installed
}

function isDockerAvailable() {
  if (!PostgreSqlContainer) return false;
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipReason = !PostgreSqlContainer
  ? 'testcontainers package not installed'
  : !isDockerAvailable()
    ? 'Docker not available'
    : false;

describe('Playlist visibility + ownership', { skip: skipReason, timeout: 120_000 }, () => {
  let container;
  let db;
  let playlist;

  const ALICE = 'user-alice';
  const BOB = 'user-bob';

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();

    db = require('./db');
    const initialized = await db.init();
    assert.ok(initialized, 'Database should initialize');

    playlist = require('./playlist');
  });

  after(async () => {
    if (db) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;

    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./playlist')];
  });

  it('migrates an existing user_id column to created_by', async () => {
    // Confirm the schema renamed user_id → created_by and added is_public.
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'playlists'
    `);
    const names = cols.rows.map(r => r.column_name);
    assert.ok(names.includes('created_by'), 'created_by column should exist');
    assert.ok(names.includes('is_public'), 'is_public column should exist');
    assert.ok(!names.includes('user_id'), 'user_id column should not exist');
  });

  it('createPlaylist defaults to is_public=true and records created_by', async () => {
    const p = await playlist.createPlaylist(ALICE, 'Alice public');
    assert.equal(p.created_by, ALICE);
    assert.equal(p.is_public, true);
    assert.equal(p.name, 'Alice public');
  });

  it('getVisiblePlaylists returns all public + own private, never others private', async () => {
    // Reset baseline so this test is hermetic.
    await db.query('DELETE FROM playlists');

    const alicePublic = await playlist.createPlaylist(ALICE, 'A pub');
    const alicePrivate = await playlist.createPlaylist(ALICE, 'A priv');
    await playlist.setVisibility(alicePrivate.id, ALICE, false);

    const bobPublic = await playlist.createPlaylist(BOB, 'B pub');
    const bobPrivate = await playlist.createPlaylist(BOB, 'B priv');
    await playlist.setVisibility(bobPrivate.id, BOB, false);

    const fromAlice = await playlist.getVisiblePlaylists(ALICE);
    const aliceIds = fromAlice.map(p => p.id).sort();
    const expected = [alicePublic.id, alicePrivate.id, bobPublic.id].sort();
    assert.deepEqual(aliceIds, expected, 'Alice sees own + all public');
    assert.ok(!aliceIds.includes(bobPrivate.id), "Alice must not see Bob's private");

    const fromBob = await playlist.getVisiblePlaylists(BOB);
    const bobIds = fromBob.map(p => p.id).sort();
    const expectedBob = [bobPublic.id, bobPrivate.id, alicePublic.id].sort();
    assert.deepEqual(bobIds, expectedBob, 'Bob sees own + all public');
    assert.ok(!bobIds.includes(alicePrivate.id), "Bob must not see Alice's private");
  });

  it('getPlaylistVisible returns null for non-owned private (does not leak existence)', async () => {
    const priv = await playlist.createPlaylist(ALICE, 'secret');
    await playlist.setVisibility(priv.id, ALICE, false);

    assert.ok(await playlist.getPlaylistVisible(priv.id, ALICE), 'owner sees private');
    assert.equal(
      await playlist.getPlaylistVisible(priv.id, BOB),
      null,
      'non-owner gets null on private'
    );
  });

  it('deletePlaylist: creator can delete, non-creator forbidden, missing not_found', async () => {
    const p = await playlist.createPlaylist(ALICE, 'to-delete');

    assert.equal(await playlist.deletePlaylist(p.id, BOB), 'forbidden');
    assert.equal(await playlist.deletePlaylist(p.id, ALICE), 'deleted');
    assert.equal(await playlist.deletePlaylist(p.id, ALICE), 'not_found');
  });

  it('setVisibility: creator can flip, non-creator forbidden', async () => {
    const p = await playlist.createPlaylist(ALICE, 'toggle me');

    assert.equal(await playlist.setVisibility(p.id, BOB, false), 'forbidden');

    const updated = await playlist.setVisibility(p.id, ALICE, false);
    assert.equal(updated.is_public, false);

    const reupdated = await playlist.setVisibility(p.id, ALICE, true);
    assert.equal(reupdated.is_public, true);
  });

  it('renamePlaylist: creator can rename, non-creator forbidden', async () => {
    const p = await playlist.createPlaylist(ALICE, 'old name');
    assert.equal(await playlist.renamePlaylist(p.id, BOB, 'hacked'), 'forbidden');
    const ok = await playlist.renamePlaylist(p.id, ALICE, 'new name');
    assert.equal(ok.name, 'new name');
  });

  it('addSong / removeSong: only owner can mutate songs', async () => {
    const p = await playlist.createPlaylist(ALICE, 'song home');

    const aliceAdded = await playlist.addSong(p.id, ALICE, {
      url: 'https://example.com/a', title: 'A', duration: 100
    });
    assert.equal(aliceAdded.url, 'https://example.com/a');

    const bobAdd = await playlist.addSong(p.id, BOB, {
      url: 'https://example.com/b', title: 'B', duration: 100
    });
    assert.equal(bobAdd, 'forbidden');

    assert.equal(
      await playlist.removeSong(p.id, aliceAdded.id, BOB),
      'forbidden'
    );
    assert.equal(
      await playlist.removeSong(p.id, aliceAdded.id, ALICE),
      'removed'
    );
  });
});

describe('Playlist column rename migration on legacy schema', { skip: skipReason, timeout: 120_000 }, () => {
  let container;
  let pool;

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('legacy_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const { Pool } = require('pg');
    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Seed a legacy schema as it would appear pre-migration.
    await pool.query(`
      CREATE TABLE playlists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX idx_playlists_user ON playlists(user_id)`);
    await pool.query(
      `INSERT INTO playlists (user_id, name, created_at) VALUES ($1, $2, $3)`,
      ['legacy-user', 'kept playlist', Date.now()]
    );

    // Hand off to db.init which should migrate idempotently.
    process.env.DATABASE_URL = container.getConnectionUri();
    delete require.cache[require.resolve('./db')];
    const db = require('./db');
    await db.init();
    await db.close();
  });

  after(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
    delete require.cache[require.resolve('./db')];
  });

  it('renames user_id to created_by while preserving rows', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'playlists'
    `);
    const names = cols.rows.map(r => r.column_name);
    assert.ok(names.includes('created_by'));
    assert.ok(names.includes('is_public'));
    assert.ok(!names.includes('user_id'));

    const rows = await pool.query('SELECT created_by, name, is_public FROM playlists');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].created_by, 'legacy-user');
    assert.equal(rows.rows[0].name, 'kept playlist');
    assert.equal(rows.rows[0].is_public, true);
  });

  it('drops old index and creates new one', async () => {
    const idx = await pool.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'playlists'
    `);
    const names = idx.rows.map(r => r.indexname);
    assert.ok(!names.includes('idx_playlists_user'), 'old index should be dropped');
    assert.ok(names.includes('idx_playlists_created_by'), 'new index should exist');
  });
});
