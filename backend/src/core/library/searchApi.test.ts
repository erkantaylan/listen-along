// The global search's server side, against the real server on Postgres
// (testcontainers):
//   - GET /api/library?sort=relevance: best matches first (exact / prefix title
//     and artist before loose all-words matches), Turkish-aware; without it the
//     list is exactly as before; who may ask; bounds
//   - the duplicate opt-ins: POST /api/playlists/:id/songs refuses the same song
//     (already_in_playlist) unless allow_duplicates; POST /api/jobs { picks,
//     playlist_id } names already_in_playlist and adds only with allow_duplicates;
//     someone else's private playlist is "not found" either way
//   - the /search page is a signed-in page like the others
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pgModule from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { cookieFor, startServer, requester } from '../../testServer.js';

// Server JSON.
type Payload = any;

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}
const has = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('global search on Postgres', { skip, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client | undefined;
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  let req: ReturnType<typeof requester>;
  let tmp: string;
  let token: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const songs: Record<string, string> = {};
  const playlists: Record<string, string> = {};

  const SONGS: Array<[key: string, title: string, artist: string, youtubeId: string | null]> = [
    ['ahelloz', 'Ahelloz', 'Y', null],
    ['sayhello', 'Say Hello', 'Rosie Thomas', null],
    ['hello', 'Hello', 'Adele', 'hellovideo1'],
    ['hellofrom', 'Hello from the Other Side', 'Someone', null],
    ['band', 'Goodbye', 'Hello Band', null],
    ['sarki', 'Şarkı Söyle', 'Barış Manço', 'sarkivideo1'],
    ['other', 'Unrelated', 'Nobody', null],
  ];
  const library = (who: string, query: Record<string, string>) => req('GET', `/api/library?${new URLSearchParams(query)}`, { cookie: cookies[who] });
  const titles = (r: { body: Payload }): string[] => r.body.songs.map((s: Payload) => s.title);

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_search').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-search-'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    pg = new pgModule.Client({ connectionString: url });
    await pg.connect();
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['pending', 'pending']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [key, key, key[0].toUpperCase() + key.slice(1), status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    const t = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'cli' } });
    token = t.body.token;
    // Inserted oldest first, so "recent" (the default order) is the reverse.
    for (const [i, [key, title, artist, yt]] of SONGS.entries()) {
      const r = await pg.query(
        `INSERT INTO library_songs (youtube_id, title, artist, duration_sec, file_path, sha256, uploaded_by, created_at)
         VALUES ($1, $2, $3, 200, '/nope.m4a', $4, 'seed', now() - make_interval(mins => $5)) RETURNING id`,
        [yt, title, artist, crypto.createHash('sha256').update(key).digest('hex'), 100 - i]
      );
      songs[key] = r.rows[0].id;
    }
    for (const [key, who, visibility] of [['pub', 'alice', 'public'], ['priv', 'alice', 'private'], ['bobs', 'bob', 'public']]) {
      const r = await req('POST', '/api/playlists', { cookie: cookies[who], body: { name: key, visibility } });
      assert.equal(r.status, 201, r.text);
      playlists[key] = r.body.id;
    }
  });

  after(async () => {
    if (pg) await pg.end().catch(() => {});
    if (srv) await srv.stop();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('GET /api/library?sort=relevance', () => {
    it('exact and prefix matches before loose all-words matches', async () => {
      const r = await library('alice', { q: 'hello', sort: 'relevance' });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(titles(r), ['Hello', 'Hello from the Other Side', 'Goodbye', 'Say Hello', 'Ahelloz']);
      assert.equal(r.body.total, 5);
    });

    it('without it, the list is as it always was (newest first, every word somewhere)', async () => {
      const r = await library('alice', { q: 'hello' });
      assert.deepEqual(titles(r), ['Goodbye', 'Hello from the Other Side', 'Hello', 'Say Hello', 'Ahelloz']);
    });

    it('Turkish letters and case fold: "sarki" finds "Şarkı", "BARIS manco" the artist', async () => {
      assert.deepEqual(titles(await library('alice', { q: 'sarki', sort: 'relevance' })), ['Şarkı Söyle']);
      assert.deepEqual(titles(await library('alice', { q: 'BARIS manco', sort: 'relevance' })), ['Şarkı Söyle']);
      assert.deepEqual(titles(await library('alice', { q: 'barış - şarkı', sort: 'relevance' })), ['Şarkı Söyle'], 'a lone "-" is not a word');
    });

    it('a NUL byte in the query is dropped, in both orders, never a 500', async () => {
      const relevance = await req('GET', '/api/library?q=hel%00lo&sort=relevance', { cookie: cookies.alice });
      assert.equal(relevance.status, 200, relevance.text);
      assert.equal(relevance.body.songs[0].title, 'Hello');
      const plain = await req('GET', '/api/library?q=hel%00lo', { cookie: cookies.alice });
      assert.equal(plain.status, 200, plain.text);
      assert.ok(plain.body.songs.some((x: Payload) => x.title === 'Hello'));
    });

    it('LIKE wildcards in the query are plain text', async () => {
      assert.deepEqual(titles(await library('alice', { q: '%', sort: 'relevance' })), []);
      assert.deepEqual(titles(await library('alice', { q: 'hel_o', sort: 'relevance' })), []);
    });

    it('bounds: empty query lists nothing, limit and offset hold, a long query is cut', async () => {
      const empty = await library('alice', { q: '', sort: 'relevance' });
      assert.deepEqual(empty.body, { songs: [], total: 0 });
      const two = await library('alice', { q: 'hello', sort: 'relevance', limit: '2' });
      assert.deepEqual(titles(two), ['Hello', 'Hello from the Other Side']);
      assert.equal(two.body.total, 5);
      const next = await library('alice', { q: 'hello', sort: 'relevance', limit: '2', offset: '2' });
      assert.deepEqual(titles(next), ['Goodbye', 'Say Hello']);
      assert.equal((await library('alice', { q: 'hello '.repeat(200), sort: 'relevance' })).status, 200);
    });

    it('who may ask: approved accounts and tokens, as for the library list', async () => {
      assert.equal((await req('GET', '/api/library?q=hello&sort=relevance')).status, 401);
      assert.equal((await library('pending', { q: 'hello', sort: 'relevance' })).status, 403);
      const cli = await req('GET', '/api/library?q=hello&sort=relevance', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(cli.status, 200);
      assert.equal(cli.body.songs[0].title, 'Hello');
    });
  });

  describe('duplicates: the same song in the same playlist', () => {
    const add = (who: string, id: string, body: unknown) => req('POST', `/api/playlists/${id}/songs`, { cookie: cookies[who], body });
    const queue = async (id: string): Promise<Payload[]> => (await req('GET', `/api/playlists/${id}/songs`, { cookie: cookies.alice })).body.songs;

    it('adding a library song: refused as already_in_playlist, added with allow_duplicates', async () => {
      const first = await add('alice', playlists.pub, { songs: [songs.hello] });
      assert.equal(first.body.results[0].status, 'added');
      const again = await add('alice', playlists.pub, { songs: [songs.hello] });
      assert.equal(again.status, 200);
      assert.equal(again.body.results[0].status, 'already_in_playlist');
      assert.equal((await queue(playlists.pub)).length, 1);
      const allowed = await add('alice', playlists.pub, { songs: [songs.hello], allow_duplicates: true });
      assert.equal(allowed.body.results[0].status, 'added');
      assert.equal((await queue(playlists.pub)).length, 2);
    });

    it('a different video of the same song is not a duplicate', async () => {
      const r = await add('alice', playlists.pub, { songs: [songs.hellofrom] });
      assert.equal(r.body.results[0].status, 'added');
    });

    it('requesting picks: the library song already there is named, and added only with allow_duplicates', async () => {
      const before = (await queue(playlists.pub)).length;
      const r = await req('POST', '/api/jobs', { cookie: cookies.alice, body: { picks: ['hellovideo1'], playlist_id: playlists.pub } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.jobs, []);
      assert.equal(r.body.added_to_playlist, 0);
      assert.deepEqual(r.body.already_in_playlist, ['hellovideo1']);
      assert.equal((await queue(playlists.pub)).length, before, 'without the flag: not added, as before');
      const allowed = await req('POST', '/api/jobs', { cookie: cookies.alice, body: { picks: ['hellovideo1'], playlist_id: playlists.pub, allow_duplicates: true } });
      assert.equal(allowed.body.added_to_playlist, 1);
      assert.deepEqual(allowed.body.already_in_playlist, []);
      assert.equal((await queue(playlists.pub)).length, before + 1);
      const fresh = await req('POST', '/api/jobs', { cookie: cookies.alice, body: { picks: ['sarkivideo1'], playlist_id: playlists.pub } });
      assert.equal(fresh.body.added_to_playlist, 1);
      assert.deepEqual(fresh.body.already_in_playlist, []);
      const libraryOnly = await req('POST', '/api/jobs', { cookie: cookies.alice, body: { picks: ['sarkivideo1'] } });
      assert.deepEqual(libraryOnly.body.already_in_playlist, [], 'no playlist, nothing to be in');
    });

    it('someone else\'s private playlist does not exist, whatever the flags', async () => {
      const a = await add('bob', playlists.priv, { songs: [songs.hello], allow_duplicates: true });
      assert.equal(a.status, 404);
      const b = await req('POST', '/api/jobs', { cookie: cookies.bob, body: { picks: ['hellovideo1'], playlist_id: playlists.priv, allow_duplicates: true } });
      assert.equal(b.status, 404);
      assert.equal(b.body.code, 'PLAYLIST_NOT_FOUND');
      assert.equal((await queue(playlists.priv)).length, 0);
    });

    it('a public playlist anyone may edit takes the flag from anyone', async () => {
      assert.equal((await add('alice', playlists.bobs, { songs: [songs.sarki] })).body.results[0].status, 'added');
      assert.equal((await add('alice', playlists.bobs, { songs: [songs.sarki] })).body.results[0].status, 'already_in_playlist');
      assert.equal((await add('alice', playlists.bobs, { songs: [songs.sarki], allow_duplicates: true })).body.results[0].status, 'added');
    });
  });

  describe('the relevance search has a budget of its own', () => {
    it('120 a minute per account: another account on the same address is not held up, nor the plain list', async () => {
      let refused = 0;
      for (let i = 0; i < 125; i++) {
        const r = await library('bob', { q: `hello ${i % 3}`, sort: 'relevance' });
        if (r.status === 429) refused++;
        else assert.equal(r.status, 200);
      }
      assert.equal(refused, 5, 'bob\'s own 120, then refused');
      assert.equal((await library('bob', { q: 'hello' })).status, 200, 'the plain list is not counted');
      assert.equal((await library('alice', { q: 'hello', sort: 'relevance' })).status, 200, 'alice, behind the same address, is not held up');
      const cli = await req('GET', '/api/library?q=hello&sort=relevance', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(cli.status, 200, 'alice\'s token counts as alice');
    });
  });

  describe('the /search page', () => {
    it('signed out: to the login, remembering the search', async () => {
      const r = await req('GET', '/search?q=hello');
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent('/search?q=hello')}`);
    });
    it('signed in: the app', async () => {
      const r = await req('GET', '/search?q=hello', { cookie: cookies.alice });
      assert.equal(r.status, 200);
      assert.match(r.text, /id="search-view"/);
      assert.match(r.text, /id="app-search-input"/);
    });
  });
});
