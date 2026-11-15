import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../../shared/db.ts';
import { playlist, access } from './index.ts';
import { forgetAll as forgetQueues } from '../queue/index.ts';

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try {
  ({ PostgreSqlContainer } = await import('@testcontainers/postgresql'));
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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Simulate a server restart: clear in-memory module state but keep the db pool.
function simulateRestart() {
  playlist.forgetAll();
  forgetQueues();
}

// Playlist ownership + visibility + no-auto-expiry. Exercises the data
// layer (shared/db.ts + playlist.ts + playlistAccess.ts). The HTTP / socket checks are
// covered against a running server in playlistPermissions.test.ts.
describe('Playlist ownership, visibility, persistence', { skip: skipReason, timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let dbOpened = false;

  const ALICE = 'user-alice';
  const BOB = 'user-bob';

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();

    dbOpened = true;
    const initialized = await db.init();
    assert.ok(initialized, 'Database should initialize successfully');
  });

  after(async () => {
    if (dbOpened) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;

    playlist.forgetAll();
    forgetQueues();
  });

  it('lobbies table has visibility + host_id and no is_public / chat table', async () => {
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'lobbies'
    `);
    const names = cols.rows.map(r => r.column_name);
    assert.ok(names.includes('visibility'), 'visibility column should exist');
    assert.ok(names.includes('host_id'), 'host_id (owner) column should exist');
    assert.ok(!names.includes('is_public'), 'is_public is replaced by visibility');
    const chat = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_messages'`);
    assert.equal(chat.rows.length, 0, 'chat_messages table is dropped');
  });

  it('createPlaylistAsync persists the owner and defaults to public', async () => {
    const created = await playlist.createPlaylistAsync(ALICE, 'own-1', 'Alice room');
    assert.equal(created.ownerId, ALICE);
    assert.equal(created.visibility, 'public');

    const row = await db.query('SELECT host_id, visibility FROM lobbies WHERE id = $1', ['own-1']);
    assert.equal(row.rows[0].host_id, ALICE);
    assert.equal(row.rows[0].visibility, 'public');
  });

  it('anonymous creator persists host_id = null and is always public', async () => {
    await playlist.createPlaylistAsync(null, 'anon-1', null, 'private');
    const row = await db.query('SELECT host_id, visibility FROM lobbies WHERE id = $1', ['anon-1']);
    assert.equal(row.rows[0].host_id, null);
    assert.equal(row.rows[0].visibility, 'public');
  });

  it('setVisibility persists and survives a restart', async () => {
    await playlist.createPlaylistAsync(ALICE, 'vis-1', 'Toggle me');

    await playlist.setVisibility('vis-1', 'private');
    let row = await db.query('SELECT visibility FROM lobbies WHERE id = $1', ['vis-1']);
    assert.equal(row.rows[0].visibility, 'private');

    simulateRestart();
    const restored = await playlist.getPlaylistAsync('vis-1');
    assert.ok(restored, 'Playlist should be restored');
    assert.equal(restored.visibility, 'private', 'private visibility should persist');
    assert.equal(restored.ownerId, ALICE, 'owner should persist');

    await playlist.setVisibility('vis-1', 'public');
    row = await db.query('SELECT visibility FROM lobbies WHERE id = $1', ['vis-1']);
    assert.equal(row.rows[0].visibility, 'public');
  });

  it('getAllPlaylists + playlistAccess: others never see a private playlist', async () => {
    await playlist.createPlaylistAsync(BOB, 'list-pub', 'Bob public');
    await playlist.createPlaylistAsync(BOB, 'lst-priv', 'Bob private', 'private');

    simulateRestart();
    await playlist.loadPlaylistsFromDB();
    const all = playlist.getAllPlaylists();
    const visibleTo = (uid: string | null) => all.filter(l => access.canView(l, uid)).map(l => l.id);
    assert.ok(visibleTo(ALICE).includes('list-pub'), 'Alice sees public playlist');
    assert.ok(!visibleTo(ALICE).includes('lst-priv'), "Alice does NOT see Bob's private playlist");
    assert.ok(visibleTo(BOB).includes('lst-priv'), 'Bob sees his own private playlist');
    assert.deepEqual(visibleTo(null), [], 'not logged in sees nothing');
  });

  it('idle playlists are NOT auto-deleted (no time-based expiry)', async () => {
    await playlist.createPlaylistAsync(ALICE, 'idle-1', 'Idle room');

    // Backdate well past the old 24h timeout.
    const ancient = Date.now() - (1000 * 60 * 60 * 24 * 30); // 30 days
    await db.query('UPDATE lobbies SET last_activity = $1 WHERE id = $2', [ancient, 'idle-1']);

    // Both the (now no-op) DB cleanup and the in-memory sweep must keep it.
    assert.equal(await db.cleanupExpiredLobbies(), 0, 'cleanupExpiredLobbies must delete nothing');
    await playlist.cleanupEmptyPlaylists();

    const row = await db.query('SELECT id FROM lobbies WHERE id = $1', ['idle-1']);
    assert.equal(row.rows.length, 1, 'idle playlist row must still exist');
    assert.ok(playlist.getPlaylist('idle-1') || await playlist.getPlaylistAsync('idle-1'), 'idle playlist still loadable');
  });

  it('deletePlaylistAsync removes the row from the DB (creator/admin delete)', async () => {
    await playlist.createPlaylistAsync(ALICE, 'del-1', 'Delete me');
    await delay(50);

    await playlist.deletePlaylistAsync('del-1');

    const row = await db.query('SELECT id FROM lobbies WHERE id = $1', ['del-1']);
    assert.equal(row.rows.length, 0, 'deleted playlist row must be gone');

    // And it must not resurrect on restart.
    simulateRestart();
    const restored = await playlist.getPlaylistAsync('del-1');
    assert.equal(restored, undefined, 'deleted playlist must not reappear after restart');
  });
});
