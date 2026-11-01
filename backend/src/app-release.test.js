// GET /api/app/latest (appRelease.js) and the /app page: which release counts,
// the cache, what happens when GitHub fails, and who may see it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAppRelease, pickLatest, RELEASES_PAGE } = require('./appRelease');
const { policyFor } = require('./userAuth');
const { startServer, cookieFor } = require('./testServer');

const SHA = 'a'.repeat(64);
const DIGEST_SHA = 'b'.repeat(64);

function release(tag, overrides = {}) {
  const version = tag.replace('android-v', '');
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-11-01T10:00:00Z',
    html_url: `https://github.com/erkantaylan/listen-along/releases/tag/${tag}`,
    body: `SHA-256: ${SHA}\n\nWhat changed`,
    assets: [{
      name: `listen-along-${version}.apk`,
      size: 12345678,
      browser_download_url: `https://github.com/erkantaylan/listen-along/releases/download/${tag}/listen-along-${version}.apk`,
    }],
    ...overrides,
  };
}

function answer(body, { status = 200, etag = null } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => etag }, json: async () => body };
}

/** createAppRelease with a scripted fetch and a clock we control. */
function setup(script) {
  const calls = [];
  let t = 1000;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const next = script.length > 1 ? script.shift() : script[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const appRelease = createAppRelease({ fetchImpl, now: () => t, ttlMs: 600, retryMs: 100, log: () => {} });
  return { appRelease, calls, advance: (ms) => { t += ms; } };
}

describe('pickLatest', () => {
  it('takes the highest android version and ignores backend releases', () => {
    const v = pickLatest([release('v2.30.1'), release('android-v0.9.0'), release('android-v0.10.0'), release('android-v0.2.0')]);
    assert.equal(v.version, '0.10.0');
    assert.equal(v.tag, 'android-v0.10.0');
    assert.equal(v.apk.name, 'listen-along-0.10.0.apk');
    assert.equal(v.apk.size, 12345678);
    assert.equal(v.sha256, SHA);
  });

  it('skips drafts, prereleases and releases without a real APK', () => {
    assert.equal(pickLatest([
      release('android-v1.0.0', { draft: true }),
      release('android-v0.9.0', { prerelease: true }),
      release('android-v0.8.0', { assets: [] }),
      release('android-v0.7.0', { assets: [{ name: 'other.zip', browser_download_url: 'https://github.com/x' }] }),
      release('android-v0.6.0', { assets: [{ name: 'listen-along-0.6.0.apk', browser_download_url: 'https://evil.example/x.apk' }] }),
    ]), null);
  });

  it("prefers GitHub's own asset digest, and survives having no checksum", () => {
    const withDigest = release('android-v1.0.0');
    withDigest.assets[0].digest = `sha256:${DIGEST_SHA}`;
    assert.equal(pickLatest([withDigest]).sha256, DIGEST_SHA);
    assert.equal(pickLatest([release('android-v1.0.0', { body: 'no checksum' })]).sha256, null);
  });

  it('refuses an answer that is not a list', () => {
    assert.throws(() => pickLatest({ message: 'rate limited' }));
  });
});

describe('createAppRelease', () => {
  it('reuses the answer until the cache runs out, then revalidates with the ETag', async () => {
    const { appRelease, calls, advance } = setup([
      answer([release('android-v0.2.0')], { etag: '"one"' }),
      answer(null, { status: 304 }),
    ]);
    const first = await appRelease.latest();
    assert.equal(first.available, true);
    assert.equal(first.version, '0.2.0');
    assert.equal(first.stale, false);
    assert.equal(first.releasesUrl, RELEASES_PAGE);
    await appRelease.latest();
    assert.equal(calls.length, 1, 'cached');
    assert.equal(calls[0].headers['If-None-Match'], undefined);
    assert.ok(calls[0].headers['User-Agent'], 'GitHub refuses requests without one');
    assert.equal(calls[0].headers.Authorization, undefined, 'no token');

    advance(601);
    const again = await appRelease.latest();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers['If-None-Match'], '"one"');
    assert.equal(again.version, '0.2.0', 'a 304 keeps the known answer');
    assert.equal(again.stale, false);
  });

  it('asks GitHub once for simultaneous requests', async () => {
    const { appRelease, calls } = setup([answer([release('android-v0.2.0')])]);
    const all = await Promise.all([appRelease.latest(), appRelease.latest(), appRelease.latest()]);
    assert.equal(calls.length, 1);
    assert.ok(all.every((v) => v.version === '0.2.0'));
  });

  for (const [name, failure] of [
    ['a network error', new Error('getaddrinfo ENOTFOUND')],
    ['a 403 rate limit', answer({ message: 'rate limit' }, { status: 403 })],
    ['a 500', answer({}, { status: 500 })],
    ['garbage', { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad json'); } }],
  ]) {
    it(`${name}: no release known says unavailable, and it never rejects`, async () => {
      const { appRelease } = setup([failure]);
      assert.deepEqual(await appRelease.latest(), { available: false, reason: 'unavailable', releasesUrl: RELEASES_PAGE });
    });
  }

  it('a failure keeps serving the last good release, marked stale, and retries later', async () => {
    const { appRelease, calls, advance } = setup([
      answer([release('android-v0.2.0')], { etag: '"one"' }),
      new Error('down'),
      answer([release('android-v0.3.0')], { etag: '"two"' }),
    ]);
    await appRelease.latest();
    advance(601);
    const stale = await appRelease.latest();
    assert.equal(stale.version, '0.2.0');
    assert.equal(stale.stale, true);

    await appRelease.latest();
    assert.equal(calls.length, 2, 'does not hammer GitHub during an outage');
    advance(101);
    const back = await appRelease.latest();
    assert.equal(back.version, '0.3.0');
    assert.equal(back.stale, false);
  });

  it('tells "no android release yet" from "could not check"', async () => {
    const { appRelease } = setup([answer([release('v2.30.1')])]);
    assert.deepEqual(await appRelease.latest(), { available: false, reason: 'none', releasesUrl: RELEASES_PAGE });
  });

  it('a request that never answers times out instead of hanging the page', async () => {
    // AbortSignal.timeout's timer does not keep the process alive on its own.
    const keepAlive = setInterval(() => {}, 1000);
    const appRelease = createAppRelease({
      timeoutMs: 20,
      log: () => {},
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
    });
    assert.equal((await appRelease.latest()).reason, 'unavailable');
    clearInterval(keepAlive);
  });
});

describe('route policy', () => {
  it('/app is a login-only page, /api/app/latest also for pending accounts', () => {
    assert.equal(policyFor('/app'), 'page');
    assert.equal(policyFor('/api/app/latest'), 'member');
    assert.equal(policyFor('/API/App/Latest'), 'member');
    assert.equal(policyFor('/api/app/other'), 'approved', 'only that one endpoint');
  });
});

describe('/api/app/latest and /app on a running server', { timeout: 60_000 }, () => {
  let srv;
  let github;
  let mode = 'ok';

  before(async () => {
    // Stands in for GitHub: this test never leaves the machine.
    github = http.createServer((req, res) => {
      if (mode === 'down') { res.writeHead(503); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([release('android-v0.2.0')]));
    });
    await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));
    srv = await startServer({ APP_RELEASES_API_URL: `http://127.0.0.1:${github.address().port}/releases` });
  });

  after(async () => {
    if (srv) await srv.stop();
    if (github) await new Promise((resolve) => github.close(resolve));
  });

  it('refuses anonymous callers: 401 for the API, the login page for /app', async () => {
    const api = await fetch(`${srv.base}/api/app/latest`);
    assert.equal(api.status, 401);
    const page = await fetch(`${srv.base}/app`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login\?next=%2Fapp/);
  });

  it('serves the page and the release to a logged-in user', async () => {
    const headers = { Cookie: cookieFor('someone') };
    const page = await fetch(`${srv.base}/app`, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="app-view"/);
    const api = await fetch(`${srv.base}/api/app/latest`, { headers });
    assert.equal(api.status, 200);
    const body = await api.json();
    assert.equal(body.available, true);
    assert.equal(body.version, '0.2.0');
    assert.equal(body.sha256, SHA);
    assert.match(body.apk.url, /^https:\/\/github\.com\/.+listen-along-0\.2\.0\.apk$/);
  });

  it('does not depend on the page: a fresh server with GitHub down still answers 200', async () => {
    mode = 'down';
    const other = await startServer({ APP_RELEASES_API_URL: `http://127.0.0.1:${github.address().port}/releases` });
    try {
      const api = await fetch(`${other.base}/api/app/latest`, { headers: { Cookie: cookieFor('someone') } });
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { available: false, reason: 'unavailable', releasesUrl: RELEASES_PAGE });
    } finally {
      mode = 'ok';
      await other.stop();
    }
  });
});
