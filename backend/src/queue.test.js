const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Queue, getQueue, deleteQueue, hasQueue } = require('./queue');

describe('Queue class', () => {
  let queue;

  beforeEach(() => {
    queue = new Queue('test-lobby');
  });

  test('addSong adds a song with generated id', () => {
    const song = queue.addSong({
      url: 'https://youtube.com/watch?v=abc123',
      title: 'Test Song',
      duration: 180,
      addedBy: 'user1'
    });

    assert.ok(song.id);
    assert.strictEqual(song.url, 'https://youtube.com/watch?v=abc123');
    assert.strictEqual(song.title, 'Test Song');
    assert.strictEqual(song.duration, 180);
    assert.strictEqual(song.addedBy, 'user1');
    assert.ok(song.addedAt);
  });

  test('addSong uses defaults for missing fields', () => {
    const song = queue.addSong({ url: 'https://youtube.com/watch?v=xyz' });

    assert.strictEqual(song.title, 'Unknown');
    assert.strictEqual(song.duration, 0);
    assert.strictEqual(song.addedBy, 'anonymous');
  });

  test('getSongs returns all songs in order', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });

    const songs = queue.getSongs();
    assert.strictEqual(songs.length, 3);
    assert.strictEqual(songs[0].title, 'Song 1');
    assert.strictEqual(songs[1].title, 'Song 2');
    assert.strictEqual(songs[2].title, 'Song 3');
  });

  test('getSongs returns a copy', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    const songs = queue.getSongs();
    songs.push({ fake: true });
    assert.strictEqual(queue.getSongs().length, 1);
  });

  test('removeSong removes song by id', () => {
    const song1 = queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });

    const removed = queue.removeSong(song1.id);
    assert.strictEqual(removed.title, 'Song 1');
    assert.strictEqual(queue.getSongs().length, 1);
    assert.strictEqual(queue.getSongs()[0].title, 'Song 2');
  });

  test('removeSong returns null for non-existent id', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    const removed = queue.removeSong('non-existent-id');
    assert.strictEqual(removed, null);
    assert.strictEqual(queue.getSongs().length, 1);
  });

  test('reorderSong moves song to new position', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    const song2 = queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });

    const success = queue.reorderSong(song2.id, 0);
    assert.strictEqual(success, true);

    const songs = queue.getSongs();
    assert.strictEqual(songs[0].title, 'Song 2');
    assert.strictEqual(songs[1].title, 'Song 1');
    assert.strictEqual(songs[2].title, 'Song 3');
  });

  test('reorderSong returns false for invalid index', () => {
    const song = queue.addSong({ url: 'url1', title: 'Song 1' });

    assert.strictEqual(queue.reorderSong(song.id, -1), false);
    assert.strictEqual(queue.reorderSong(song.id, 5), false);
  });

  test('reorderSong returns false for non-existent song', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    assert.strictEqual(queue.reorderSong('fake-id', 0), false);
  });

  test('getCurrentSong returns first song', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });

    const current = queue.getCurrentSong();
    assert.strictEqual(current.title, 'Song 1');
  });

  test('getCurrentSong returns null for empty queue', () => {
    assert.strictEqual(queue.getCurrentSong(), null);
  });

  test('advanceQueue removes and returns first song', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });

    const advanced = queue.advanceQueue();
    assert.strictEqual(advanced.title, 'Song 1');
    assert.strictEqual(queue.getSongs().length, 1);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 2');
  });

  test('advanceQueue returns null for empty queue', () => {
    assert.strictEqual(queue.advanceQueue(), null);
  });

  test('clear removes all songs', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });

    queue.clear();
    assert.strictEqual(queue.getSongs().length, 0);
  });

  test('moveCurrentToEnd moves first song to end', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });

    const moved = queue.moveCurrentToEnd();

    assert.strictEqual(moved.title, 'Song 1');
    const songs = queue.getSongs();
    assert.strictEqual(songs.length, 3);
    assert.strictEqual(songs[0].title, 'Song 2');
    assert.strictEqual(songs[1].title, 'Song 3');
    assert.strictEqual(songs[2].title, 'Song 1');
  });

  test('moveCurrentToEnd returns null for empty queue', () => {
    assert.strictEqual(queue.moveCurrentToEnd(), null);
  });

  test('moveCurrentToEnd works with single song queue', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });

    const moved = queue.moveCurrentToEnd();

    assert.strictEqual(moved.title, 'Song 1');
    assert.strictEqual(queue.getSongs().length, 1);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 1');
  });
});

describe('Queue store functions', () => {
  beforeEach(() => {
    // Clean up any existing queues
    deleteQueue('lobby-a');
    deleteQueue('lobby-b');
  });

  test('getQueue creates queue for new lobby', () => {
    const queue = getQueue('lobby-a');
    assert.ok(queue instanceof Queue);
    assert.strictEqual(queue.lobbyId, 'lobby-a');
  });

  test('getQueue returns same queue for same lobby', () => {
    const queue1 = getQueue('lobby-a');
    queue1.addSong({ url: 'url1', title: 'Song 1' });

    const queue2 = getQueue('lobby-a');
    assert.strictEqual(queue2.getSongs().length, 1);
  });

  test('getQueue returns different queues for different lobbies', () => {
    const queueA = getQueue('lobby-a');
    const queueB = getQueue('lobby-b');

    queueA.addSong({ url: 'url1', title: 'Song A' });
    queueB.addSong({ url: 'url2', title: 'Song B' });

    assert.strictEqual(queueA.getSongs()[0].title, 'Song A');
    assert.strictEqual(queueB.getSongs()[0].title, 'Song B');
  });

  test('hasQueue returns true for existing queue', () => {
    getQueue('lobby-a');
    assert.strictEqual(hasQueue('lobby-a'), true);
  });

  test('hasQueue returns false for non-existent queue', () => {
    assert.strictEqual(hasQueue('non-existent'), false);
  });

  test('deleteQueue removes queue', () => {
    getQueue('lobby-a');
    deleteQueue('lobby-a');
    assert.strictEqual(hasQueue('lobby-a'), false);
  });
});
