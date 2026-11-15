// The per-IP rate limiter (rateLimits.make) on a bare Express app.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { make } from './rateLimits.ts';

describe('rateLimits', () => {
  it('returns 429 JSON once the per-IP limit is exceeded', async () => {
    const app = express();
    app.get('/x', make(2), (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    try {
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await fetch(url)).status, 200);
      const res = await fetch(url);
      assert.equal(res.status, 429);
      assert.match((await res.json() as { error: string }).error, /Too many requests/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
