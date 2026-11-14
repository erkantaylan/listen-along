// Automatic "needs replacement" reports (`auto: true`, filed by the web player
// when a song fails to play), against the real server on Postgres
// (testcontainers) with ffmpeg-made fixtures. The server takes nobody's word
// for it (songVerify.js):
//   - accepted only when the file is missing while the storage is healthy, or
//     when ffmpeg cannot decode the file; refused (200 NOT_CONFIRMED, nothing
//     stored) for a good m4a / Ogg Opus file and whenever the storage is not
//     demonstrably there (empty mount, empty mount + one new upload, most
//     files missing)
//   - the file routes answer a missing file with 404 and code FILE_MISSING or
//     STORAGE_UNAVAILABLE by the same health check (always a 404: the Android
//     app skips a song on a 404 and would go offline on a 5xx)
//   - flagged in listings, no reason stored, never replaces the caller's own
//     report, withdrawn like any other; manual reports are unchanged
//   - a per-account rate limit, one decode at a time, admin bulk dismiss
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieFor, adminCookie, startServer, requester } = require('./testServer');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg/ffprobe not available' : false;

const NOT_CONFIRMED = { reported: false, code: 'NOT_CONFIRMED' };

describe('automatic song reports: the server verifies', { skip, timeout: 240_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  let libDir;
  const cookies = {};
  const tok = {};
  const songs = []; // 8 m4a (0..7) then 1 Ogg Opus (8), oldest first
  const paths = [];

  function makeAudio(name, freq, codec = 'aac') {
    const out = path.join(tmp, 'fx', name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=3`, '-c:a', codec, out]);
    return out;
  }
  async function upload(file, title, type = 'audio/mp4') {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
    fd.append('title', title);
    fd.append('artist', 'Tester');
    const res = await fetch(`${srv.base}/api/library/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tok.alice}` }, body: fd });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.song;
  }
  const auto = (i, who) => req('POST', `/api/library/${songs[i].id}/report`, { cookie: cookies[who], body: { auto: true } });
  const mark = (i, who, body) => req('POST', `/api/library/${songs[i].id}/report`, { cookie: cookies[who], body });
  const fileOf = (i, who = 'alice') => req('GET', `/api/library/${songs[i].id}/file`, { cookie: cookies[who] });
  const openRows = async (i) => (await pg.query('SELECT * FROM library_song_reports WHERE song_id = $1 AND resolved_at IS NULL ORDER BY id', [songs[i].id])).rows;
  const hold = (i) => fs.renameSync(paths[i], `${paths[i]}.held`);
  const restore = (i) => fs.renameSync(`${paths[i]}.held`, paths[i]);
  const clearReports = () => pg.query('DELETE FROM library_song_reports');

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_auto').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-auto-'));
    fs.mkdirSync(path.join(tmp, 'fx'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const key of ['alice', 'bob', 'carol', 'dave']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, 'approved', 1) RETURNING id`,
        [key, key[0].toUpperCase() + key.slice(1)]
      );
      cookies[key] = cookieFor(r.rows[0].id);
    }
    const pending = await pg.query(`INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', 'p', 'p', 'pending', 1) RETURNING id`);
    cookies.pending = cookieFor(pending.rows[0].id);
    const t = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'CLI' } });
    tok.alice = t.body.token;
    for (let i = 0; i < 8; i++) songs.push(await upload(makeAudio(`s${i}.m4a`, 300 + i * 50), `Song ${i}`));
    songs.push(await upload(makeAudio('o.opus', 900, 'libopus'), 'Opus', 'audio/ogg'));
    for (const s of songs) paths.push((await pg.query('SELECT file_path FROM library_songs WHERE id = $1', [s.id])).rows[0].file_path);
    libDir = path.dirname(paths[0]);
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('validation and access are as for any report', async () => {
    assert.equal((await mark(0, 'alice', { auto: 'yes' })).status, 400);
    assert.equal((await auto(0, 'pending')).status, 403);
    assert.equal((await req('POST', `/api/library/${songs[0].id}/report`, { body: { auto: true } })).status, 401);
    assert.equal((await req('POST', '/api/library/00000000-0000-4000-8000-000000000000/report', { cookie: cookies.alice, body: { auto: true } })).status, 404);
  });

  it('a good file is not broken, whatever the client says: m4a and Ogg Opus are refused, nothing is stored', async () => {
    for (const i of [0, 8]) {
      const r = await auto(i, 'alice');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, NOT_CONFIRMED, 'exactly this: no reason text goes to the client');
      assert.equal((await openRows(i)).length, 0);
    }
    assert.equal((await req('GET', '/api/library?reported=1', { cookie: cookies.alice })).body.total, 0);
    // A manual report of the same good song is nobody's business but the reporter's.
    assert.equal((await mark(0, 'alice', { reason: 'wrong song' })).status, 201);
    await clearReports();
  });

  it('a file that does not decode is confirmed: garbage bytes, and a damaged middle', async () => {
    const keep = [fs.readFileSync(paths[1]), fs.readFileSync(paths[2])];
    try {
      fs.writeFileSync(paths[1], crypto.randomBytes(40000));
      const damaged = Buffer.from(keep[1]);
      crypto.randomFillSync(damaged, Math.floor(damaged.length / 3), Math.floor(damaged.length / 3));
      fs.writeFileSync(paths[2], damaged);
      for (const i of [1, 2]) {
        const r = await auto(i, 'alice');
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.report.auto, true);
        assert.equal(r.body.report.mine, true);
        assert.equal(r.body.song.report_count, 1);
      }
    } finally {
      fs.writeFileSync(paths[1], keep[0]);
      fs.writeFileSync(paths[2], keep[1]);
    }
    await clearReports();
  });

  it('a missing file while the other files are there is confirmed', async () => {
    hold(3);
    try {
      const f = await fileOf(3);
      assert.equal(f.status, 404);
      assert.equal(f.body.code, 'FILE_MISSING');
      // A reason sent along is not stored: the flag says what happened.
      const r = await req('POST', `/api/library/${songs[3].id}/report`, { cookie: cookies.alice, body: { auto: true, reason: 'made up' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.report.auto, true);
      assert.equal(r.body.report.reason, null);
      // Again: the same report comes back, nothing is added.
      const again = await auto(3, 'alice');
      assert.equal(again.status, 200);
      assert.equal(again.body.report.auto, true);
      let rows = await openRows(3);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].auto, true);

      // Listings carry the flag; a person's report says auto: false.
      await mark(3, 'bob', { reason: 'cut off' });
      const list = await req('GET', '/api/library?reported=1', { cookie: cookies.carol });
      const s = list.body.songs.find((x) => x.id === songs[3].id);
      assert.deepEqual(s.reports.map((x) => [x.reported_by, x.auto, x.reason]), [['Alice', true, null], ['Bob', false, 'cut off']]);
      // It never replaces a report the user already filed by hand...
      const kept = await auto(3, 'bob');
      assert.equal(kept.status, 200);
      assert.equal(kept.body.report.auto, false);
      assert.equal(kept.body.report.reason, 'cut off');
      // ...and reporting by hand afterwards makes an automatic one theirs.
      const mine = await mark(3, 'alice', { reason: 'really broken' });
      assert.equal(mine.body.report.auto, false);
      rows = await openRows(3);
      assert.deepEqual(rows.map((x) => [x.auto, x.reason]), [[false, 'really broken'], [false, 'cut off']]);

      // Withdrawn like any other.
      assert.equal((await auto(3, 'carol')).status, 201);
      assert.equal((await req('DELETE', `/api/library/${songs[3].id}/report`, { cookie: cookies.carol })).status, 200);
      assert.equal((await openRows(3)).length, 2);
    } finally {
      restore(3);
    }
    await clearReports();
  });

  it('an empty mount: STORAGE_UNAVAILABLE for every song, and no automatic report', async () => {
    const away = `${libDir}.away`;
    fs.renameSync(libDir, away);
    fs.mkdirSync(libDir);
    try {
      for (const i of [4, 8]) {
        const f = await fileOf(i);
        assert.equal(f.status, 404);
        assert.equal(f.body.code, 'STORAGE_UNAVAILABLE');
        assert.deepEqual((await auto(i, 'alice')).body, NOT_CONFIRMED);
      }

      // One upload lands on the empty mount: the folder is no longer empty, the
      // new song is really served, and the old ones are still not "broken".
      const fresh = await upload(makeAudio('fresh.m4a', 1500), 'Fresh');
      assert.equal((await req('GET', `/api/library/${fresh.id}/file`, { cookie: cookies.alice })).status, 200);
      for (const i of [5, 0, 7]) {
        const f = await fileOf(i);
        assert.equal(f.status, 404, `song ${i}`);
        assert.equal(f.body.code, 'STORAGE_UNAVAILABLE');
        assert.deepEqual((await auto(i, 'bob')).body, NOT_CONFIRMED, `song ${i}`);
      }
      assert.equal((await req('GET', '/api/library?reported=1', { cookie: cookies.alice })).body.total, 0);
      for (const name of fs.readdirSync(libDir)) fs.renameSync(path.join(libDir, name), path.join(away, name));
    } finally {
      fs.rmSync(libDir, { recursive: true, force: true });
      fs.renameSync(away, libDir);
    }
    assert.equal((await fileOf(6)).status, 200);
  });

  it('a half-restored library (most files missing): not confirmed', async () => {
    const gone = [0, 1, 2, 3, 4, 5]; // 6 and 7, the Opus one and the fresh upload remain
    gone.forEach(hold);
    try {
      assert.deepEqual((await auto(1, 'carol')).body, NOT_CONFIRMED);
      const f = await fileOf(2, 'carol');
      assert.equal(f.status, 404);
      assert.equal(f.body.code, 'STORAGE_UNAVAILABLE');
    } finally {
      gone.forEach(restore);
    }
    assert.equal((await req('GET', '/api/library?reported=1', { cookie: cookies.alice })).body.total, 0);
  });

  it('admin: dismiss every automatic report at once, and only those', async () => {
    hold(6);
    try {
      assert.equal((await auto(6, 'alice')).status, 201);
      assert.equal((await auto(6, 'bob')).status, 201);
    } finally {
      restore(6);
    }
    hold(7);
    try {
      assert.equal((await auto(7, 'alice')).status, 201);
    } finally {
      restore(7);
    }
    assert.equal((await mark(7, 'carol', { reason: 'bad audio' })).status, 201);
    const url = '/api/admin/library/reports/dismiss-automatic';
    assert.equal((await req('POST', url, { cookie: cookies.alice })).status, 401);
    const r = await req('POST', url, { cookie: adminCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.dismissed, 3);
    assert.equal((await openRows(6)).length, 0);
    assert.deepEqual((await openRows(7)).map((x) => x.reason), ['bad audio']);
    const rows = (await pg.query(`SELECT resolution, resolved_by FROM library_song_reports WHERE auto`)).rows;
    assert.ok(rows.length === 3 && rows.every((x) => x.resolution === 'dismissed' && x.resolved_by === 'admin'));
    assert.equal((await req('POST', url, { cookie: adminCookie() })).body.dismissed, 0);
    await clearReports();
  });

  it('a report the caller already has is returned as it is: nothing is verified or inserted, even for a good file', async () => {
    assert.equal((await mark(0, 'bob', { reason: 'wrong song' })).status, 201);
    const r = await auto(0, 'bob');
    assert.equal(r.status, 200);
    assert.equal(r.body.report.auto, false);
    assert.equal(r.body.report.reason, 'wrong song');
    const rows = await openRows(0);
    assert.deepEqual(rows.map((x) => [x.auto, x.reason]), [[false, 'wrong song']]);
    // Withdrawn: the next automatic one is verified like any other (a good file: refused).
    assert.equal((await req('DELETE', `/api/library/${songs[0].id}/report`, { cookie: cookies.bob })).status, 200);
    assert.deepEqual((await auto(0, 'bob')).body, NOT_CONFIRMED);
    assert.equal((await openRows(0)).length, 0);
  });

  it('the report is stored only while the song still has the file that was checked', async () => {
    // In-process, on the same database: the insert itself, with a verdict about another file.
    process.env.DATABASE_URL = container.getConnectionUri();
    const db = require('./db');
    assert.ok(await db.init());
    try {
      const songReports = require('./songReports');
      const actor = { userId: (await pg.query(`SELECT id FROM users WHERE provider_id = 'carol'`)).rows[0].id, name: 'Carol' };
      // The song was replaced between the check and the insert: its row has another file now.
      assert.equal(await songReports.reportVerified(songs[4].id, actor, `${paths[4]}.old`), null);
      assert.equal((await openRows(4)).length, 0);
      const stored = await songReports.reportVerified(songs[4].id, actor, paths[4]);
      assert.equal(stored.auto, true);
      assert.equal(await songReports.reportVerified(songs[4].id, actor, paths[4]), null, 'the caller has one already: nothing inserted');
      assert.equal((await openRows(4)).length, 1);
      await assert.rejects(() => songReports.reportVerified(songs[4].id, actor), /verified file path/);
    } finally {
      await db.close();
      delete process.env.DATABASE_URL;
    }
    await clearReports();
  });

  describe('with a slow decoder that blames every file', () => {
    // A stand-in for ffmpeg: takes a while, then fails the way a corrupt file does.
    let slow;
    let sreq;
    before(async () => {
      const fake = path.join(tmp, 'slow-bad-ffmpeg.sh');
      fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.8\necho "Error opening input: Invalid data found when processing input" >&2\nexit 1\n', { mode: 0o755 });
      slow = await startServer({ DATABASE_URL: container.getConnectionUri(), SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'), VERIFY_FFMPEG: fake });
      sreq = requester(slow.base);
    });
    after(async () => { if (slow) await slow.stop(); });

    it('the song is replaced while its file is being checked: no report lands on the new file', async () => {
      const pending = sreq('POST', `/api/library/${songs[5].id}/report`, { cookie: cookies.alice, body: { auto: true } });
      await new Promise((r) => setTimeout(r, 200));
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(makeAudio('five-new.m4a', 1900))], { type: 'audio/mp4' }), 'five-new.m4a');
      fd.append('title', 'Song 5');
      fd.append('artist', 'Tester');
      const rep = await fetch(`${srv.base}/api/library/${songs[5].id}/replace`, { method: 'POST', headers: { Authorization: `Bearer ${tok.alice}` }, body: fd });
      assert.equal(rep.status, 200);
      assert.equal(fs.existsSync(paths[5]), false, 'the old file is gone, as after every replace');
      const r = await pending;
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, NOT_CONFIRMED);
      assert.equal((await openRows(5)).length, 0);
      paths[5] = (await pg.query('SELECT file_path FROM library_songs WHERE id = $1', [songs[5].id])).rows[0].file_path;
    });

    it('a burst: one check at a time, a short line, the rest are turned away (never "broken")', async () => {
      const targets = [0, 1, 2, 3, 4, 6, 7, 8];
      const out = await Promise.all(targets.map((i) => sreq('POST', `/api/library/${songs[i].id}/report`, { cookie: cookies.carol, body: { auto: true } })));
      const stored = out.filter((r) => r.status === 201).length;
      const turnedAway = out.filter((r) => r.status === 200 && r.body.reported === false);
      assert.equal(stored + turnedAway.length, targets.length);
      assert.ok(stored >= 1 && stored <= 4, `checked ${stored}`);
      // A refusal says nothing about why.
      for (const r of turnedAway) assert.deepEqual(Object.keys(r.body).sort(), ['code', 'reported']);
      await clearReports();
    });
  });

  it('rate limit: automatic reports per account are limited; manual ones are not touched by it', async () => {
    let limited = null;
    for (let n = 1; n <= 25 && limited === null; n++) {
      const r = await auto(0, 'dave');
      if (r.status === 429) limited = n;
      else assert.deepEqual(r.body, NOT_CONFIRMED);
    }
    assert.equal(limited, 21, 'the 21st within the window is refused');
    assert.equal((await mark(0, 'dave', { reason: 'by hand' })).status, 201);
    assert.equal((await auto(0, 'carol')).status, 200, 'another account is not affected');
    await clearReports();
  });
});
