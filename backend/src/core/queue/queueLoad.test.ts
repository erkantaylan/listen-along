// A playlist whose songs (or the library behind them) cannot be read is an
// error, never an empty or bare playlist: a client that syncs playlists (the
// Android app deletes files of songs that left one) must not be told a healthy
// playlist is empty, and a write must never be made over a list that did not
// load (it used to: a clear wiped the stored songs, an add collided with them).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pgModule from 'pg';
import { io as ioClient } from 'socket.io-client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../../shared/db.ts';
import { getQueueAsync, forgetAll, QueueUnavailableError } from './index.ts';
import { startServer, cookieFor, requester } from '../../testing/testServer.ts';

// Server and database JSON.
type Payload = any;

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}

function dockerOk() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

const skip = !PostgreSqlContainer ? 'testcontainers package not installed' : !dockerOk() ? 'Docker not available' : false;
const ALICE = '00000000-0000-4000-8000-0000000a1100';
const SONGS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

describe('a queue that fails to load', { skip, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client;
  const count = async (id: string) => (await pg.query('SELECT count(*)::int AS n FROM queue_songs WHERE playlist_id = $1', [id])).rows[0].n as number;

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine').withDatabase('listen_qload').withUsername('t').withPassword('t').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    assert.ok(await db.init());
    pg = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const now = Date.now();
    for (const id of ['qload001', 'qload002']) {
      await pg.query(`INSERT INTO playlists (id, host_id, name, visibility, created_at, last_activity) VALUES ($1, $2, $1, 'public', $3, $3)`, [id, ALICE, now]);
    }
    for (const [i, s] of SONGS.entries()) {
      await pg.query(`INSERT INTO library_songs (id, title, artist, duration_sec, file_path, sha256, uploaded_by) VALUES ($1, $2, 'Band', 3, '/x', $3, 't')`,
        [s, `Song ${i}`, String(i).repeat(64)]);
      for (const id of ['qload001', 'qload002']) {
        await pg.query(`INSERT INTO queue_songs (id, playlist_id, url, title, added_at, sort_order) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [id, `library:${s}`, `Song ${i} - Band`, now, i]);
      }
    }
  });

  after(async () => {
    await pg?.end();
    await db.close();
    await container?.stop();
    delete process.env.DATABASE_URL;
  });

  describe('in the store', () => {
    const real = db.query;
    after(() => { db.query = real; forgetAll(); });

    it('a failed load rejects, keeps nothing, and the next one loads everything', async () => {
      forgetAll();
      let fail = true;
      db.query = (async (text: string, params?: unknown[]) => {
        if (fail && /FROM queue_songs WHERE playlist_id/.test(text)) { fail = false; throw new Error('connection terminated'); }
        return real(text, params);
      }) as typeof db.query;
      await assert.rejects(getQueueAsync('qload001'), (err: Error) => err instanceof QueueUnavailableError && (err as Payload).code === 'QUEUE_UNAVAILABLE');
      const q = await getQueueAsync('qload001');
      assert.equal(q.getSongs().length, 3);
      db.query = real;
    });

    it('concurrent first requests share one load: none sees an empty queue', async () => {
      forgetAll();
      let selects = 0;
      db.query = (async (text: string, params?: unknown[]) => {
        if (/FROM queue_songs WHERE playlist_id/.test(text)) { selects++; await new Promise((r) => setTimeout(r, 200)); }
        return real(text, params);
      }) as typeof db.query;
      const all = await Promise.all([getQueueAsync('qload001'), getQueueAsync('qload001'), getQueueAsync('qload001')]);
      assert.equal(selects, 1);
      assert.ok(all.every((q) => q === all[0] && q.getSongs().length === 3));
      db.query = real;
    });

    it('concurrent requests during a load that fails all fail, and nothing is cached', async () => {
      forgetAll();
      let fail = true;
      db.query = (async (text: string, params?: unknown[]) => {
        if (fail && /FROM queue_songs WHERE playlist_id/.test(text)) { await new Promise((r) => setTimeout(r, 100)); fail = false; throw new Error('boom'); }
        return real(text, params);
      }) as typeof db.query;
      const results = await Promise.allSettled([getQueueAsync('qload001'), getQueueAsync('qload001')]);
      assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
      assert.equal((await getQueueAsync('qload001')).getSongs().length, 3, 'the next request loads');
      db.query = real;
    });
  });

  describe('over HTTP and Socket.IO', () => {
    let srv: Awaited<ReturnType<typeof startServer>>;
    let req: ReturnType<typeof requester>;
    const cookie = cookieFor(ALICE);
    before(async () => {
      await db.close();
      await pg.query(`INSERT INTO users (id, provider, provider_id, status, created_at) VALUES ($1, 'dev', 'alice', 'approved', 1) ON CONFLICT DO NOTHING`, [ALICE]);
      srv = await startServer({ DATABASE_URL: process.env.DATABASE_URL! });
      req = requester(srv.base);
      // Every queue load fails from here on (the server loads them lazily).
      await pg.query('ALTER TABLE queue_songs RENAME TO queue_songs_offline');
    });
    after(async () => {
      await pg.query('ALTER TABLE IF EXISTS queue_songs_offline RENAME TO queue_songs').catch(() => {});
      await srv?.stop();
    });

    it('GET songs is a 503 QUEUE_UNAVAILABLE, never 200 with no songs', async () => {
      const r = await req('GET', '/api/playlists/qload001/songs', { cookie });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'QUEUE_UNAVAILABLE');
      const list = await req('GET', '/api/playlists', { cookie });
      assert.equal(list.status, 503, 'the list (song counts) is not answered with zeros either');
    });

    it('a write on a playlist that did not load changes nothing', async () => {
      const add = await req('POST', '/api/playlists/qload001/songs', { cookie, body: { songs: [SONGS[0]], allow_duplicates: true } });
      assert.equal(add.status, 503);
      const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
      try {
        await new Promise<void>((r) => s.on('connect', () => r()));
        const error = new Promise<Payload>((r) => s.once('lobby:error', r));
        s.emit('lobby:join', { lobbyId: 'qload002' });
        assert.equal((await error).code, 'QUEUE_UNAVAILABLE', 'joining says so instead of showing an empty queue');
        for (const [event, body] of [['queue:clear', { lobbyId: 'qload002' }], ['queue:add', { lobbyId: 'qload002', libraryId: SONGS[0] }]] as const) {
          const err = new Promise<Payload>((r) => s.once('queue:error', r));
          s.emit(event, body);
          assert.equal((await err).code, 'QUEUE_UNAVAILABLE', event);
        }
      } finally { s.close(); }
      await pg.query('ALTER TABLE queue_songs_offline RENAME TO queue_songs');
      assert.equal(await count('qload001'), 3, 'nothing added');
      assert.equal(await count('qload002'), 3, 'nothing cleared');
    });

    it('once the database answers again, the next request has every song', async () => {
      const r = await req('GET', '/api/playlists/qload002/songs', { cookie });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.songs.map((x: Payload) => x.library_id), SONGS);
    });

    it('a failed library lookup is a 503 LIBRARY_UNAVAILABLE, not songs without their library ids', async () => {
      await pg.query('ALTER TABLE library_songs RENAME TO library_songs_offline');
      try {
        const r = await req('GET', '/api/playlists/qload002/songs', { cookie });
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'LIBRARY_UNAVAILABLE');
        // The song's own routes too: a 404 there would read as "this song is gone".
        for (const url of [`/api/library/${SONGS[0]}`, `/api/library/${SONGS[0]}/file`, `/api/library/${SONGS[0]}/replacements`]) {
          const song = await req('GET', url, { cookie });
          assert.deepEqual([song.status, song.body.code], [503, 'LIBRARY_UNAVAILABLE'], url);
        }
      } finally {
        await pg.query('ALTER TABLE library_songs_offline RENAME TO library_songs');
      }
      const ok = await req('GET', '/api/playlists/qload002/songs', { cookie });
      assert.deepEqual(ok.body.songs.map((x: Payload) => x.library_id), SONGS);
      assert.equal((await req('GET', '/api/library/00000000-0000-4000-8000-00000000dead', { cookie })).status, 404, 'a song that is not there is still a 404');
    });

    it('library_id null is only for an entry the library does not have', async () => {
      await pg.query(`INSERT INTO queue_songs (id, playlist_id, url, title, added_at, sort_order) VALUES (gen_random_uuid(), 'qload001', 'https://www.youtube.com/watch?v=zzzzzzzzzzz', 'Not here', 1, 10)`);
      // The server never loaded qload001 (every load so far failed): this one reads it all.
      const r = await req('GET', '/api/playlists/qload001/songs', { cookie });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.songs.map((x: Payload) => x.library_id), [...SONGS, null]);
    });
  });
});
