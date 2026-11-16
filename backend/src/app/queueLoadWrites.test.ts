// Every WRITE path on a playlist whose songs did not load (the database failed
// on that one query) refuses and changes nothing: HTTP add / remove / move, the
// job picks add, socket queue:add (library id and picks) / remove / reorder /
// clear, and the reactions that write into queues (a fulfilled request's
// auto-add, a web job's songs, a replace rewriting entries). Only the load
// fails here (testing/queueLoadFault.cjs), the writes would reach the database: so the
// stored songs being intact afterwards proves the server refused them. Then
// the load works again and every request sees the original songs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pgModule from 'pg';
import { io as ioClient } from 'socket.io-client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../shared/db.ts';
import { getQueueAsync, hasQueue, deleteQueue, forgetAll } from '../core/queue/index.ts';
import { library } from '../core/library/index.ts';
import { createReactions } from './reactions.ts';
import type { ReactionsDeps } from './reactions.ts';
import { startServer, cookieFor, requester } from '../testing/testServer.ts';

// Server and database JSON.
type Payload = any;

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}

function dockerOk() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

const skip = !PostgreSqlContainer ? 'testcontainers package not installed' : !dockerOk() ? 'Docker not available' : false;
const ALICE = '00000000-0000-4000-8000-0000000a2200';
const SONGS = ['44444444-4444-4444-8444-444444444441', '44444444-4444-4444-8444-444444444442', '44444444-4444-4444-8444-444444444443'];
// In the library, in neither playlist: what the writes try to add.
const EXTRA = '44444444-4444-4444-8444-444444444444';
const EXTRA_YT = 'aaaaaaaaaaa';
const LISTS = ['qwrite01', 'qwrite02'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The next `event` on the socket, or a failure after 5 s (the old code answered nothing).
const next = (s: ReturnType<typeof ioClient>, event: string) => new Promise<Payload>((resolve, reject) => {
  const t = setTimeout(() => { s.off(event, on); reject(new Error(`no ${event} within 5 s`)); }, 5000);
  const on = (payload: Payload) => { clearTimeout(t); resolve(payload); };
  s.once(event, on);
});

describe('writes on a playlist whose songs did not load', { skip, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client;
  let original: string;
  const snapshot = async () => JSON.stringify((await pg.query(
    'SELECT id, lobby_id, url, title, sort_order FROM queue_songs ORDER BY lobby_id, sort_order, id')).rows);
  const entryIds = async (id: string) => (await pg.query(
    'SELECT id FROM queue_songs WHERE lobby_id = $1 ORDER BY sort_order', [id])).rows.map((r) => r.id as string);

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine').withDatabase('listen_qwrite').withUsername('t').withPassword('t').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    assert.ok(await db.init());
    pg = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const now = Date.now();
    await pg.query(`INSERT INTO users (id, provider, provider_id, status, created_at) VALUES ($1, 'dev', 'alice2', 'approved', 1)`, [ALICE]);
    for (const id of LISTS) {
      await pg.query(`INSERT INTO lobbies (id, host_id, name, visibility, created_at, last_activity) VALUES ($1, $2, $1, 'public', $3, $3)`, [id, ALICE, now]);
    }
    for (const [i, s] of [...SONGS, EXTRA].entries()) {
      await pg.query(`INSERT INTO library_songs (id, title, artist, duration_sec, file_path, sha256, uploaded_by, youtube_id) VALUES ($1, $2, 'Band', 3, '/x', $3, 't', $4)`,
        [s, `Song ${i}`, String(i + 4).repeat(64), s === EXTRA ? EXTRA_YT : null]);
    }
    for (const [i, s] of SONGS.entries()) {
      for (const id of LISTS) {
        await pg.query(`INSERT INTO queue_songs (id, lobby_id, url, title, added_at, sort_order) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [id, `library:${s}`, `Song ${i} - Band`, now, i]);
      }
    }
    original = await snapshot();
  });

  after(async () => {
    await pg?.end();
    await db.close();
    await container?.stop();
    delete process.env.DATABASE_URL;
  });

  describe('over HTTP and Socket.IO', () => {
    let srv: Awaited<ReturnType<typeof startServer>>;
    let req: ReturnType<typeof requester>;
    const cookie = cookieFor(ALICE);
    const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-qwrite-')), 'fail');

    before(async () => {
      fs.writeFileSync(flag, '');
      srv = await startServer({
        DATABASE_URL: process.env.DATABASE_URL!,
        QUEUE_LOAD_FAULT_FILE: flag,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(import.meta.dirname, '..', 'testing', 'queueLoadFault.cjs')}`.trim(),
      });
      req = requester(srv.base);
    });
    after(async () => { await srv?.stop(); });

    it('every HTTP write answers 5xx and changes nothing', async () => {
      const [first, second] = await entryIds(LISTS[0]);
      // Every write first, then the checks: the stored songs before the answers.
      const add = await req('POST', `/api/playlists/${LISTS[0]}/songs`, { cookie, body: { songs: [EXTRA], allow_duplicates: true } });
      const remove = await req('DELETE', `/api/playlists/${LISTS[0]}/songs/${first}`, { cookie });
      const move = await req('POST', `/api/playlists/${LISTS[0]}/songs/${second}/move`, { cookie, body: { position: 1 } });
      const picks = await req('POST', '/api/jobs', { cookie, body: { picks: [EXTRA_YT], playlist_id: LISTS[0], allow_duplicates: true } });
      await sleep(300);
      assert.equal(await snapshot(), original);
      assert.deepEqual([add, remove, move].map((r) => [r.status, r.body.code]), Array(3).fill([503, 'QUEUE_UNAVAILABLE']));
      assert.equal(picks.status, 500, JSON.stringify(picks.body));
    });

    it('every socket write answers queue:error QUEUE_UNAVAILABLE and changes nothing', async () => {
      const [first, second] = await entryIds(LISTS[1]);
      const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
      const answers: string[] = [];
      try {
        await new Promise<void>((r) => s.on('connect', () => r()));
        // Joining puts the socket in the playlist's room (so the writes reach
        // the queue), then says the songs could not be loaded.
        const joined = next(s, 'lobby:error');
        s.emit('lobby:join', { lobbyId: LISTS[1] });
        answers.push(`lobby:join: ${(await joined.catch((e: Error) => ({ code: e.message }))).code}`);
        const writes: Array<[string, Payload]> = [
          ['queue:add', { lobbyId: LISTS[1], libraryId: EXTRA }],
          ['queue:add', { lobbyId: LISTS[1], picks: [EXTRA_YT] }],
          ['queue:remove', { lobbyId: LISTS[1], songId: first }],
          ['queue:reorder', { lobbyId: LISTS[1], songId: second, newIndex: 0 }],
          ['queue:clear', { lobbyId: LISTS[1] }],
        ];
        for (const [event, body] of writes) {
          const err = next(s, 'queue:error');
          s.emit(event, body);
          const got = await err.catch((e: Error) => ({ code: e.message }));
          answers.push(`${event} ${JSON.stringify(body)}: ${got.code}`);
        }
      } finally { s.close(); }
      await sleep(300);
      assert.equal(await snapshot(), original);
      assert.ok(answers.every((a) => a.endsWith(': QUEUE_UNAVAILABLE')), answers.join('\n'));
    });

    it('once the load works, every list has its original songs in order', async () => {
      fs.rmSync(flag);
      for (const id of LISTS) {
        const r = await req('GET', `/api/playlists/${id}/songs`, { cookie });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.songs.map((x: Payload) => x.library_id), SONGS);
      }
      assert.equal(await snapshot(), original);
    });
  });

  describe('reactions (in process)', () => {
    const real = db.query;
    let failing = true;
    const emitted: Array<[string, unknown]> = [];
    const io = { to: () => ({ emit: (event: string, payload: unknown) => { emitted.push([event, payload]); } }) };
    let reactions: ReturnType<typeof createReactions>;

    before(async () => {
      await db.init();
      forgetAll();
      db.query = (async (text: string, params?: unknown[]) => {
        if (failing && /FROM queue_songs WHERE lobby_id = \$1 ORDER BY sort_order/.test(text)) throw new Error('connection terminated');
        return real(text, params);
      }) as typeof db.query;
      const deps = {
        io, db, getQueueAsync, hasQueue, deleteQueue, library,
        playlist: {
          getPlaylistAsync: (id: string) => (LISTS.includes(id) ? { id, ownerId: ALICE, visibility: 'public' } : null),
          getAllPlaylists: () => LISTS.map((id) => ({ id })),
          deletePlaylistAsync: async () => false,
        },
        covers: { cacheCover: async () => null },
        downloadJobs: { settleForFulfilledRequests: async () => [], activeReplaceJob: async () => null, toPublic: (r: unknown) => r },
        playlistPins: { forgetPlaylist: async () => {} },
        userAuth: { invalidate: () => {} },
        sessionStore: null,
        activityFeed: { jobChanged: () => {} },
        getWorkerHub: () => ({ stats: () => ({}), dispatch: () => {} }),
        getSocial: () => null,
        APP_ROOM: 'app', userRoom: (id: string) => `user:${id}`, sessionRoom: (h: string) => `session:${h}`,
      };
      reactions = createReactions(deps as unknown as ReactionsDeps);
    });
    after(() => { db.query = real; forgetAll(); });

    it('a fulfilled request, a web job and a replace add or rewrite nothing', async () => {
      const extra = await library.getById(EXTRA);
      const song0 = await library.getById(SONGS[0]);
      assert.ok(extra && song0);
      // An upload fulfilled a request of each playlist: the auto-add.
      await reactions.handleLibrarySongAdded(extra, LISTS.map((id) => ({ id: `r-${id}`, lobby_id: id, requested_by: 'Bob' })) as Payload);
      // A web download job for a playlist finished.
      await assert.rejects(reactions.addJobSongsToPlaylist({ source: 'web', playlist_id: LISTS[0], requested_by_user_id: ALICE, requested_by: 'Alice' } as Payload, [extra]));
      // A song in both playlists was replaced, then had its details edited.
      await reactions.handleLibrarySongReplaced({ ...song0, title: 'New title', youtube_id: 'bbbbbbbbbbb' }, song0);
      await reactions.handleLibrarySongDetailsChanged({ ...song0, title: 'Other title' }, song0);
      await sleep(300);
      assert.equal(await snapshot(), original);
      assert.ok(!emitted.some(([event]) => event === 'queue:update' || event === 'request:fulfilled'), 'no client is told of a change');
    });

    it('with the load working again, the same auto-add appends after the stored songs', async () => {
      failing = false;
      const extra = await library.getById(EXTRA);
      await reactions.handleLibrarySongAdded(extra!, [{ id: 'r', lobby_id: LISTS[0], requested_by: 'Bob' }] as Payload);
      await sleep(300);
      const urls = (await pg.query('SELECT url FROM queue_songs WHERE lobby_id = $1 ORDER BY sort_order', [LISTS[0]])).rows.map((r) => r.url);
      assert.deepEqual(urls, [...SONGS.map((s) => `library:${s}`), library.queueUrlFor(extra!)]);
    });
  });
});
