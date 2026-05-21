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

// Simulate a server restart: clear in-memory module state but keep the db pool.
function simulateRestart() {
  delete require.cache[require.resolve('./lobby')];
  delete require.cache[require.resolve('./queue')];
  delete require.cache[require.resolve('./playback')];
}

// Lobby ownership + visibility + no-auto-expiry (hq-9gvy). Exercises the data
// layer (db.js + lobby.js). The HTTP ownership checks (403/404 in index.js) are
// thin wrappers over hostId === userId and over these functions.
describe('Lobby ownership, visibility, persistence', { skip: skipReason, timeout: 120_000 }, () => {
  let container;
  let db;

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
    assert.ok(initialized, 'Database should initialize successfully');
  });

  after(async () => {
    if (db) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;

    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./lobby')];
    delete require.cache[require.resolve('./queue')];
    delete require.cache[require.resolve('./playback')];
  });

  it('lobbies table has an is_public column', async () => {
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'lobbies'
    `);
    const names = cols.rows.map(r => r.column_name);
    assert.ok(names.includes('is_public'), 'is_public column should exist');
    assert.ok(names.includes('host_id'), 'host_id column should exist');
  });

  it('createLobbyAsync persists host_id and defaults is_public=true', async () => {
    const lobby = require('./lobby');
    const created = await lobby.createLobbyAsync(ALICE, 'own-1', 'synchronized', 'Alice room');
    assert.equal(created.hostId, ALICE);
    assert.equal(created.isPublic, true);

    const row = await db.query('SELECT host_id, is_public FROM lobbies WHERE id = $1', ['own-1']);
    assert.equal(row.rows[0].host_id, ALICE);
    assert.equal(row.rows[0].is_public, true);
  });

  it('anonymous creator persists host_id = null (no owner)', async () => {
    const lobby = require('./lobby');
    await lobby.createLobbyAsync(null, 'anon-1', 'synchronized');
    const row = await db.query('SELECT host_id FROM lobbies WHERE id = $1', ['anon-1']);
    assert.equal(row.rows[0].host_id, null);
  });

  it('setVisibility persists and survives a restart', async () => {
    const lobby = require('./lobby');
    await lobby.createLobbyAsync(ALICE, 'vis-1', 'synchronized', 'Toggle me');

    await lobby.setVisibility('vis-1', false);
    let row = await db.query('SELECT is_public FROM lobbies WHERE id = $1', ['vis-1']);
    assert.equal(row.rows[0].is_public, false);

    // After a restart the private flag is reloaded from the DB.
    simulateRestart();
    const lobbyAfter = require('./lobby');
    const restored = await lobbyAfter.getLobbyAsync('vis-1');
    assert.ok(restored, 'Lobby should be restored');
    assert.equal(restored.isPublic, false, 'private visibility should persist');

    await lobbyAfter.setVisibility('vis-1', true);
    row = await db.query('SELECT is_public FROM lobbies WHERE id = $1', ['vis-1']);
    assert.equal(row.rows[0].is_public, true);
  });

  it('getAllLobbies carries hostId + isPublic for visibility filtering', async () => {
    const lobby = require('./lobby');
    await lobby.createLobbyAsync(BOB, 'list-pub', 'synchronized', 'Bob public');
    const priv = await lobby.createLobbyAsync(BOB, 'list-priv', 'synchronized', 'Bob private');
    await lobby.setVisibility(priv.id, false);

    const all = lobby.getAllLobbies();
    const pub = all.find(l => l.id === 'list-pub');
    const hidden = all.find(l => l.id === 'list-priv');
    assert.equal(pub.hostId, BOB);
    assert.equal(pub.isPublic, true);
    assert.equal(hidden.isPublic, false);

    // The route filter: public OR owner is visible; others' private is hidden.
    const visibleTo = (uid) => all.filter(l => l.isPublic !== false || (l.hostId && l.hostId === uid));
    const aliceSees = visibleTo(ALICE).map(l => l.id);
    assert.ok(aliceSees.includes('list-pub'), 'Alice sees public lobby');
    assert.ok(!aliceSees.includes('list-priv'), "Alice does NOT see Bob's private lobby");
    const bobSees = visibleTo(BOB).map(l => l.id);
    assert.ok(bobSees.includes('list-priv'), 'Bob sees his own private lobby');
  });

  it('idle lobbies are NOT auto-deleted (no time-based expiry)', async () => {
    const lobby = require('./lobby');
    await lobby.createLobbyAsync(ALICE, 'idle-1', 'synchronized', 'Idle room');

    // Backdate well past the old 24h timeout.
    const ancient = Date.now() - (1000 * 60 * 60 * 24 * 30); // 30 days
    await db.query('UPDATE lobbies SET last_activity = $1 WHERE id = $2', [ancient, 'idle-1']);

    // Both the (now no-op) DB cleanup and the in-memory sweep must keep it.
    assert.equal(await db.cleanupExpiredLobbies(), 0, 'cleanupExpiredLobbies must delete nothing');
    await lobby.cleanupEmptyLobbies();

    const row = await db.query('SELECT id FROM lobbies WHERE id = $1', ['idle-1']);
    assert.equal(row.rows.length, 1, 'idle lobby row must still exist');
    assert.ok(lobby.getLobby('idle-1') || await lobby.getLobbyAsync('idle-1'), 'idle lobby still loadable');
  });

  it('deleteLobbyAsync removes the row from the DB (creator/admin delete)', async () => {
    const lobby = require('./lobby');
    await lobby.createLobbyAsync(ALICE, 'del-1', 'synchronized', 'Delete me');
    await delay(50);

    await lobby.deleteLobbyAsync('del-1');

    const row = await db.query('SELECT id FROM lobbies WHERE id = $1', ['del-1']);
    assert.equal(row.rows.length, 0, 'deleted lobby row must be gone');

    // And it must not resurrect on restart.
    simulateRestart();
    const lobbyAfter = require('./lobby');
    const restored = await lobbyAfter.getLobbyAsync('del-1');
    assert.equal(restored, undefined, 'deleted lobby must not reappear after restart');
  });
});
