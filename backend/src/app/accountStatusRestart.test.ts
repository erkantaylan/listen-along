// A server restart must never change an account's status. shared/db.ts runs its
// migrations on every boot; an old line in it promoted every pending user to
// approved, so a deploy silently undid the admin's decisions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pgModule from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { cookieFor, startServer, requester } from '../testing/testServer.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}
const has = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('account status across server restarts', { skip, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client | undefined;
  let srv: Server | undefined;
  let tmp: string | undefined;
  let env: Record<string, string>;
  const ids: Record<string, string> = {};

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_status').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-status-test-'));
    env = { DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') };
    srv = await startServer(env); // first boot creates the schema
    pg = new pgModule.Client({ connectionString: url });
    await pg.connect();
    for (const status of ['approved', 'pending', 'denied', 'rejected']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', $1, $1, $1, 1) RETURNING id`,
        [status]
      );
      ids[status] = r.rows[0].id;
    }
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps pending / denied / rejected / approved exactly as they were, over two restarts', async () => {
    const statuses = async () => Object.fromEntries((await pg!.query('SELECT id, status FROM users')).rows.map((r) => [r.id, r.status]));
    const expected = await statuses();
    assert.equal(expected[ids.pending], 'pending');
    for (let i = 0; i < 2; i++) {
      await srv!.stop();
      srv = await startServer(env);
      assert.deepEqual(await statuses(), expected, `after restart ${i + 1}`);
    }
    const req = requester(srv!.base);
    const r = await req('GET', '/api/playlists', { cookie: cookieFor(ids.pending) });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACCOUNT_PENDING', 'still treated as pending');
  });
});
