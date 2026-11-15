// Dashboard and profile routes answer when their storage fails (500, like
// their neighbours) instead of leaving the request hanging with an unhandled
// rejection, and the dashboard's status route accepts exactly the statuses the
// dashboard writes. In-process: the routers with stand-in dependencies.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAdminRouter } = require('./adminRoutes');
const { createProfileRouter } = require('./profileRoutes');

const pass = (req, res, next) => next();
const boom = async () => { throw new Error('connection terminated'); };

async function serve(router) {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A request that hangs fails the test by this timeout instead of the suite's.
  const req = (method, url, body) => fetch(base + url, {
    method, signal: AbortSignal.timeout(5000),
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { req, close: () => new Promise((r) => server.close(r)) };
}

describe('dashboard and profile routes when storage fails', () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  before(() => process.on('unhandledRejection', onRejection));
  after(() => process.off('unhandledRejection', onRejection));

  it('deleting a playlist or a chat message answers 500, nothing is left unhandled', async () => {
    const s = await serve(createAdminRouter({
      db: { isAvailable: () => true, query: boom }, lobby: { getLobby: () => ({ id: 'p1', ownerId: null, visibility: 'public' }) },
      apiLimiter: pass, adminAuth: { requireAdmin: pass }, destroyLobby: boom,
      getSocial: () => ({ deleteMessage: boom }), accountStatusChanged: async () => {},
    }));
    try {
      const del = await s.req('DELETE', '/api/dashboard/lobbies/p1');
      assert.equal(del.status, 500);
      assert.deepEqual(await del.json(), { error: 'Failed to delete playlist' });
      const msg = await s.req('DELETE', '/api/chat/messages/7');
      assert.equal(msg.status, 500);
      assert.deepEqual(await msg.json(), { error: 'Failed to delete message' });
    } finally { await s.close(); }
    assert.deepEqual(rejections, []);
  });

  it('the profile answers 500 when the account lookup fails', async () => {
    const s = await serve(createProfileRouter({
      db: { isAvailable: () => true, query: boom }, userAuth: { userIdFor: boom, invalidate() {} }, getSocial: () => null,
    }));
    try {
      assert.equal((await s.req('GET', '/api/profile')).status, 500);
      assert.equal((await s.req('PUT', '/api/profile', { displayName: 'X' })).status, 500);
    } finally { await s.close(); }
    assert.deepEqual(rejections, []);
  });
});

describe('dashboard: the status route takes what the dashboard writes', () => {
  it('approved, denied and rejected (the reject action\'s value); nothing else', async () => {
    const writes = [];
    const changed = [];
    const s = await serve(createAdminRouter({
      db: { isAvailable: () => true, query: async (sql, params) => { writes.push(params[0]); return { rows: [] }; } },
      apiLimiter: pass, adminAuth: { requireAdmin: pass },
      accountStatusChanged: async (id, status) => { changed.push([id, status]); },
    }));
    try {
      for (const status of ['approved', 'denied', 'rejected']) {
        const r = await s.req('POST', '/api/auth/users/u1/status', { status });
        assert.equal(r.status, 200, status);
      }
      for (const status of ['pending', 'banned', '', undefined, 'Approved']) {
        assert.equal((await s.req('POST', '/api/auth/users/u1/status', { status })).status, 400, String(status));
      }
      assert.equal((await s.req('POST', '/api/auth/users/u1/status')).status, 400, 'no body');
    } finally { await s.close(); }
    assert.deepEqual(writes, ['approved', 'denied', 'rejected']);
    assert.deepEqual(changed, [['u1', 'approved'], ['u1', 'denied'], ['u1', 'rejected']]);
  });
});
