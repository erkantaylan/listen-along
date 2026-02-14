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
 * Simulate a server restart by clearing in-memory module state.
 * The db module stays cached so the pool connection persists,
 * but lobby/queue/playlist modules get fresh empty Maps.
 */
function simulateRestart() {
  delete require.cache[require.resolve('./lobby')];
  delete require.cache[require.resolve('./queue')];
  delete require.cache[require.resolve('./playlist')];
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
    delete require.cache[require.resolve('./playlist')];
  });

  it('preserves listening mode "independent" after restart', async () => {
    const lobby = require('./lobby');

    // Create lobby with independent listening mode
    const created = await lobby.createLobbyAsync(null, 'lm-test1', 'independent');
    assert.equal(created.listeningMode, 'independent');

    // Simulate server restart (clears in-memory maps)
    simulateRestart();
    const lobbyAfter = require('./lobby');

    // Rejoin via getLobbyAsync (simulates lobby:join looking up the lobby from DB)
    const restored = await lobbyAfter.getLobbyAsync('lm-test1');
    assert.ok(restored, 'Lobby should be restored from DB');
    assert.equal(restored.id, 'lm-test1');
    assert.equal(restored.listeningMode, 'independent',
      'Listening mode should still be independent, not synchronized');
  });

  it('restores queue songs from DB after restart', async () => {
    const lobby = require('./lobby');
    const { getQueueAsync } = require('./queue');

    await lobby.createLobbyAsync(null, 'q-test1', 'synchronized');
    const queue = await getQueueAsync('q-test1');

    queue.addSong({ url: 'https://youtube.com/watch?v=song1', title: 'Song One', duration: 180, addedBy: 'Alice' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song2', title: 'Song Two', duration: 200, addedBy: 'Bob' });
    queue.addSong({ url: 'https://youtube.com/watch?v=song3', title: 'Song Three', duration: 220, addedBy: 'Charlie' });

    // Wait for fire-and-forget DB writes to complete
    await delay(500);

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

    await lobby.createLobbyAsync(null, 'qo-test1', 'synchronized');
    const queue = await getQueueAsync('qo-test1');

    const songA = queue.addSong({ url: 'https://youtube.com/watch?v=a', title: 'Alpha', duration: 100, addedBy: 'User1' });
    queue.addSong({ url: 'https://youtube.com/watch?v=b', title: 'Beta', duration: 110, addedBy: 'User1' });
    queue.addSong({ url: 'https://youtube.com/watch?v=c', title: 'Charlie', duration: 120, addedBy: 'User1' });
    const songD = queue.addSong({ url: 'https://youtube.com/watch?v=d', title: 'Delta', duration: 130, addedBy: 'User1' });

    // Wait for initial DB writes
    await delay(500);

    // Reorder: move Delta (index 3) to index 1
    queue.reorderSong(songD.id, 1);

    // Wait for sort order updates
    await delay(500);

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

  it('personal playlists remain accessible after restart', async () => {
    const playlist = require('./playlist');

    // Create playlists with songs
    const pl1 = await playlist.createPlaylist('user-42', 'Road Trip Mix');
    assert.ok(pl1, 'Playlist should be created');

    await playlist.addSong(pl1.id, { url: 'https://youtube.com/watch?v=rt1', title: 'Highway Star', duration: 360 });
    await playlist.addSong(pl1.id, { url: 'https://youtube.com/watch?v=rt2', title: 'Born to Run', duration: 270 });

    const pl2 = await playlist.createPlaylist('user-42', 'Chill Vibes');
    await playlist.addSong(pl2.id, { url: 'https://youtube.com/watch?v=cv1', title: 'Lofi Beat', duration: 180 });

    // Simulate server restart
    simulateRestart();
    const playlistAfter = require('./playlist');

    // Verify playlists still accessible
    const userPlaylists = await playlistAfter.getPlaylistsByUser('user-42');
    assert.equal(userPlaylists.length, 2, 'Both playlists should exist');

    // Verify songs in first playlist
    const restored1 = await playlistAfter.getPlaylist(pl1.id);
    assert.ok(restored1, 'Road Trip Mix should be accessible');
    assert.equal(restored1.name, 'Road Trip Mix');
    assert.equal(restored1.songs.length, 2, 'Should have 2 songs');
    assert.equal(restored1.songs[0].title, 'Highway Star');
    assert.equal(restored1.songs[1].title, 'Born to Run');

    // Verify second playlist
    const restored2 = await playlistAfter.getPlaylist(pl2.id);
    assert.ok(restored2, 'Chill Vibes should be accessible');
    assert.equal(restored2.name, 'Chill Vibes');
    assert.equal(restored2.songs.length, 1);
    assert.equal(restored2.songs[0].title, 'Lofi Beat');
  });
});
