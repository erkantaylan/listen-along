const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Queue, getQueue, deleteQueue, hasQueue, cleanupOrphanedQueues } = require('./queue');

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

  test('removeSong adjusts currentIndex when removing before cursor', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    const song3 = queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(2); // pointing at Song 3

    const song1 = queue.getSongs()[0];
    queue.removeSong(song1.id); // remove Song 1 (before cursor)

    assert.strictEqual(queue.getCurrentIndex(), 1); // cursor adjusted down
    assert.strictEqual(queue.getCurrentSong().title, 'Song 3'); // still points to same song
  });

  test('removeSong adjusts currentIndex when removing at cursor', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(1); // pointing at Song 2

    const song2 = queue.getSongs()[1];
    queue.removeSong(song2.id); // remove Song 2 (at cursor)

    // Cursor stays at 1, now points to Song 3
    assert.strictEqual(queue.getCurrentIndex(), 1);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 3');
  });

  test('removeSong resets cursor when last song removed', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.setCurrentIndex(0);

    const song1 = queue.getSongs()[0];
    queue.removeSong(song1.id);

    assert.strictEqual(queue.getCurrentIndex(), -1);
    assert.strictEqual(queue.getCurrentSong(), null);
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

  test('reorderSong adjusts cursor to track current song', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(0); // pointing at Song 1

    const song3 = queue.getSongs()[2];
    queue.reorderSong(song3.id, 0); // move Song 3 to position 0

    // Song 1 was at 0, Song 3 moved from 2 to 0, so Song 1 shifts to 1
    assert.strictEqual(queue.getCurrentIndex(), 1);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 1');
  });

  test('getCurrentSong returns song at cursor', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1);

    const current = queue.getCurrentSong();
    assert.strictEqual(current.title, 'Song 2');
  });

  test('getCurrentSong returns first song when cursor not initialized', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });

    // currentIndex is -1 (default)
    const current = queue.getCurrentSong();
    assert.strictEqual(current.title, 'Song 1');
  });

  test('getCurrentSong returns null for empty queue', () => {
    assert.strictEqual(queue.getCurrentSong(), null);
  });

  test('getCurrentIndex returns -1 initially', () => {
    assert.strictEqual(queue.getCurrentIndex(), -1);
  });

  test('setCurrentIndex sets explicit index', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1);
    assert.strictEqual(queue.getCurrentIndex(), 1);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 2');
  });

  test('advanceToNext moves cursor forward', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(0);

    const next = queue.advanceToNext('off');
    assert.strictEqual(next.title, 'Song 2');
    assert.strictEqual(queue.getCurrentIndex(), 1);
  });

  test('advanceToNext returns null at end with repeat off', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1);

    const next = queue.advanceToNext('off');
    assert.strictEqual(next, null);
    assert.strictEqual(queue.getCurrentIndex(), 1); // cursor unchanged
  });

  test('advanceToNext wraps with repeat all', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1);

    const next = queue.advanceToNext('all');
    assert.strictEqual(next.title, 'Song 1');
    assert.strictEqual(queue.getCurrentIndex(), 0);
  });

  test('advanceToNext returns null for empty queue', () => {
    assert.strictEqual(queue.advanceToNext('off'), null);
    assert.strictEqual(queue.advanceToNext('all'), null);
  });

  test('goToPrevious moves cursor backward', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(2);

    const prev = queue.goToPrevious('off');
    assert.strictEqual(prev.title, 'Song 2');
    assert.strictEqual(queue.getCurrentIndex(), 1);
  });

  test('goToPrevious clamps at 0 with repeat off', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(0);

    const prev = queue.goToPrevious('off');
    assert.strictEqual(prev.title, 'Song 1');
    assert.strictEqual(queue.getCurrentIndex(), 0);
  });

  test('goToPrevious wraps with repeat all', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.setCurrentIndex(0);

    const prev = queue.goToPrevious('all');
    assert.strictEqual(prev.title, 'Song 3');
    assert.strictEqual(queue.getCurrentIndex(), 2);
  });

  test('goToPrevious returns null for empty queue', () => {
    assert.strictEqual(queue.goToPrevious('off'), null);
  });

  test('shuffleUpcoming shuffles only songs after cursor', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
    queue.addSong({ url: 'url4', title: 'Song 4' });
    queue.addSong({ url: 'url5', title: 'Song 5' });
    queue.setCurrentIndex(1); // Song 2 is current

    queue.shuffleUpcoming();

    const songs = queue.getSongs();
    // Songs 1 and 2 should be unchanged
    assert.strictEqual(songs[0].title, 'Song 1');
    assert.strictEqual(songs[1].title, 'Song 2');
    // Queue still has 5 songs
    assert.strictEqual(songs.length, 5);
    // currentIndex unchanged
    assert.strictEqual(queue.getCurrentIndex(), 1);
  });

  test('shuffleUpcoming does nothing when at end of queue', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1); // Last song

    queue.shuffleUpcoming();

    const songs = queue.getSongs();
    assert.strictEqual(songs[0].title, 'Song 1');
    assert.strictEqual(songs[1].title, 'Song 2');
  });

  test('advanceQueue advances cursor (legacy compatibility)', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(0);

    const finished = queue.advanceQueue();
    assert.strictEqual(finished.title, 'Song 1'); // returns the song that was playing
    assert.strictEqual(queue.getSongs().length, 2); // songs NOT removed
  });

  test('moveCurrentToEnd returns current song (legacy compatibility)', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(0);

    const moved = queue.moveCurrentToEnd();
    assert.strictEqual(moved.title, 'Song 1');
    assert.strictEqual(queue.getSongs().length, 2); // songs NOT modified
  });

  test('clear removes all songs and resets cursor', () => {
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.setCurrentIndex(1);

    queue.clear();
    assert.strictEqual(queue.getSongs().length, 0);
    assert.strictEqual(queue.getCurrentIndex(), -1);
  });

  test('moveCurrentToEnd returns null for empty queue', () => {
    assert.strictEqual(queue.moveCurrentToEnd(), null);
  });
});

describe('Queue per-user position tracking (independent mode)', () => {
  let queue;

  beforeEach(() => {
    queue = new Queue('test-lobby');
    queue.addSong({ url: 'url1', title: 'Song 1' });
    queue.addSong({ url: 'url2', title: 'Song 2' });
    queue.addSong({ url: 'url3', title: 'Song 3' });
  });

  test('getUserPosition returns 0 for new user', () => {
    assert.strictEqual(queue.getUserPosition('user-a'), 0);
  });

  test('getUserCurrentSong returns first song for new user', () => {
    assert.strictEqual(queue.getUserCurrentSong('user-a').title, 'Song 1');
  });

  test('advanceUserPosition moves to next song', () => {
    const next = queue.advanceUserPosition('user-a');
    assert.strictEqual(next.title, 'Song 2');
    assert.strictEqual(queue.getUserPosition('user-a'), 1);
  });

  test('advanceUserPosition returns null at end of queue', () => {
    queue.advanceUserPosition('user-a'); // -> Song 2
    queue.advanceUserPosition('user-a'); // -> Song 3
    const result = queue.advanceUserPosition('user-a'); // past end
    assert.strictEqual(result, null);
  });

  test('advanceUserPosition does not modify shared queue', () => {
    queue.advanceUserPosition('user-a');
    queue.advanceUserPosition('user-a');
    assert.strictEqual(queue.getSongs().length, 3);
    assert.strictEqual(queue.getCurrentSong().title, 'Song 1');
  });

  test('different users track independent positions', () => {
    queue.advanceUserPosition('user-a'); // user-a at index 1
    queue.advanceUserPosition('user-a'); // user-a at index 2

    assert.strictEqual(queue.getUserCurrentSong('user-a').title, 'Song 3');
    assert.strictEqual(queue.getUserCurrentSong('user-b').title, 'Song 1');
  });

  test('setUserPosition sets explicit index', () => {
    queue.setUserPosition('user-a', 2);
    assert.strictEqual(queue.getUserCurrentSong('user-a').title, 'Song 3');
  });

  test('getSongAtIndex returns song at given index', () => {
    assert.strictEqual(queue.getSongAtIndex(0).title, 'Song 1');
    assert.strictEqual(queue.getSongAtIndex(2).title, 'Song 3');
    assert.strictEqual(queue.getSongAtIndex(5), null);
  });

  test('removeUserPosition cleans up tracking', () => {
    queue.advanceUserPosition('user-a');
    queue.removeUserPosition('user-a');
    assert.strictEqual(queue.getUserPosition('user-a'), 0);
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

  test('cleanupOrphanedQueues removes queues not in valid set', () => {
    getQueue('lobby-a');
    getQueue('lobby-b');
    getQueue('lobby-c');

    // Only lobby-a is valid; lobby-b and lobby-c are orphaned
    cleanupOrphanedQueues(new Set(['lobby-a']));

    assert.strictEqual(hasQueue('lobby-a'), true, 'valid queue should remain');
    assert.strictEqual(hasQueue('lobby-b'), false, 'orphaned queue should be removed');
    assert.strictEqual(hasQueue('lobby-c'), false, 'orphaned queue should be removed');
  });

  test('cleanupOrphanedQueues with empty valid set removes all', () => {
    getQueue('lobby-a');
    getQueue('lobby-b');

    cleanupOrphanedQueues(new Set());

    assert.strictEqual(hasQueue('lobby-a'), false);
    assert.strictEqual(hasQueue('lobby-b'), false);
  });
});
