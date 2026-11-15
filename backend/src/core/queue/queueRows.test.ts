// What playlist rows are built from: the queue entry's additive artistName (the
// pure helpers: frontend/src/features/queue/queue-format.test.ts, the rail avatars:
// frontend/src/features/playlists/playlist-filter.test.ts, layout-rules:
// frontend/src/shared/layout-rules.test.ts).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../../shared/db.ts';
import { library } from '../library/index.ts';
import { Queue } from './index.ts';

// A stand-in for db.query: answers the rows the test hands it.
type FakeQuery = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
const fakeQuery = (fn: FakeQuery) => fn as unknown as typeof db.query;

describe('queue entry artistName', () => {
  const realAvailable = db.isAvailable;
  const realQuery = db.query;
  after(() => { db.isAvailable = realAvailable; db.query = realQuery; });

  it('is additive: the combined title the CLI and the app read stays as it was', () => {
    const song = { id: 'abc', youtube_id: null, title: 'Şarkı', artist: 'Ayşe', duration_sec: 10 };
    assert.deepEqual(library.toQueueEntry(song), { url: 'library:abc', title: 'Şarkı - Ayşe', duration: 10, thumbnail: null });
    assert.equal(library.queueArtist(song), 'Ayşe');
    assert.equal(library.queueArtist({ artist: 'Unknown' }), null);
    assert.equal(library.queueArtist({ artist: null as unknown as string }), null); // a NULL column
  });

  it('follows a replace, and defaults to null', () => {
    const q = new Queue('t1');
    const entry = q.addSong({ url: 'library:x', title: 'A - B', artistName: 'B' });
    assert.equal(entry.artistName, 'B');
    assert.equal(q.addSong({ url: 'library:y', title: 'C' }).artistName, null);
    q.updateSong(entry.id, { title: 'A - D', artistName: 'D' });
    assert.equal(q.getSongs()[0].artistName, 'D');
    q.updateSong(entry.id, { title: 'A2' }); // a caller that does not know it leaves it
    assert.equal(q.getSongs()[0].artistName, 'D');
  });

  it('comes from the library after a restart, by library id or YouTube id; others stay null', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    db.isAvailable = () => true;
    db.query = fakeQuery(async (sql) => {
      if (/FROM queue_songs/.test(sql)) {
        return { rows: [
          { id: 'e1', url: `library:${uuid}`, title: 'A - Ayşe', duration: 1, added_by: 'Ayşe', thumbnail: null, added_at: '5' },
          { id: 'e2', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'B - Rick', duration: 2, added_by: 'anonymous', thumbnail: null, added_at: '6' },
          { id: 'e3', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Requested - thing', duration: 3, added_by: 'x', thumbnail: null, added_at: '7' },
        ] };
      }
      assert.match(sql, /FROM library_songs/);
      return { rows: [
        { id: uuid, youtube_id: null, artist: 'Ayşe' },
        { id: '22222222-2222-4222-8222-222222222222', youtube_id: 'dQw4w9WgXcQ', artist: 'Rick' },
      ] };
    });
    const q = new Queue('t2');
    await q.loadFromDB();
    assert.deepEqual(q.getSongs().map(s => s.artistName), ['Ayşe', 'Rick', null]);
    assert.equal(q.getSongs()[0].addedAt, 5);
  });

  it('a failed artist lookup does not lose the queue', async () => {
    db.isAvailable = () => true;
    db.query = fakeQuery(async (sql) => {
      if (/FROM queue_songs/.test(sql)) return { rows: [{ id: 'e1', url: 'library:11111111-1111-4111-8111-111111111111', title: 'A', duration: 1, added_by: 'x', thumbnail: null, added_at: '5' }] };
      throw new Error('boom');
    });
    const q = new Queue('t3');
    await q.loadFromDB();
    assert.equal(q.getSongs().length, 1);
  });
});
