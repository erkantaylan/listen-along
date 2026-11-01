// What playlist rows are built from: the queue entry's additive artistName, and
// the pure helpers in frontend/queue-format.js and frontend/layout-rules.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const db = require('./db');
const library = require('./library');
const { Queue } = require('./queue');

const frontend = (file) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', file)).href);

describe('queue entry artistName', () => {
  const realAvailable = db.isAvailable;
  const realQuery = db.query;
  after(() => { db.isAvailable = realAvailable; db.query = realQuery; });

  it('is additive: the combined title the CLI and the app read stays as it was', () => {
    const song = { id: 'abc', youtube_id: null, title: 'Şarkı', artist: 'Ayşe', duration_sec: 10 };
    assert.deepEqual(library.toQueueEntry(song), { url: 'library:abc', title: 'Şarkı - Ayşe', duration: 10, thumbnail: null });
    assert.equal(library.queueArtist(song), 'Ayşe');
    assert.equal(library.queueArtist({ artist: 'Unknown' }), null);
    assert.equal(library.queueArtist({ artist: null }), null);
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
    db.query = async (sql) => {
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
    };
    const q = new Queue('t2');
    await q.loadFromDB();
    assert.deepEqual(q.getSongs().map(s => s.artistName), ['Ayşe', 'Rick', null]);
    assert.equal(q.getSongs()[0].addedAt, 5);
  });

  it('a failed artist lookup does not lose the queue', async () => {
    db.isAvailable = () => true;
    db.query = async (sql) => {
      if (/FROM queue_songs/.test(sql)) return { rows: [{ id: 'e1', url: 'library:11111111-1111-4111-8111-111111111111', title: 'A', duration: 1, added_by: 'x', thumbnail: null, added_at: '5' }] };
      throw new Error('boom');
    };
    const q = new Queue('t3');
    await q.loadFromDB();
    assert.equal(q.getSongs().length, 1);
  });
});

describe('row text (frontend/queue-format.js)', () => {
  let f;
  before(async () => { f = await frontend('queue-format.js'); });

  it('splits only on the known artist, never guessing at " - "', () => {
    assert.deepEqual(f.songParts({ title: 'Yağmur - Live - Ayşe', artistName: 'Ayşe' }), { title: 'Yağmur - Live', artist: 'Ayşe' });
    assert.deepEqual(f.songParts({ title: 'Queen - Bohemian', artistName: null }), { title: 'Queen - Bohemian', artist: '' });
    assert.deepEqual(f.songParts({ title: 'Renamed', artistName: 'Ayşe' }), { title: 'Renamed', artist: 'Ayşe' });
    assert.deepEqual(f.songParts({ title: ' - Ayşe', artistName: 'Ayşe' }), { title: ' - Ayşe', artist: 'Ayşe' });
  });

  it('leaves the placeholder name and missing dates blank', () => {
    assert.equal(f.addedByLabel('anonymous'), '');
    assert.equal(f.addedByLabel('Anonymous'), '');
    assert.equal(f.addedByLabel(null), '');
    assert.equal(f.addedByLabel(' Ayşe '), 'Ayşe');
    for (const bad of [null, undefined, 0, NaN, 'x']) assert.equal(f.addedDateLabel(bad, 'en'), '');
    assert.match(f.addedDateLabel(Date.UTC(2026, 5, 15, 12), 'en'), /2026/);
  });
});

describe('library rail rule (frontend/layout-rules.js)', () => {
  let f;
  before(async () => { f = await frontend('layout-rules.js'); });

  it('collapses the library before the chat, automatically', () => {
    const rail = (width, chatDocked) => f.sidebarRail({ width, chatDocked });
    assert.equal(rail(767, false), false, 'drawer, not a rail');
    assert.equal(rail(768, false), true);
    assert.equal(rail(879, false), true);
    assert.equal(rail(880, false), false);
    assert.equal(rail(1010, true), true);
    assert.equal(rail(1159, true), true);
    assert.equal(rail(1160, true), false);
    assert.equal(rail(1200, true), false);
    assert.equal(rail(1010, false), false, 'chat closed: room again');
  });

  it("the user's choice wins, and is never a rail on phones", () => {
    assert.equal(f.sidebarRail({ width: 1920, pref: 'rail', chatDocked: true }), true);
    assert.equal(f.sidebarRail({ width: 1010, pref: 'expanded', chatDocked: true }), false);
    assert.equal(f.sidebarRail({ width: 500, pref: 'rail' }), false);
  });
});

describe('rail avatars (playlistInitials)', () => {
  let f;
  before(async () => { f = await frontend('playlist-filter.js'); });

  it('takes two whole letters, Turkish capitals', () => {
    assert.equal(f.playlistInitials('istanbul şarkıları'), 'İŞ');
    assert.equal(f.playlistInitials('ılık çay ve üç kişi'), 'IÇ');
    assert.equal(f.playlistInitials('  Yol  '), 'Y');
    assert.equal(f.playlistInitials('🎸 rock'), '🎸R');
    assert.equal(f.playlistInitials(''), '?');
    assert.equal(f.playlistInitials(null), '?');
  });
});
