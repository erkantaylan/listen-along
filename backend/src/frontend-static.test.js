// Static files of the web app (frontendStatic.js): compiled TypeScript from
// <frontend>/dist and the rest of <frontend>, both at the site root, with
// build configuration answering 404. Runs the real server (no database).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./testServer');
const { isBuildConfig } = require('./frontendStatic');

const REAL_FRONTEND = path.join(__dirname, '..', '..', 'frontend');

function makeFrontend({ dist }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-frontend-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('index.html', '<!doctype html>');
  write('app.css', 'body{}');
  write('old.js', 'export const where = "old";');
  write('both.js', 'export const where = "stale old file";');
  write('package.json', '{"type":"module","private":true}');
  write('tsconfig.json', '{}');
  write('frontend.tsbuildinfo', '{}');
  write('src/both.ts', 'export const where: string = "compiled";');
  if (dist) {
    write('dist/both.js', 'export const where = "compiled";\n//# sourceMappingURL=both.js.map');
    write('dist/both.js.map', '{"version":3,"sources":["../src/both.ts"]}');
    write('dist/shared/deep.js', 'export const deep = 1;');
  }
  return dir;
}

async function get(base, url) {
  const res = await fetch(base + url, { redirect: 'manual' });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('isBuildConfig', () => {
  it('matches build files however the path is spelled', () => {
    for (const p of ['/package.json', '/tsconfig.json', '/PACKAGE.JSON', '/%70ackage.json', '//tsconfig.json',
      '/src/../package.json', '/x.tsbuildinfo', '/dist', '/dist/app.js', '/a/../dist/app.js']) {
      assert.equal(isBuildConfig(p), true, p);
    }
  });
  it('leaves site assets alone', () => {
    for (const p of ['/app.js', '/app.css', '/locales/en.json', '/vendor/x/package.json', '/src/x.ts', '/distance.js', '/%E0%A4%A']) {
      assert.equal(isBuildConfig(p), false, p);
    }
  });
});

describe('frontend static files with a built dist/', () => {
  let srv, dir;
  before(async () => { dir = makeFrontend({ dist: true }); srv = await startServer({ FRONTEND_PATH: dir }); });
  after(async () => { await srv?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('serves compiled modules at the site root, no-cache, and they win over an old file of the same name', async () => {
    const r = await get(srv.base, '/both.js');
    assert.equal(r.status, 200);
    assert.match(r.text, /"compiled"/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.match(r.headers.get('content-type'), /javascript/);
    const deep = await get(srv.base, '/shared/deep.js');
    assert.equal(deep.status, 200);
    assert.equal(deep.headers.get('cache-control'), 'no-cache');
  });

  it('still serves files that are not compiled from frontend/', async () => {
    const r = await get(srv.base, '/old.js');
    assert.equal(r.status, 200);
    assert.match(r.text, /"old"/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const css = await get(srv.base, '/app.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('cache-control'), 'no-cache');
  });

  it('serves source maps and the .ts sources they point at', async () => {
    const map = await get(srv.base, '/both.js.map');
    assert.equal(map.status, 200);
    assert.equal(map.headers.get('cache-control'), 'no-cache');
    // "../src/both.ts" relative to /both.js.map is /src/both.ts
    const src = await get(srv.base, '/src/both.ts');
    assert.equal(src.status, 200);
    assert.match(src.headers.get('content-type'), /^text\/plain/);
    assert.match(src.text, /compiled/);
  });

  it('answers 404 for build configuration and for /dist/ itself', async () => {
    for (const url of ['/package.json', '/tsconfig.json', '/%70ackage.json', '/frontend.tsbuildinfo', '/dist/both.js']) {
      const r = await get(srv.base, url);
      assert.equal(r.status, 404, url);
      assert.doesNotMatch(r.text, /"type"|compiled/, url);
    }
  });
});

describe('frontend static files without dist/ (fresh checkout, not built)', () => {
  let srv, dir;
  before(async () => { dir = makeFrontend({ dist: false }); srv = await startServer({ FRONTEND_PATH: dir }); });
  after(async () => { await srv?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('serves frontend/ as before and never errors on the missing folder', async () => {
    const r = await get(srv.base, '/both.js');
    assert.equal(r.status, 200);
    assert.match(r.text, /stale old file/);
    const missing = await get(srv.base, '/not-there.js');
    assert.ok(missing.status < 500, `status ${missing.status}`);
    const health = await get(srv.base, '/health');
    assert.equal(health.status, 200);
  });
});

describe('the real frontend', () => {
  let srv;
  before(async () => { srv = await startServer({ FRONTEND_PATH: REAL_FRONTEND }); });
  after(async () => { await srv?.stop(); });

  it('serves /app.js and hides package.json / tsconfig.json', async () => {
    const app = await get(srv.base, '/app.js');
    assert.equal(app.status, 200);
    assert.equal(app.headers.get('cache-control'), 'no-cache');
    assert.equal((await get(srv.base, '/package.json')).status, 404);
    assert.equal((await get(srv.base, '/tsconfig.json')).status, 404);
  });

  // The build probe (frontend/src/build-probe.ts): needs `npm run build` at the
  // repo root first, as CI does. Delete with the probe.
  const built = fs.existsSync(path.join(REAL_FRONTEND, 'dist', 'build-probe.js'));
  it('serves the compiled /build-probe.js', { skip: built ? false : 'frontend not built (npm run build)' }, async () => {
    const r = await get(srv.base, '/build-probe.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.match(r.text, /export const BUILD_PROBE/);
  });
});
