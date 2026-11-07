// Artists (artists.js): the grouping rule on its own, then the API against the
// real server on Postgres (testcontainers): who gets in, broken songs, lean rows.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieFor, startServer, requester } = require('./testServer');
const { policyFor } = require('./userAuth');
const { groupArtists, listArtists, displayName } = require('./artists');
const { normalizeReport, viewNowPlaying } = require('./presence');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

let n = 0;
const row = (artist, extra = {}) => ({ id: `id${++n}`, title: `Song ${n}`, artist, duration_sec: 100, youtube_id: null, created_at: new Date(n * 1000), ...extra });

describe('artists: grouping', () => {
  it('one artist whatever the spelling, channel suffix or featured guest', () => {
    const groups = groupArtists([
      row('Barış Manço'), row('barismanco'), row('Barış Manço - Topic'), row('BARIŞ MANÇO feat. Someone'),
      row('Barış Manço & Kurtalan Ekspres'), row('The Beatles'), row('Beatles'),
    ]);
    assert.deepEqual([...groups.keys()].sort(), ['barismanco', 'beatles']);
    assert.equal(groups.get('barismanco').count, 5);
    assert.equal(groups.get('beatles').count, 2);
  });

  it('names the artist the way most of its songs do, without channel suffixes', () => {
    const groups = groupArtists([row('TarkanVEVO'), row('Tarkan - Topic'), row('tarkan'), row('Tarkan')]);
    assert.equal(groups.get('tarkan').name, 'Tarkan');
    assert.equal(displayName('Sezen Aksu - Topic'), 'Sezen Aksu');
    assert.equal(displayName('AdeleVEVO'), 'Adele');
    assert.equal(displayName('Duman Official'), 'Duman');
  });

  it('adds up lengths, takes the newest YouTube cover, and skips artists that normalize to nothing', () => {
    const groups = groupArtists([
      row('Duman', { duration_sec: 120.4, youtube_id: 'old', created_at: new Date(1000) }),
      row('Duman', { duration_sec: null, youtube_id: 'new', created_at: new Date(5000) }),
      row('Duman', { duration_sec: 60, youtube_id: null, created_at: new Date(9000) }),
      row('---'), row(''),
    ]);
    assert.deepEqual([...groups.keys()], ['duman']);
    const d = groups.get('duman');
    assert.equal(d.duration_sec, 180);
    assert.equal(d.cover_youtube_id, 'new');
  });

  it('lists most songs first, then A-Z in the Turkish alphabet', () => {
    const list = listArtists(groupArtists([row('Zeynep'), row('Çelik'), row('Cem'), row('Ali'), row('Ali')]));
    assert.deepEqual(list.map((a) => a.name), ['Ali', 'Cem', 'Çelik', 'Zeynep']);
    assert.deepEqual(Object.keys(list[0]).sort(), ['count', 'cover_youtube_id', 'duration_sec', 'key', 'name']);
  });
});

describe('artists: policy and presence', () => {
  it('the API is approved-only and the pages need a login, by default', () => {
    assert.equal(policyFor('/api/artists'), 'approved');
    assert.equal(policyFor('/api/artists/tarkan/songs'), 'approved');
    assert.equal(policyFor('/API/Artists'), 'approved');
    assert.equal(policyFor('/artists'), 'page');
    assert.equal(policyFor('/artist/tarkan'), 'page');
  });

  it('an artist context keeps a checked key and the name, and nothing else', () => {
    const report = { track: { title: 'Şımarık' }, context: { type: 'artist', key: 'tarkan', name: ' Tarkan ', lobbyId: 'abc' }, playing: true };
    assert.deepEqual(normalizeReport(report).context, { type: 'artist', key: 'tarkan', name: 'Tarkan' });
    assert.deepEqual(viewNowPlaying(normalizeReport(report), () => null).context, { type: 'artist', key: 'tarkan', name: 'Tarkan' });
    for (const key of ['', 'a b', '../x', 'x'.repeat(201), 42, null]) {
      assert.equal(normalizeReport({ ...report, context: { type: 'artist', key, name: 'X' } }).context, null, String(key));
    }
    assert.deepEqual(normalizeReport({ ...report, context: { type: 'artist', key: 'çağan' } }).context, { type: 'artist', key: 'çağan', name: null });
  });
});

describe('artists API', { skip, timeout: 180_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  const cookies = {};
  const ids = {};

  async function addSong(title, artist, duration, youtubeId = null) {
    const id = crypto.randomUUID();
    await pg.query(
      `INSERT INTO library_songs (id, title, artist, duration_sec, file_path, mime_type, size_bytes, sha256, youtube_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, 'audio/mp4', 1, $6, $7, 'test')`,
      [id, title, artist, duration, `/tmp/${id}.m4a`, crypto.createHash('sha256').update(id).digest('hex'), youtubeId]
    );
    return id;
  }

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_artists').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-artists-'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['pat', 'pending'], ['dan', 'denied']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, $3, 1) RETURNING id`,
        [key, key, status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    ids.zeytin = await addSong('Zeytin', 'Barış Manço', 200, 'vid1');
    await addSong('Ahmet Bey', 'Barış Manço - Topic', 100, null);
    await addSong('Çoban', 'barismanco', null, null);
    await addSong('Kuzu', 'Duman', 180, 'vid2');
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('nobody, pending and denied accounts are refused; the pages need a login', async () => {
    for (const url of ['/api/artists', '/api/artists/barismanco/songs']) {
      assert.equal((await req('GET', url)).status, 401);
      assert.equal((await req('GET', url, { cookie: cookies.pat })).status, 403);
      assert.equal((await req('GET', url, { cookie: cookies.dan })).status, 403);
    }
    for (const page of ['/artists', '/artist/barismanco']) {
      const res = await req('GET', page);
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /^\/login/);
      assert.equal((await req('GET', page, { cookie: cookies.alice })).status, 200);
    }
  });

  it('a CLI token does not get in', async () => {
    const t = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'CLI' } });
    assert.equal(t.status, 201);
    const headers = { Authorization: `Bearer ${t.body.token}` };
    assert.equal((await req('GET', '/api/artists', { headers })).status, 401);
    assert.equal((await req('GET', '/api/artists/barismanco/songs', { headers })).status, 401);
  });

  it('lists every artist with its count, length and cover', async () => {
    const res = await req('GET', '/api/artists', { cookie: cookies.alice });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.artists, [
      { key: 'barismanco', name: 'Barış Manço', count: 3, duration_sec: 300, cover_youtube_id: 'vid1' },
      { key: 'duman', name: 'Duman', count: 1, duration_sec: 180, cover_youtube_id: 'vid2' },
    ]);
  });

  it("an artist's songs: lean rows by title; an unknown key is a 404", async () => {
    const res = await req('GET', '/api/artists/barismanco/songs', { cookie: cookies.alice });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Barış Manço');
    assert.equal(res.body.count, 3);
    assert.deepEqual(res.body.songs.map((s) => s.title), ['Ahmet Bey', 'Çoban', 'Zeytin']);
    assert.deepEqual(Object.keys(res.body.songs[0]).sort(), ['artist', 'duration_sec', 'file_version', 'id', 'title', 'youtube_id']);
    assert.equal((await req('GET', '/api/artists/nobody/songs', { cookie: cookies.alice })).status, 404);
    assert.equal((await req('GET', `/api/artists/${'x'.repeat(201)}/songs`, { cookie: cookies.alice })).status, 404);
    // Encoded keys work (non-Latin artists keep their letters).
    await addSong('Song', 'Кино', 100);
    const kino = await req('GET', `/api/artists/${encodeURIComponent('кино')}/songs`, { cookie: cookies.alice });
    assert.equal(kino.status, 200);
    assert.equal(kino.body.name, 'Кино');
  });

  it('a song with an open report leaves its artist, and an artist with none left is gone', async () => {
    const duman = (await req('GET', '/api/artists/duman/songs', { cookie: cookies.alice })).body.songs[0].id;
    assert.equal((await req('POST', `/api/library/${duman}/report`, { cookie: cookies.bob, body: { reason: 'Bad audio' } })).status, 201);
    assert.equal((await req('POST', `/api/library/${ids.zeytin}/report`, { cookie: cookies.bob, body: { reason: 'Cut off' } })).status, 201);
    const list = (await req('GET', '/api/artists', { cookie: cookies.alice })).body.artists;
    assert.ok(!list.some((a) => a.key === 'duman'));
    const baris = list.find((a) => a.key === 'barismanco');
    assert.equal(baris.count, 2);
    assert.equal(baris.cover_youtube_id, null);
    assert.equal((await req('GET', '/api/artists/duman/songs', { cookie: cookies.alice })).status, 404);
    assert.equal((await req('DELETE', `/api/library/${duman}/report`, { cookie: cookies.bob })).status, 200);
    assert.equal((await req('GET', '/api/artists/duman/songs', { cookie: cookies.alice })).status, 200);
  });

  it('handles 2,500 songs quickly', async () => {
    await pg.query(
      `INSERT INTO library_songs (id, title, artist, duration_sec, file_path, mime_type, size_bytes, sha256, uploaded_by)
       SELECT gen_random_uuid(), 'Song ' || g, 'Artist ' || (g % 400), 180, '/tmp/f' || g || '.m4a', 'audio/mp4', 1, md5(g::text) || md5(g::text), 'test'
       FROM generate_series(1, 2500) g`
    );
    const started = Date.now();
    const res = await req('GET', '/api/artists', { cookie: cookies.alice });
    assert.equal(res.status, 200);
    assert.ok(res.body.count >= 400);
    const one = await req('GET', '/api/artists/artist7/songs', { cookie: cookies.alice });
    assert.equal(one.status, 200);
    assert.ok(one.body.songs.length >= 6);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started}ms`);
  });
});
