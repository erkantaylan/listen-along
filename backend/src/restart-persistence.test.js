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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll until `check` returns truthy. Used for queue writes, which are
 * fire-and-forget in production code, instead of a fixed sleep.
 */
async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for: ${message}`);
}

/** Song titles persisted for a lobby, in sort order. */
async function persistedTitles(db, lobbyId) {
  const result = await db.query(
    'SELECT title FROM queue_songs WHERE lobby_id = $1 ORDER BY sort_order',
    [lobbyId]
  );
  return result.rows.map(r => r.title);
}

async function waitForTitles(db, lobbyId, expected) {
  await waitFor(
    async () => JSON.stringify(await persistedTitles(db, lobbyId)) === JSON.stringify(expected),
    `queue_songs for ${lobbyId} to be ${expected.join(', ')}`
  );
}

/**
 * Simulate a server restart by clearing in-memory module state.
 * The db module stays cached so the pool connection persists,
 * but lobby/queue modules get fresh empty Maps.
 */
function simulateRestart() {
  delete require.cache[require.resolve('./lobby')];
  delete require.cache[require.resolve('./queue')];
}

describe('Lobby persistence across server restarts', { skip: skipReason, timeout: 120_000 }, () => {
  let container;
  let db;

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();

    db = require('./db');
    const initialized = await db.init();
    assert.ok(initialized, 'Database should initialize successfully');
  });

  after(async () => {
    if (db) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;

    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./lobby')];
    delete require.cache[require.resolve('./queue')];
  });

  it('restores a lobby (name, visibility) from DB after restart', async () => {
    const lobby = require('./lobby');

    const created = await lobby.createLobbyAsync('owner-1', 'lm-test1', 'Restart me', 'private');
    assert.equal(created.name, 'Restart me');

    // Simulate server restart (clears in-memory maps)
    simulateRestart();
    const lobbyAfter = require('./lobby');

    // Rejoin via getLobbyAsync (simulates lobby:join looking up the lobby from DB)
    const restored = await lobbyAfter.getLobbyAsync('lm-test1');
    assert.ok(restored, 'Lobby should be restored from DB');
    assert.equal(restored.id, 'lm-test1');
    assert.equal(restored.name, 'Restart me');
    assert.equal(restored.visibility, 'private');
    assert.equal(restored.ownerId, 'owner-1');
  });

  it('migrates a pre-existing Jam lobby to a plain lobby on startup', async () => {
    // Recreate the old schema: per-lobby listening mode, shared queue cursor
    // and server-side playback state, with a lobby stored as synchronized.
    await db.query(`ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS listening_mode VARCHAR(20) DEFAULT 'synchronized'`);
    await db.query(`ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS current_index INTEGER DEFAULT -1`);
    await db.query(`CREATE TABLE IF NOT EXISTS playback_state (lobby_id VARCHAR(8) PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE, position REAL DEFAULT 0)`);
    await db.query(
      `INSERT INTO lobbies (id, name, listening_mode, current_index, created_at, last_activity) VALUES ('jam-old1', 'Old jam', 'synchronized', 2, $1, $1)`,
      [Date.now()]
    );
    await db.query(`INSERT INTO playback_state (lobby_id, position) VALUES ('jam-old1', 42)`);

    // Restart: init runs the migrations again on the existing schema.
    await db.close();
    assert.ok(await db.init(), 'Database should re-initialize');

    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lobbies' AND column_name IN ('listening_mode', 'current_index')`
    );
    assert.equal(cols.rows.length, 0, 'listening_mode and current_index should be dropped');
    const tables = await db.query(`SELECT to_regclass('playback_state') AS t`);
    assert.equal(tables.rows[0].t, null, 'playback_state should be dropped');

    simulateRestart();
    const lobby = require('./lobby');
    const restored = await lobby.getLobbyAsync('jam-old1');
    assert.ok(restored, 'Former Jam lobby should still load');
    assert.equal(restored.name, 'Old jam');
    assert.equal(restored.listeningMode, undefined);
  });

  it('restores queue songs from DB after restart', async () => {
    const lobby = require('./lobby');
    const { getQueueAsync } = require('./queue');

    await lobby.createLobbyAsync(null, 'q-test1');
    const queue = await getQueueAsync('q-test1');

    queue.addSong({ url: 'https://youtube.com/watch?v=song1', title: 'Song One', duration: 180, addedBy: 'Alice' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song2', title: 'Song Two', duration: 200, addedBy: 'Bob' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song3', title: 'Song Three', duration: 220, addedBy: 'Charlie' });

    // Song inserts are fire-and-forget: wait until they are in the DB
    await waitForTitles(db, 'q-test1', ['Song One', 'Song Two', 'Song Three']);

    // Simulate server restart
    simulateRestart();
    const { getQueueAsync: getQueueAfter } = require('./queue');

    // Reload queue from DB
    const restoredQueue = await getQueueAfter('q-test1');
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
    const lobby = require('./lobby');
    const { getQueueAsync } = require('./queue');

    await lobby.createLobbyAsync(null, 'qo-test1');
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
    const { getQueueAsync: getQueueAfter } = require('./queue');

    // Reload queue from DB
    const restoredQueue = await getQueueAfter('qo-test1');
    const songs = restoredQueue.getSongs();

    assert.equal(songs.length, 4, 'All 4 songs should be restored');
    assert.equal(songs[0].title, 'Alpha', 'First song should be Alpha');
    assert.equal(songs[1].title, 'Delta', 'Second song should be Delta (reordered)');
    assert.equal(songs[2].title, 'Beta', 'Third song should be Beta');
    assert.equal(songs[3].title, 'Charlie', 'Fourth song should be Charlie');
  });
});
