// Skip silence on the real server and Postgres: the migration adds the two
// columns to a database from before them; an upload is measured soon after it
// is stored, the backfill picks up songs nobody measured, a replace forgets the
// old numbers and measures the new file; GET /api/stream/silence and the
// library views carry them. Real ffmpeg; generous waits (nothing here is timed).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startServer, cookieFor, adminCookie, requester } from '../../testing/testServer.ts';

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}
const has = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg/ffprobe not available' : false;

type Payload = any;

async function until<T>(fn: () => Promise<T>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('skip silence on Postgres', { skip, timeout: 300_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: pg.Client | undefined;
  let srv: Payload;
  let req: ReturnType<typeof requester>;
  let tmp: string;
  let token: string;
  let cookie: string;
  let n = 0;

  const file = (lead: number, music: number, tail: number) => {
    const f = path.join(tmp, `song-${n++}.m4a`);
    const parts = [`aevalsrc=0:s=48000:d=${lead}`, `aevalsrc=0.25*sin(2*PI*${300 + n * 17}*t):s=48000:d=${music}`, `aevalsrc=0:s=48000:d=${tail}`];
    const graph = `${parts.map((p, i) => `${p}[s${i}]`).join(';')};[s0][s1][s2]concat=n=3:v=0:a=1[out]`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-filter_complex', graph, '-map', '[out]', '-ac', '2', '-c:a', 'aac', '-f', 'mp4', f]);
    return f;
  };
  async function post(url: string, f: string, fields: Record<string, string>) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(f)], { type: 'audio/mp4' }), 'x.m4a');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(srv.base + url, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() as Payload };
  }
  const silence = async (q: string) => (await req('GET', `/api/stream/silence?q=${encodeURIComponent(q)}`, { cookie })).body;
  const boot = async () => {
    srv = await startServer({
      DATABASE_URL: container!.getConnectionUri(), SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      SILENCE_SCAN: 'on', SILENCE_START_DELAY_MS: '0', SILENCE_PAUSE_MS: '0',
    });
    req = requester(srv.base);
  };

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine').withDatabase('listen_silence').withUsername('test').withPassword('test').start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-silence-'));
    await boot();
    client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    const r = await client.query(`INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('dev', 'sil', 'Sil', 'Sil', 'approved', 1) RETURNING id`);
    cookie = cookieFor(r.rows[0].id);
    const t = await req('POST', '/api/tokens', { cookie, body: { label: 'x' } });
    assert.equal(t.status, 201, t.text);
    token = t.body.token;
  });

  after(async () => {
    if (client) await client.end().catch(() => {});
    if (srv) await srv.stop();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('an upload is measured soon after it is stored; the endpoint and the views say so', async () => {
    const up = await post('/api/library/upload', file(3, 5, 4), { title: 'Dead Air', artist: 'Video' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.ok('lead_silence_ms' in up.body.song, 'additive field in the song view');
    const id = up.body.song.id;
    const got = await until(async () => { const s = await silence(`library:${id}`); return s.lead_silence_ms !== null ? s : null; }, 'the measurement');
    assert.ok(Math.abs(got.lead_silence_ms - 3000) <= 150, JSON.stringify(got));
    assert.ok(Math.abs(got.trail_silence_ms - 4000) <= 150, JSON.stringify(got));
    const one = await req('GET', `/api/library/${id}`, { cookie });
    assert.equal(one.status, 200);
    assert.equal(one.body.song ? one.body.song.lead_silence_ms : one.body.lead_silence_ms, got.lead_silence_ms);
    const list = await req('GET', '/api/library', { cookie });
    const row = list.body.songs.find((s: Payload) => s.id === id);
    assert.equal(row.trail_silence_ms, got.trail_silence_ms);
  });

  it('a replace forgets the old numbers and measures the new file', async () => {
    const up = await post('/api/library/upload', file(2, 5, 2), { title: 'Replace Me', artist: 'Video' });
    const id = up.body.song.id;
    await until(async () => (await silence(`library:${id}`)).lead_silence_ms !== null, 'the first measurement');
    const rep = await post(`/api/library/${id}/replace`, file(0, 6, 3), { title: 'Replace Me', artist: 'Video' });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    const got = await until(async () => { const s = await silence(`library:${id}`); return s.lead_silence_ms === 0 ? s : null; }, 'the new measurement');
    assert.ok(Math.abs(got.trail_silence_ms - 3000) <= 150, JSON.stringify(got));
  });

  it('answers 404 NOT_IN_LIBRARY / 400 like /api/stream; admins see the progress', async () => {
    const miss = await req('GET', `/api/stream/silence?q=${encodeURIComponent('https://www.youtube.com/watch?v=zzzzzzzzzzz')}`, { cookie });
    assert.equal(miss.status, 404);
    assert.equal(miss.body.code, 'NOT_IN_LIBRARY');
    assert.equal((await req('GET', '/api/stream/silence', { cookie })).status, 400);
    assert.equal((await req('GET', '/api/stream/silence?q=library:x')).status, 401, 'signed-in only');
    const stats = await req('GET', '/api/admin/library/silence', { cookie: adminCookie() });
    assert.equal(stats.status, 200, stats.text);
    assert.equal(stats.body.enabled, true);
    assert.equal(typeof stats.body.measured, 'number');
    assert.equal((await req('GET', '/api/admin/library/silence', { cookie })).status, 401, 'not for a plain account');
  });

  it('an older database gets the columns; the backfill measures what is there', async () => {
    const up = await post('/api/library/upload', file(1.5, 5, 0), { title: 'Old Song', artist: 'Video' });
    const id = up.body.song.id;
    await until(async () => (await silence(`library:${id}`)).lead_silence_ms !== null, 'measured');
    await srv.stop();
    // The database as an older server left it: no such columns.
    await client!.query('ALTER TABLE library_songs DROP COLUMN lead_silence_ms, DROP COLUMN trail_silence_ms');
    await boot();
    const cols = await client!.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'library_songs' AND column_name LIKE '%silence_ms'`);
    assert.deepEqual(cols.rows.map((r) => r.column_name).sort(), ['lead_silence_ms', 'trail_silence_ms']);
    const got = await until(async () => {
      const r = await client!.query('SELECT count(*)::int AS n FROM library_songs WHERE lead_silence_ms IS NULL');
      return r.rows[0].n === 0 ? silence(`library:${id}`) : null;
    }, 'the backfill');
    assert.ok(Math.abs(got.lead_silence_ms - 1500) <= 150, JSON.stringify(got));
    assert.equal(got.trail_silence_ms, 0);
    assert.match(srv.log(), /\[silence\] measuring lead-in \/ tail silence: \d+ songs to go/);
  });
});
