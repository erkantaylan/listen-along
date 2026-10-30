// Client IP behind Cloudflare -> Traefik (clientIp.js): which address the
// rate limits key on, and that a forged CF-Connecting-IP is ignored.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const clientIp = require('./clientIp');
const { make } = require('./rateLimits');
const { startServer, requester } = require('./testServer');

const CF_EDGE = '162.158.10.1'; // inside 162.158.0.0/15
const CF_EDGE6 = '2606:4700:10::1';

describe('clientIp rules', () => {
  const ip = clientIp.createClientIp();

  it('believes CF-Connecting-IP only from a Cloudflare address', () => {
    assert.equal(ip({ ip: CF_EDGE, headers: { 'cf-connecting-ip': '198.51.100.7' } }), '198.51.100.7');
    assert.equal(ip({ ip: CF_EDGE6, headers: { 'cf-connecting-ip': '2001:db8::7' } }), '2001:db8::7');
    assert.equal(ip({ ip: `::ffff:${CF_EDGE}`, headers: { 'cf-connecting-ip': '198.51.100.7' } }), '198.51.100.7');
    assert.equal(ip({ ip: '203.0.113.5', headers: { 'cf-connecting-ip': '198.51.100.7' } }), '203.0.113.5', 'forged header ignored');
    assert.equal(ip({ ip: '127.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.7' } }), '127.0.0.1', 'local dev: header ignored');
    assert.equal(ip({ ip: CF_EDGE, headers: { 'cf-connecting-ip': 'not-an-ip' } }), CF_EDGE, 'garbage header ignored');
    assert.equal(ip({ ip: CF_EDGE, headers: {} }), CF_EDGE);
  });

  it('TRUST_PROXY / CLOUDFLARE_IPS overrides', () => {
    assert.equal(clientIp.trustProxySetting({}), clientIp.DEFAULT_TRUST_PROXY);
    assert.equal(clientIp.trustProxySetting({ TRUST_PROXY: 'false' }), false);
    assert.equal(clientIp.trustProxySetting({ TRUST_PROXY: '2' }), 2);
    assert.equal(clientIp.trustProxySetting({ TRUST_PROXY: '10.0.0.0/8' }), '10.0.0.0/8');
    const none = clientIp.createClientIp({ ranges: clientIp.cloudflareRanges({ CLOUDFLARE_IPS: 'none' }) });
    assert.equal(none({ ip: CF_EDGE, headers: { 'cf-connecting-ip': '198.51.100.7' } }), CF_EDGE);
    const custom = clientIp.createClientIp({ ranges: clientIp.cloudflareRanges({ CLOUDFLARE_IPS: '192.0.2.0/24' }) });
    assert.equal(custom({ ip: '192.0.2.9', headers: { 'cf-connecting-ip': '198.51.100.7' } }), '198.51.100.7');
  });

  it('trusts only private / loopback hops (Traefik on the Docker network)', () => {
    const app = express();
    clientIp.install(app, { env: {} });
    const trust = app.get('trust proxy fn');
    for (const addr of ['127.0.0.1', '::1', '10.0.1.5', '172.18.0.3', '192.168.1.2', 'fd00::1']) assert.ok(trust(addr, 0), addr);
    for (const addr of ['8.8.8.8', CF_EDGE, '203.0.113.5', '2606:4700::1']) assert.ok(!trust(addr, 0), addr);
  });
});

describe('clientIp in an Express app (requests arrive from 127.0.0.1, like from Traefik)', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    clientIp.install(app, { env: {} });
    app.get('/ip', (req, res) => res.json({ ip: req.clientIp, reqIp: req.ip }));
    app.get('/limited', make(2), (req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((r) => server.close(r)));

  const get = async (url, headers = {}) => {
    const res = await fetch(base + url, { headers });
    return { status: res.status, body: await res.json() };
  };

  it('resolves the visitor through Cloudflare + Traefik', async () => {
    // Traefik replaces client-sent X-Forwarded-For with its peer (the edge);
    // anything a client prepends is ignored either way.
    let r = await get('/ip', { 'X-Forwarded-For': `6.6.6.6, ${CF_EDGE}`, 'CF-Connecting-IP': '198.51.100.7' });
    assert.deepEqual(r.body, { ip: '198.51.100.7', reqIp: CF_EDGE });
    // Bypassing Cloudflare (hitting Traefik directly) with a forged header.
    r = await get('/ip', { 'X-Forwarded-For': '203.0.113.50', 'CF-Connecting-IP': '1.1.1.1' });
    assert.equal(r.body.ip, '203.0.113.50');
    // Local dev, no proxy at all.
    r = await get('/ip', { 'CF-Connecting-IP': '1.1.1.1' });
    assert.equal(r.body.ip, '127.0.0.1');
  });

  it('gives each visitor their own rate-limit bucket', async () => {
    const a = { 'X-Forwarded-For': CF_EDGE, 'CF-Connecting-IP': '198.51.100.1' };
    const b = { 'X-Forwarded-For': CF_EDGE, 'CF-Connecting-IP': '198.51.100.2' };
    assert.equal((await get('/limited', a)).status, 200);
    assert.equal((await get('/limited', a)).status, 200);
    assert.equal((await get('/limited', a)).status, 429);
    assert.equal((await get('/limited', b)).status, 200, 'a different visitor through the same edge is not limited');
  });
});

describe('the real server keys rate limits on the visitor, not the proxy', { timeout: 60_000 }, () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { if (srv) await srv.stop(); });

  it('20/min on /api/youtube-playlist is per visitor behind Cloudflare', async () => {
    const req = requester(srv.base);
    const as = (ip) => ({ headers: { 'X-Forwarded-For': CF_EDGE, 'CF-Connecting-IP': ip }, body: {} });
    for (let i = 0; i < 20; i++) assert.notEqual((await req('POST', '/api/youtube-playlist', as('198.51.100.10'))).status, 429, `request ${i}`);
    assert.equal((await req('POST', '/api/youtube-playlist', as('198.51.100.10'))).status, 429);
    assert.notEqual((await req('POST', '/api/youtube-playlist', as('198.51.100.11'))).status, 429);
  });
});
