// "Mark as broken — needs replacement" reports, against the real server on
// Postgres (testcontainers) with ffmpeg-made fixtures:
//   - POST/DELETE /api/library/:id/report: approved users (web or token),
//     one open report per user per song (re-marking updates the reason),
//     only your own report can be withdrawn
//   - GET /api/library?reported=1 lists reported songs with their reports;
//     every song carries reports + report_count
//   - replacing the audio resolves every open report ('replaced', by the replacer)
//   - admins dismiss reports (admin cookie only)
//   - pending / denied users, revoked tokens and nobody are refused
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

describe('library song reports (mark as broken)', { skip, timeout: 240_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  const ids = {};
  const cookies = {};
  const tok = {};
  const fx = {};
  const songs = {};

  function makeAudio(name, freq) {
    const out = path.join(tmp, 'fx', name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-c:a', 'aac', out]);
    return out;
  }
  async function post(url, { file, fields = {}, headers = {} } = {}) {
    const fd = new FormData();
    if (file) fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mp4' }), path.basename(file));
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    const res = await fetch(srv.base + url, { method: 'POST', headers, body: fd });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const bearer = (who) => ({ Authorization: `Bearer ${tok[who]}` });
  const mark = (id, opts) => req('POST', `/api/library/${id}/report`, opts);
  const unmark = (id, opts) => req('DELETE', `/api/library/${id}/report`, opts);
  const openRows = async (id) => (await pg.query('SELECT * FROM library_song_reports WHERE song_id = $1 AND resolved_at IS NULL ORDER BY id', [id])).rows;

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_reports').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-reports-'));
    fs.mkdirSync(path.join(tmp, 'fx'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const key of ['alice', 'bob', 'carol', 'revoked']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, 'approved', 1) RETURNING id`,
        [key, key[0].toUpperCase() + key.slice(1)]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
      const t = await req('POST', '/api/tokens', { cookie: cookies[key], body: { label: 'CLI' } });
      assert.equal(t.status, 201);
      tok[key] = t.body.token;
    }
    for (const [key, status] of [['pendingWeb', 'pending'], ['deniedWeb', 'denied']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', $1, $1, $2, 1) RETURNING id`,
        [key, status]
      );
      cookies[key] = cookieFor(r.rows[0].id);
    }
    await pg.query(`UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1`, [ids.revoked]);

    fx.a = makeAudio('a.m4a', 440);
    fx.b = makeAudio('b.m4a', 550);
    fx.c = makeAudio('c.m4a', 660);
    fx.b2 = makeAudio('b2.m4a', 770);
    for (const [k, title] of [['a', 'Alpha'], ['b', 'Bravo'], ['c', 'Charlie']]) {
      const r = await post('/api/library/upload', { file: fx[k], fields: { title, artist: 'Tester' }, headers: bearer('alice') });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      songs[k] = r.body.song;
    }
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the table exists after boot with the one-open-report-per-user index', async () => {
    const idx = await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_song_reports_open_user'`);
    assert.match(idx.rows[0].indexdef, /UNIQUE.*WHERE \(resolved_at IS NULL\)/);
  });

  it('permissions: nobody, pending / denied users and revoked tokens are refused', async () => {
    assert.equal((await mark(songs.a.id, { body: { reason: 'x' } })).status, 401);
    assert.equal((await mark(songs.a.id, { cookie: cookies.pendingWeb, body: {} })).status, 403);
    assert.equal((await mark(songs.a.id, { cookie: cookies.deniedWeb, body: {} })).status, 403);
    assert.equal((await mark(songs.a.id, { headers: bearer('revoked'), body: {} })).status, 401);
    assert.equal((await unmark(songs.a.id, { cookie: cookies.pendingWeb })).status, 403);
    assert.equal((await openRows(songs.a.id)).length, 0);
  });

  it('validation: unknown song 404, reason too long / not a string 400', async () => {
    assert.equal((await mark('00000000-0000-4000-8000-000000000000', { cookie: cookies.alice, body: {} })).status, 404);
    assert.equal((await mark('not-a-uuid', { cookie: cookies.alice, body: {} })).status, 404);
    assert.equal((await mark(songs.a.id, { cookie: cookies.alice, body: { reason: 'x'.repeat(201) } })).status, 400);
    assert.equal((await mark(songs.a.id, { cookie: cookies.alice, body: { reason: 42 } })).status, 400);
  });

  it('mark: one open report per user; re-marking updates the reason; tokens act as their owner', async () => {
    let r = await mark(songs.a.id, { cookie: cookies.alice, body: { reason: 'wrong song' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.report.reason, 'wrong song');
    assert.equal(r.body.report.mine, true);
    assert.equal(r.body.song.report_count, 1);

    r = await mark(songs.a.id, { cookie: cookies.alice, body: { reason: '  bad   audio ' } });
    assert.equal(r.status, 200, 'an update, not a second report');
    assert.equal(r.body.report.reason, 'bad audio');
    let rows = await openRows(songs.a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reported_by_user_id, ids.alice);

    // Bob through his CLI token; no reason is fine.
    r = await mark(songs.a.id, { headers: bearer('bob'), body: {} });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.reason, null);
    rows = await openRows(songs.a.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].reported_by_user_id, ids.bob);
  });

  it('every song carries its open reports; "mine" follows the viewer; no user ids leak', async () => {
    const asAlice = await req('GET', `/api/library/${songs.a.id}`, { cookie: cookies.alice });
    assert.equal(asAlice.body.song.report_count, 2);
    assert.deepEqual(asAlice.body.song.reports.map((x) => [x.reported_by, x.reason, x.mine]), [['Alice', 'bad audio', true], ['Bob', null, false]]);
    assert.ok(!JSON.stringify(asAlice.body).includes(ids.bob), 'no user id of someone else');
    const asCarol = await req('GET', '/api/library?limit=10', { headers: bearer('carol') });
    const a = asCarol.body.songs.find((s) => s.id === songs.a.id);
    assert.equal(a.report_count, 2);
    assert.ok(a.reports.every((x) => x.mine === false));
    const c = asCarol.body.songs.find((s) => s.id === songs.c.id);
    assert.deepEqual(c.reports, []);
    assert.equal(c.report_count, 0);
  });

  it('filter: GET /api/library?reported=1 lists only reported songs (web user and token)', async () => {
    await mark(songs.b.id, { cookie: cookies.carol, body: { reason: 'cut off' } });
    for (const opts of [{ cookie: cookies.carol }, { headers: bearer('alice') }]) {
      const r = await req('GET', '/api/library?reported=1', opts);
      assert.equal(r.status, 200);
      assert.equal(r.body.total, 2);
      assert.deepEqual(r.body.songs.map((s) => s.id), [songs.b.id, songs.a.id], 'most recently reported first');
    }
    const q = await req('GET', '/api/library?reported=1&q=bravo', { cookie: cookies.carol });
    assert.deepEqual(q.body.songs.map((s) => s.id), [songs.b.id]);
    assert.equal((await req('GET', '/api/library?reported=1', { cookie: cookies.pendingWeb })).status, 403);
  });

  it('unmark: only your own report', async () => {
    assert.equal((await unmark(songs.b.id, { cookie: cookies.alice })).status, 404, 'Alice has no report on b');
    assert.equal((await openRows(songs.b.id)).length, 1, "Carol's report stays");
    assert.equal((await unmark(songs.a.id, { headers: bearer('bob') })).status, 200);
    const rows = await openRows(songs.a.id);
    assert.deepEqual(rows.map((x) => x.reported_by_user_id), [ids.alice]);
    assert.equal((await unmark(songs.a.id, { headers: bearer('bob') })).status, 404, 'already gone');
  });

  it('replacing the audio resolves every open report (by the replacer)', async () => {
    await mark(songs.b.id, { cookie: cookies.alice, body: { reason: 'bad audio' } });
    assert.equal((await openRows(songs.b.id)).length, 2);
    const r = await post(`/api/library/${songs.b.id}/replace`, { file: fx.b2, fields: { title: 'Bravo', artist: 'Tester' }, headers: bearer('bob') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.resolved_reports, 2);
    assert.equal((await openRows(songs.b.id)).length, 0);
    const resolved = (await pg.query('SELECT * FROM library_song_reports WHERE song_id = $1', [songs.b.id])).rows;
    assert.equal(resolved.length, 2);
    for (const row of resolved) {
      assert.equal(row.resolution, 'replaced');
      assert.equal(row.resolved_by_user_id, ids.bob);
      assert.ok(row.resolved_at);
    }
    const list = await req('GET', '/api/library?reported=1', { cookie: cookies.carol });
    assert.deepEqual(list.body.songs.map((s) => s.id), [songs.a.id]);
    // Marking it again later starts a new open report.
    assert.equal((await mark(songs.b.id, { cookie: cookies.carol, body: { reason: 'still wrong' } })).status, 201);
    assert.equal((await openRows(songs.b.id)).length, 1);
  });

  it('admin dismiss: admin cookie only; one report or all of a song', async () => {
    const [aliceReport] = await openRows(songs.a.id);
    const one = `/api/admin/library/reports/${aliceReport.id}/dismiss`;
    assert.equal((await req('POST', one, { cookie: cookies.alice })).status, 401);
    assert.equal((await req('POST', one, { headers: bearer('alice') })).status, 401);
    let r = await req('POST', one, { cookie: adminCookie() });
    assert.equal(r.status, 200);
    assert.equal((await openRows(songs.a.id)).length, 0);
    const row = (await pg.query('SELECT * FROM library_song_reports WHERE id = $1', [aliceReport.id])).rows[0];
    assert.equal(row.resolution, 'dismissed');
    assert.equal((await req('POST', one, { cookie: adminCookie() })).status, 404, 'already resolved');

    await mark(songs.b.id, { cookie: cookies.alice, body: {} });
    const all = `/api/admin/library/${songs.b.id}/reports/dismiss`;
    assert.equal((await req('POST', all, { cookie: cookies.bob })).status, 401);
    r = await req('POST', all, { cookie: adminCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.dismissed, 2);
    assert.equal((await req('GET', '/api/library?reported=1', { cookie: cookies.carol })).body.total, 0);
  });
});
