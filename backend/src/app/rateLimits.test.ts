// The general rate limit (rateLimits.apiLimiter) counts each request once,
// where its route is, and never a request that only passes a router by:
//   - the library router counts its own paths only (a route mounted after it
//     is not charged to it)
//   - on the real server (no database), every limited route lowers the
//     client's budget by exactly one, whichever way it is limited (the route
//     lists it, a path-scoped app.use in main.ts, the guard for the playlist
//     API), and /health, the build info and the legacy status checks never do
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { make } from '../shared/rateLimits.ts';
import { createLibraryRouter } from '../core/library/index.ts';
import { startServer, cookieFor, adminCookie } from '../testing/testServer.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

describe('the library router counts only its own paths', () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    const app = express();
    app.use(createLibraryRouter({ apiLimiter: make(2) }));
    app.get('/after', (req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('a route mounted after it is not charged; a library route costs exactly one', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/after`)).status, 200, 'passes by, never limited');
    // Budget 2: two library requests pass, the third is refused (a double count
    // would refuse the second).
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 429);
    assert.equal((await fetch(`${base}/after`)).status, 200, 'still not charged');
  });
});

describe('the real server: one count per limited request', { timeout: 60_000 }, () => {
  let srv: Server | undefined;
  const alice = cookieFor('00000000-0000-4000-8000-00000000a11c');
  const remaining = (res: Response) => {
    const m = /remaining=(\d+)/.exec(res.headers.get('ratelimit') || '');
    return m ? Number(m[1]) : null;
  };
  before(async () => { srv = await startServer({ APP_RELEASES_API_URL: 'http://127.0.0.1:9/none' }); });
  after(() => srv && srv.stop());

  const get = (url: string, headers: Record<string, string> = {}) => fetch(srv!.base + url, { headers, redirect: 'manual' });

  it('every limited route lowers the budget by exactly one; the rest never touch it', async () => {
    const limited: [string, Record<string, string>][] = [
      ['/api/stream', { cookie: alice }], // lists it
      ['/api/covers/x', { cookie: alice }],
      ['/dashboard', {}],
      ['/admin', {}],
      ['/api/library', { cookie: alice }], // the library router
      ['/api/admin/status', {}],
      ['/api/playlists', { cookie: alice }], // the guard, cookie
      ['/api/playlists', { authorization: 'Bearer la_not-a-token' }], // the guard, before the token check
      ['/api/admin/settings', { cookie: adminCookie() }], // lists it
      ['/api/dashboard/stats', { cookie: adminCookie() }], // main.ts, path-scoped
      ['/api/auth/users', { cookie: adminCookie() }],
      ['/api/auth/me', { cookie: alice }],
      ['/api/profile', { cookie: alice }],
      ['/api/stations/all', { cookie: alice }],
      ['/api/artists', { cookie: alice }],
      ['/api/tokens', { cookie: alice }],
      ['/api/playlist-folders', { cookie: alice }],
      ['/api/workers', { cookie: alice }], // jobRoutes, path-scoped
      ['/api/stream/silence?q=library:x', { cookie: alice }], // lists it (core/library/silenceRoutes.ts)
      ['/api/admin/library/silence', { cookie: adminCookie() }], // the library router's /api/admin/library
      ['/', { cookie: alice }],
      ['/library', { cookie: alice }],
      ['/login', {}],
      ['/changelog', {}],
      ['/api/changelog', {}],
    ];
    let before: number | null = null;
    for (const [url, headers] of limited) {
      const res = await get(url, headers);
      const left = remaining(res);
      assert.notEqual(left, null, `${url} is limited (status ${res.status})`);
      if (before !== null) assert.equal(left, before - 1, `${url} counted exactly once`);
      before = left;
    }
    for (const url of ['/health', '/api/version', '/api/auth/status']) {
      const res = await get(url, { cookie: alice });
      assert.equal(remaining(res), null, `${url} is not limited`);
    }
    // ...and they did not count either.
    assert.equal(remaining(await get('/api/stream', { cookie: alice })), before! - 1);
  });
});
