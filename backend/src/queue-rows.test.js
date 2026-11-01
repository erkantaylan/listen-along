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

describe('dragged column widths (frontend/layout-rules.js)', () => {
  let f;
  before(async () => { f = await frontend('layout-rules.js'); });

  it('never dragged: the automatic widths, at every size', () => {
    for (let width = 768; width <= 2000; width += 1) {
      for (const chatDocked of [false, true]) {
        for (const pref of [null, 'rail', 'expanded']) {
          const c = f.resolveColumns({ width, pref, chatDocked });
          const docked = chatDocked && width >= 1010;
          const right = docked ? (width >= 1200 ? 320 : 280) : width >= 1010 ? 56 : 0;
          const rail = pref === 'rail' || (pref !== 'expanded' && width - 264 - right < 616);
          assert.equal(c.rail, rail, `${width} ${chatDocked} ${pref}`);
          assert.equal(c.left, rail ? 72 : width >= 1440 ? 304 : 264, `${width} ${chatDocked} ${pref}`);
          assert.equal(c.right, docked ? right : null);
        }
      }
    }
  });

  it('clamps what applies, never below the floor, and the wish comes back with room', () => {
    for (let width = 1010; width <= 2000; width += 1) {
      for (const pref of [null, 'rail', 'expanded']) {
        const c = f.resolveColumns({ width, pref, chatDocked: true, left: 420, right: 420 });
        assert.ok(c.main >= f.MAIN_FLOOR, `${width} ${pref}: ${c.main}`);
        assert.ok(c.right >= f.CHAT_MIN && c.right <= f.CHAT_MAX);
        assert.ok(c.rail ? c.left === 72 : c.left >= f.SIDEBAR_MIN && c.left <= f.SIDEBAR_MAX);
      }
    }
    const wish = { pref: 'expanded', chatDocked: true, left: 400, right: 400 };
    const small = f.resolveColumns({ width: 1010, ...wish });
    assert.deepEqual([small.left, small.right, small.main], [200, 394, 416]);
    const big = f.resolveColumns({ width: 1920, ...wish });
    assert.deepEqual([big.left, big.right], [400, 400]);
  });

  it('automatic: a dragged sidebar shrinks to the comfortable page, then rails', () => {
    const at = (width) => f.resolveColumns({ width, chatDocked: true, left: 400 });
    assert.deepEqual([at(1400).rail, at(1400).left, at(1400).main], [false, 400, 680]);
    assert.deepEqual([at(1200).rail, at(1200).left, at(1200).main], [false, 264, 616]);
    assert.equal(at(1096).rail, false); // 1096 - 280 - 616 = 200
    assert.equal(at(1095).rail, true);
  });

  it('a wide chat alone follows the same automatic rule', () => {
    assert.equal(f.resolveColumns({ width: 1300, chatDocked: true, right: 420 }).rail, false);
    assert.equal(f.resolveColumns({ width: 1299, chatDocked: true, right: 420 }).rail, true);
  });

  it('no sidebar on the page: the chat takes its wish', () => {
    const c = f.resolveColumns({ width: 1010, chatDocked: true, hasSidebar: false, right: 420 });
    assert.deepEqual([c.left, c.right, c.main], [null, 420, 590]);
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
