// Duplicate detection and "replace the audio of a library song", against the
// real server on Postgres (testcontainers) with ffmpeg-made fixtures:
//   - POST /api/library/check: youtube_id / file hash / probable metadata match
//   - the upload re-checks (409 + code), allow_similar overrides metadata,
//     concurrent uploads cannot both get in (hash: unique index; metadata:
//     advisory lock)
//   - meta_key backfill for rows from before it existed
//   - POST /api/library/:id/replace keeps the id, rewrites playlist entries,
//     writes the audit row, deletes the old file, serves the new one
//   - who may replace / check: any valid token, any approved web user; not
//     pending / denied users, not revoked tokens
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieFor, startServer, requester } = require('./testServer');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg/ffprobe not available' : false;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('library duplicate detection and replace', { skip, timeout: 240_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  let songsDir;
  const ids = {};
  const cookies = {};
  const tok = {};
  const fx = {};
  let legacyId;

  function makeAudio(name, freq, seconds = 2) {
    const out = path.join(tmp, 'fx', name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-c:a', 'aac', out]);
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
  const upload = (file, fields, who = 'alice') => post('/api/library/upload', { file, fields, headers: bearer(who) });
  const check = (body, who = 'alice') => req('POST', '/api/library/check', { headers: bearer(who), body });

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_dedupe').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-dedupe-'));
    fs.mkdirSync(path.join(tmp, 'fx'));
    songsDir = path.join(tmp, 'songs');

    // A row from before duplicate keys existed: create the schema in-process,
    // insert it with meta_key NULL and check the backfill fills it.
    process.env.DATABASE_URL = url;
    process.env.SONGS_PATH = songsDir;
    const db = require('./db');
    assert.ok(await db.init());
    const library = require('./library');
    const legacy = await db.query(
      `INSERT INTO library_songs (title, artist, duration_sec, file_path, sha256, uploaded_by)
       VALUES ('Sevda Çiçeği (Sözleri)', 'Müslüm Gürses', 200, '/nope.m4a', $1, 'server') RETURNING id, meta_key`,
      [crypto.createHash('sha256').update('legacy').digest('hex')]
    );
    assert.equal(legacy.rows[0].meta_key, null);
    legacyId = legacy.rows[0].id;
    assert.ok(await library.backfillMetaKeys({ pauseMs: 0 }) >= 1);
    const after = await db.query('SELECT meta_key, meta_key_version FROM library_songs WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].meta_key, 'muslumgurses|sevda cicegi');
    assert.equal(after.rows[0].meta_key_version, require('./songMatch').META_KEY_VERSION);
    assert.equal(await library.backfillMetaKeys({ pauseMs: 0 }), 0, 'idempotent');
    await db.close();

    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: songsDir, COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const key of ['alice', 'bob', 'pending', 'denied', 'revoked']) {
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
    // Web-only accounts that never were approved (the server caches account
    // lookups for a few seconds, so don't flip a user it has just seen).
    for (const [key, status] of [['pendingWeb', 'pending'], ['deniedWeb', 'denied']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', $1, $1, $2, 1) RETURNING id`,
        [key, status]
      );
      cookies[key] = cookieFor(r.rows[0].id);
    }
    await pg.query(`UPDATE users SET status = 'pending' WHERE id = $1`, [ids.pending]);
    await pg.query(`UPDATE users SET status = 'denied' WHERE id = $1`, [ids.denied]);
    await pg.query(`UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1`, [ids.revoked]);

    fx.a = makeAudio('a.m4a', 440);
    fx.b = makeAudio('b.m4a', 550);
    fx.c = makeAudio('c.m4a', 660);
    fx.d = makeAudio('d.m4a', 770);
    fx.e = makeAudio('e.m4a', 880);
    fx.f = makeAudio('f.m4a', 990);
    fx.g = makeAudio('g.m4a', 1100);
    fx.h = makeAudio('h.m4a', 1200);
    fx.long = makeAudio('long.m4a', 300, 9);
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const songs = {};

  it('the check endpoint needs a valid token of an approved user', async () => {
    assert.equal((await req('POST', '/api/library/check', { body: {} })).status, 401);
    assert.equal((await req('POST', '/api/library/check', { headers: { Authorization: 'Bearer la_nope' }, body: {} })).status, 401);
    for (const who of ['pending', 'denied', 'revoked']) assert.equal((await check({}, who)).status, 401, who);
    assert.equal((await check({ sha256: 'xyz' })).status, 400);
    assert.equal((await check({ youtube_id: 'bad' })).status, 400);
    const r = await check({ youtube_id: 'QQQQQQQQQQQ', title: 'Nothing', artist: 'Nobody', duration_sec: 100 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { duplicate: false, match: null, matches: [] });
  });

  it('finds an existing song by youtube_id, by file hash and by normalized metadata ±3s', async () => {
    const up = await upload(fx.a, { title: 'Bohemian Rhapsody (Remastered 2011)', artist: 'Queen', youtube_id: 'AAAAAAAAAAA' });
    assert.equal(up.status, 201);
    songs.a = up.body.song;
    assert.ok(songs.a.duration_sec > 1.5 && songs.a.duration_sec < 2.5, 'duration from ffprobe');

    let r = await check({ youtube_id: 'AAAAAAAAAAA' });
    assert.equal(r.body.match.reason, 'already_in_library');
    assert.equal(r.body.match.exact, true);
    assert.equal(r.body.match.song.id, songs.a.id);

    r = await check({ sha256: sha256(fx.a) });
    assert.equal(r.body.match.reason, 'duplicate_hash');
    assert.equal(r.body.match.song.id, songs.a.id);

    r = await check({ title: 'Queen - Bohemian Rhapsody (Official Video)', artist: 'QueenVEVO', duration_sec: 4.5 });
    assert.equal(r.body.duplicate, true);
    assert.equal(r.body.match.reason, 'duplicate_metadata');
    assert.equal(r.body.match.exact, false);
    assert.equal(r.body.match.song.title, 'Bohemian Rhapsody (Remastered 2011)');

    r = await check({ title: 'Bohemian Rhapsody', artist: 'Queen', duration_sec: 9 });
    assert.equal(r.body.duplicate, false, 'duration more than 3s off');
    r = await check({ title: 'Bohemian Rhapsody', artist: 'Queen' });
    assert.equal(r.body.duplicate, false, 'no duration, no metadata match');

    r = await check({ title: 'SEVDA CICEGI', artist: 'Muslum Gurses', duration_sec: 201 });
    assert.equal(r.body.match.reason, 'duplicate_metadata', 'backfilled legacy row (Turkish folding)');
    assert.equal(r.body.match.song.id, legacyId);

    r = await check({ youtube_id: 'AAAAAAAAAAA', sha256: sha256(fx.a), title: 'Bohemian Rhapsody', artist: 'Queen', duration_sec: 2 });
    assert.equal(r.body.matches.length, 1, 'one entry per song, strongest reason');
    assert.equal(r.body.matches[0].reason, 'already_in_library');
  });

  it('the upload re-checks: hash and metadata are 409s with a code; allow_similar uploads anyway', async () => {
    let r = await upload(fx.a, { title: 'Anything', artist: 'Else', youtube_id: 'BBBBBBBBBBB' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'duplicate_hash');
    assert.equal(r.body.exact, true);
    assert.equal(r.body.song.id, songs.a.id);

    r = await upload(fx.b, { title: 'Queen - Bohemian Rhapsody [HD]', artist: 'Queen - Topic', youtube_id: 'CCCCCCCCCCC' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'duplicate_metadata');
    assert.equal(r.body.exact, false);
    assert.equal(r.body.song.id, songs.a.id);

    r = await upload(fx.b, { title: 'Queen - Bohemian Rhapsody [HD]', artist: 'Queen - Topic', youtube_id: 'CCCCCCCCCCC', allow_similar: '1' });
    assert.equal(r.status, 201);
    assert.notEqual(r.body.song.id, songs.a.id);

    r = await upload(fx.c, { title: 'x', artist: 'y', youtube_id: 'AAAAAAAAAAA' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already_in_library');
  });

  it('concurrent uploads of the same song cannot both get in', async () => {
    // Same metadata, different bytes: serialized by the advisory lock.
    let rs = await Promise.all([
      upload(fx.d, { title: 'Race Song', artist: 'Racer' }),
      upload(fx.e, { title: 'Race Song (Official Audio)', artist: 'Racer' }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(rs.find((r) => r.status === 409).body.code, 'duplicate_metadata');

    // Same bytes, no metadata overlap: the sha256 unique index.
    rs = await Promise.all([
      upload(fx.f, { title: 'Twin One', artist: 'Twins A' }),
      upload(fx.f, { title: 'Twin Two', artist: 'Twins B' }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(rs.find((r) => r.status === 409).body.code, 'duplicate_hash');
    const n = await pg.query('SELECT count(*)::int AS n FROM library_songs WHERE title LIKE $1', ['Twin%']);
    assert.equal(n.rows[0].n, 1);
  });

  it('replace keeps the id, fixes every playlist holding the song, audits, swaps the file', async () => {
    // A playlist holding song A (queued by its YouTube watch URL).
    let r = await req('POST', '/api/playlists', { headers: bearer('alice'), body: { name: 'Fix me' } });
    assert.equal(r.status, 201);
    const playlistId = r.body.id;
    r = await req('POST', `/api/playlists/${playlistId}/songs`, { headers: bearer('alice'), body: { songs: [songs.a.id] } });
    assert.equal(r.status, 200);
    r = await req('GET', `/api/playlists/${playlistId}/songs`, { headers: bearer('alice') });
    const entryBefore = r.body.songs[0];
    assert.equal(entryBefore.library_id, songs.a.id);
    const oldRow = (await pg.query('SELECT file_path, sha256 FROM library_songs WHERE id = $1', [songs.a.id])).rows[0];
    assert.ok(fs.existsSync(oldRow.file_path));

    r = await post(`/api/library/${songs.a.id}/replace`, {
      file: fx.long,
      fields: { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', youtube_id: 'ZZZZZZZZZZZ' },
      headers: bearer('bob'),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.song.id, songs.a.id, 'same id');
    assert.equal(r.body.song.youtube_id, 'ZZZZZZZZZZZ');
    assert.equal(r.body.song.title, 'Bohemian Rhapsody');
    assert.ok(r.body.song.duration_sec > 8, 'new duration from the new file');
    assert.ok(r.body.song.replaced_at);
    assert.equal(r.body.song.uploaded_by, 'Alice', 'the original uploader stays credited');
    assert.notEqual(r.body.song.file_version, songs.a.file_version);
    assert.equal(r.body.previous.youtube_id, 'AAAAAAAAAAA');

    const newRow = (await pg.query('SELECT file_path, sha256, meta_key FROM library_songs WHERE id = $1', [songs.a.id])).rows[0];
    assert.equal(newRow.sha256, sha256(fx.long));
    assert.ok(fs.existsSync(newRow.file_path));
    assert.ok(!fs.existsSync(oldRow.file_path), 'old file deleted');

    const audit = (await pg.query('SELECT * FROM library_song_replacements WHERE song_id = $1', [songs.a.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].replaced_by_user_id, ids.bob);
    assert.equal(audit[0].replaced_by, 'Bob');
    assert.equal(audit[0].old_youtube_id, 'AAAAAAAAAAA');
    assert.equal(audit[0].new_youtube_id, 'ZZZZZZZZZZZ');
    assert.equal(audit[0].old_sha256, oldRow.sha256);
    assert.equal(audit[0].new_sha256, newRow.sha256);
    assert.equal(audit[0].old_title, 'Bohemian Rhapsody (Remastered 2011)');
    assert.equal(audit[0].new_title, 'Bohemian Rhapsody');
    assert.equal(audit[0].old_source_url, 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
    assert.equal(audit[0].new_source_url, 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ');
    const hist = await req('GET', `/api/library/${songs.a.id}/replacements`, { headers: bearer('alice') });
    assert.equal(hist.body.replacements.length, 1);

    // The playlist entry (same entry id) now points at the new song version
    // and streams the new file.
    let entryAfter;
    for (let i = 0; i < 50; i++) {
      r = await req('GET', `/api/playlists/${playlistId}/songs`, { headers: bearer('alice') });
      entryAfter = r.body.songs[0];
      if (entryAfter.youtube_id === 'ZZZZZZZZZZZ') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(entryAfter.entry_id, entryBefore.entry_id);
    assert.equal(entryAfter.library_id, songs.a.id);
    assert.equal(entryAfter.youtube_id, 'ZZZZZZZZZZZ');
    const dbEntry = (await pg.query('SELECT url FROM queue_songs WHERE id = $1', [entryBefore.entry_id])).rows[0];
    assert.equal(dbEntry.url, 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ', 'persisted');

    const cookie = cookies.alice;
    for (const q of [dbEntry.url, 'https://www.youtube.com/watch?v=AAAAAAAAAAA']) {
      const s = await fetch(`${srv.base}/api/stream?q=${encodeURIComponent(q)}`, { headers: { cookie } });
      assert.equal(s.status, 200, q);
      assert.equal(s.headers.get('cache-control'), 'no-cache', 'unversioned audio urls revalidate');
      assert.equal(crypto.createHash('sha256').update(Buffer.from(await s.arrayBuffer())).digest('hex'), newRow.sha256, `${q} plays the new file`);
    }
    const v = await fetch(`${srv.base}/api/library/${songs.a.id}/file?v=${newRow.sha256.slice(0, 16)}`, { headers: bearer('alice') });
    assert.match(v.headers.get('cache-control'), /immutable/, 'versioned url is cached forever');
    await v.arrayBuffer();

    // The metadata key follows the new title.
    assert.equal(newRow.meta_key, 'queen|bohemian rhapsody');
  });

  it('replace refusals: same file, another song\'s file / youtube_id, unknown song, bad file', async () => {
    let r = await post(`/api/library/${songs.a.id}/replace`, { file: fx.long, fields: { title: 't', artist: 'a' }, headers: bearer('alice') });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'same_file');
    r = await post(`/api/library/${songs.a.id}/replace`, { file: fx.b, fields: { title: 't', artist: 'a' }, headers: bearer('alice') });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'duplicate_hash');
    r = await post(`/api/library/${songs.a.id}/replace`, { file: fx.g, fields: { title: 't', artist: 'a', youtube_id: 'CCCCCCCCCCC' }, headers: bearer('alice') });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already_in_library');
    r = await post('/api/library/00000000-0000-4000-8000-000000000000/replace', { file: fx.g, fields: { title: 't', artist: 'a' }, headers: bearer('alice') });
    assert.equal(r.status, 404);
    r = await post(`/api/library/${songs.a.id}/replace`, { file: fx.g, fields: { artist: 'a' }, headers: bearer('alice') });
    assert.equal(r.status, 400);
    const audit = await pg.query('SELECT count(*)::int AS n FROM library_song_replacements WHERE song_id = $1', [songs.a.id]);
    assert.equal(audit.rows[0].n, 1, 'refusals write no audit rows');
    assert.deepEqual(fs.readdirSync(path.join(songsDir, '.upload-tmp')), [], 'no temp files left behind');
  });

  it('replace permissions: approved web users yes; pending / denied users, revoked tokens, nobody: no', async () => {
    const fields = { title: 'Bohemian Rhapsody', artist: 'Queen' };
    const url = `/api/library/${songs.a.id}/replace`;
    assert.equal((await post(url, { file: fx.h, fields })).status, 401);
    assert.equal((await post(url, { file: fx.h, fields, headers: { cookie: cookies.pendingWeb } })).status, 403);
    assert.equal((await post(url, { file: fx.h, fields, headers: { cookie: cookies.deniedWeb } })).status, 403);
    for (const who of ['pending', 'denied', 'revoked']) {
      assert.equal((await post(url, { file: fx.h, fields, headers: bearer(who) })).status, 401, `${who} token`);
    }
    const r = await post(url, { file: fx.h, fields, headers: { cookie: cookies.bob } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.song.id, songs.a.id);
    assert.equal(r.body.song.youtube_id, null, 'no youtube_id given: cleared');
    const audit = (await pg.query('SELECT * FROM library_song_replacements WHERE song_id = $1 ORDER BY id DESC LIMIT 1', [songs.a.id])).rows[0];
    assert.equal(audit.replaced_by_user_id, ids.bob);
    assert.equal(audit.replaced_by_token, null, 'web, not a token');
    assert.equal(audit.old_youtube_id, 'ZZZZZZZZZZZ');
  });
});
