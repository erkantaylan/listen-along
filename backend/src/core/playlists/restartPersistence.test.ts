import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';
import { playlist } from './index.ts';
import { getQueueAsync, forgetAll as forgetQueues } from '../queue/index.ts';

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

/**
 * Poll until `check` returns truthy. Used for queue writes, which are
 * fire-and-forget in production code, instead of a fixed sleep.
 */
async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for: ${message}`);
}

/** Song titles persisted for a playlist, in sort order. */
async function persistedTitles(db: DbModule, playlistId: string) {
  const result = await db.query<{ title: string }>(
    'SELECT title FROM queue_songs WHERE playlist_id = $1 ORDER BY sort_order',
    [playlistId]
  );
  return result.rows.map(r => r.title);
}

async function waitForTitles(db: DbModule, playlistId: string, expected: string[]) {
  await waitFor(
    async () => JSON.stringify(await persistedTitles(db, playlistId)) === JSON.stringify(expected),
    `queue_songs for ${playlistId} to be ${expected.join(', ')}`
  );
}

/**
 * Simulate a server restart by clearing in-memory module state.
 * The db module keeps its pool connection, but the playlist and queue
 * modules forget everything they hold in memory.
 */
function simulateRestart() {
  playlist.forgetAll();
  forgetQueues();
}

describe('Playlist persistence across server restarts', { skip: skipReason, timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let dbOpened = false;

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

  it('restores a playlist (name, visibility) from DB after restart', async () => {
    const created = await playlist.createPlaylistAsync('owner-1', 'lm-test1', 'Restart me', 'private');
    assert.equal(created.name, 'Restart me');

    // Simulate server restart (clears in-memory maps)
    simulateRestart();

    // Rejoin via getPlaylistAsync (simulates lobby:join looking up the playlist from DB)
    const restored = await playlist.getPlaylistAsync('lm-test1');
    assert.ok(restored, 'Playlist should be restored from DB');
    assert.equal(restored.id, 'lm-test1');
    assert.equal(restored.name, 'Restart me');
    assert.equal(restored.visibility, 'private');
    assert.equal(restored.ownerId, 'owner-1');
  });

  it('migrates a pre-existing Jam playlist to a plain playlist on startup', async () => {
    // Recreate the old schema: per-playlist listening mode, shared queue cursor
    // and server-side playback state, with a playlist stored as synchronized.
    await db.query(`ALTER TABLE playlists ADD COLUMN IF NOT EXISTS listening_mode VARCHAR(20) DEFAULT 'synchronized'`);
    await db.query(`ALTER TABLE playlists ADD COLUMN IF NOT EXISTS current_index INTEGER DEFAULT -1`);
    await db.query(`CREATE TABLE IF NOT EXISTS playback_state (playlist_id VARCHAR(8) PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE, position REAL DEFAULT 0)`);
    await db.query(
      `INSERT INTO playlists (id, name, listening_mode, current_index, created_at, last_activity) VALUES ('jam-old1', 'Old jam', 'synchronized', 2, $1, $1)`,
      [Date.now()]
    );
    await db.query(`INSERT INTO playback_state (playlist_id, position) VALUES ('jam-old1', 42)`);

    // Restart: init runs the migrations again on the existing schema.
    await db.close();
    assert.ok(await db.init(), 'Database should re-initialize');

    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'playlists' AND column_name IN ('listening_mode', 'current_index')`
    );
    assert.equal(cols.rows.length, 0, 'listening_mode and current_index should be dropped');
    const tables = await db.query(`SELECT to_regclass('playback_state') AS t`);
    assert.equal(tables.rows[0].t, null, 'playback_state should be dropped');

    simulateRestart();
    const restored = await playlist.getPlaylistAsync('jam-old1');
    assert.ok(restored, 'Former Jam playlist should still load');
    assert.equal(restored.name, 'Old jam');
    assert.equal((restored as unknown as Record<string, unknown>).listeningMode, undefined);
  });

  it('restores queue songs from DB after restart', async () => {

    await playlist.createPlaylistAsync(null, 'q-test1');
    const queue = await getQueueAsync('q-test1');

    queue.addSong({ url: 'https://youtube.com/watch?v=song1', title: 'Song One', duration: 180, addedBy: 'Alice' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song2', title: 'Song Two', duration: 200, addedBy: 'Bob' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song3', title: 'Song Three', duration: 220, addedBy: 'Charlie' });

    // Song inserts are fire-and-forget: wait until they are in the DB
    await waitForTitles(db, 'q-test1', ['Song One', 'Song Two', 'Song Three']);

    // Simulate server restart
    simulateRestart();

    // Reload queue from DB
    const restoredQueue = await getQueueAsync('q-test1');
    const songs = restoredQueue.getSongs();

    assert.equal(songs.length, 3, 'All 3 songs should be restored');
    assert.equal(songs[0].title, 'Song One');
    assert.equal(songs[1].title, 'Song Two');
    assert.equal(songs[2].title, 'Song Three');
    assert.equal(songs[0].addedBy, 'Alice');
    assert.equal(songs[1].addedBy, 'Bob');
    assert.equal(songs[2].addedBy, 'Charlie');
  });

  it('preserves queue order after restart', async () => {

    await playlist.createPlaylistAsync(null, 'qo-test1');
    const queue = await getQueueAsync('qo-test1');

    const songA = queue.addSong({ url: 'https://youtube.com/watch?v=a', title: 'Alpha', duration: 100, addedBy: 'User1' });
    queue.addSong({ url: 'https://youtube.com/watch?v=b', title: 'Beta', duration: 110, addedBy: 'User1' });
    queue.addSong({ url: 'https://youtube.com/watch?v=c', title: 'Charlie', duration: 120, addedBy: 'User1' });
    const songD = queue.addSong({ url: 'https://youtube.com/watch?v=d', title: 'Delta', duration: 130, addedBy: 'User1' });

    // Wait for the initial inserts to land before reordering
    await waitForTitles(db, 'qo-test1', ['Alpha', 'Beta', 'Charlie', 'Delta']);

    // Reorder: move Delta (index 3) to index 1
    queue.reorderSong(songD.id, 1);

    // Wait for the sort order updates to land
    await waitForTitles(db, 'qo-test1', ['Alpha', 'Delta', 'Beta', 'Charlie']);

    // Verify in-memory order before restart: Alpha, Delta, Beta, Charlie
    const before = queue.getSongs();
    assert.equal(before[0].title, 'Alpha');
    assert.equal(before[1].title, 'Delta');
    assert.equal(before[2].title, 'Beta');
    assert.equal(before[3].title, 'Charlie');

    // Simulate server restart
    simulateRestart();

    // Reload queue from DB
    const restoredQueue = await getQueueAsync('qo-test1');
    const songs = restoredQueue.getSongs();

    assert.equal(songs.length, 4, 'All 4 songs should be restored');
    assert.equal(songs[0].title, 'Alpha', 'First song should be Alpha');
    assert.equal(songs[1].title, 'Delta', 'Second song should be Delta (reordered)');
    assert.equal(songs[2].title, 'Beta', 'Third song should be Beta');
    assert.equal(songs[3].title, 'Charlie', 'Fourth song should be Charlie');
  });
});
