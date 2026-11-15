// OpenTelemetry (telemetry.js preload + telemetryRules.js): off by default with
// nothing loaded or patched, and when on, what reaches an OTLP receiver.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync, execSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cookieFor, startServer } = require('./testServer');
const rules = require('./telemetryRules');

const TELEMETRY = path.join(__dirname, 'telemetry.js');

/** The environment minus every OTEL_* variable a developer's shell may carry. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('OTEL_')) delete env[k];
  delete env.NODE_OPTIONS;
  return { ...env, ...extra };
}

/** A local OTLP/HTTP (JSON) receiver: collects what the exporters send. */
async function startReceiver() {
  const got = { traces: [], metrics: [], other: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const entry = { path: req.url, headers: req.headers, raw: body };
      try { entry.json = JSON.parse(body); } catch {}
      if (req.url === '/v1/traces') got.traces.push(entry);
      else if (req.url === '/v1/metrics') got.metrics.push(entry);
      else got.other.push(entry);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    got,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const attrsOf = (span) => Object.fromEntries((span.attributes || []).map((a) => [a.key, Object.values(a.value)[0]]));
function spansOf(got) {
  const out = [];
  for (const e of got.traces) {
    for (const rs of e.json?.resourceSpans || []) {
      const resource = Object.fromEntries((rs.resource?.attributes || []).map((a) => [a.key, Object.values(a.value)[0]]));
      for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) out.push({ ...s, attrs: attrsOf(s), scope: ss.scope?.name, resource });
    }
  }
  return out;
}
function metricNames(got) {
  const names = new Set();
  for (const e of got.metrics) for (const rm of e.json?.resourceMetrics || []) for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) names.add(m.name);
  return names;
}

describe('telemetry: off by default', () => {
  // Loads the preload exactly as the AppHost and NODE_OPTIONS do, then reports
  // what it left behind after the app's own modules are loaded.
  const PROBE = `
    const http = require('http');
    const { Client } = require('pg');
    const t = require(${JSON.stringify(TELEMETRY)});
    setImmediate(() => console.log(JSON.stringify({
      started: t.started,
      otelModules: Object.keys(require.cache).filter((k) => k.includes('@opentelemetry')).length,
      httpPatched: !!(http.request.__wrapped || http.Server.prototype.emit.__wrapped),
      pgPatched: !!Client.prototype.query.__wrapped,
      consolePatched: console.log.name === 'withTraceId',
      signalListeners: process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'),
      handles: process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap'),
    })));
  `;
  const probe = (env) => {
    const out = execFileSync(process.execPath, ['--require', TELEMETRY, '-e', PROBE], {
      cwd: path.join(__dirname, '..'), env: cleanEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out.trim().split('\n');
    return { report: JSON.parse(lines.at(-1)), extra: lines.slice(0, -1) };
  };

  it('without an endpoint nothing is loaded, patched, scheduled or logged', () => {
    const { report, extra } = probe({});
    assert.deepEqual(report, {
      started: false, otelModules: 0, httpPatched: false, pgPatched: false,
      consolePatched: false, signalListeners: 0, handles: report.handles.filter((h) => h === 'Immediate'),
    });
    assert.deepEqual(extra, [], 'no output');
  });

  it('OTEL_SDK_DISABLED=true keeps it off even with an endpoint', () => {
    const { report, extra } = probe({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_SDK_DISABLED: 'true' });
    assert.equal(report.started, false);
    assert.equal(report.otelModules, 0);
    assert.deepEqual(extra, []);
  });

  it('a gRPC endpoint is refused with one warning, nothing loaded', () => {
    const res = spawnSyncProbe({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' });
    assert.equal(res.report.started, false);
    assert.equal(res.report.otelModules, 0);
    assert.match(res.stderr, /\[telemetry\] not started: OTEL_EXPORTER_OTLP_PROTOCOL=grpc/);
  });

  function spawnSyncProbe(env) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['--require', TELEMETRY, '-e', PROBE], {
      cwd: path.join(__dirname, '..'), env: cleanEnv(env), encoding: 'utf8',
    });
    return { report: JSON.parse(r.stdout.trim().split('\n').at(-1)), stderr: r.stderr };
  }

  it('with an endpoint it starts and patches http and pg (control)', () => {
    const { report } = probe({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    assert.equal(report.started, true);
    assert.ok(report.otelModules > 0);
    assert.equal(report.httpPatched, true);
    assert.equal(report.pgPatched, true);
    assert.equal(report.consolePatched, true);
  });
});

describe('telemetry rules', () => {
  it('starts only with an OTLP endpoint over HTTP', () => {
    assert.equal(rules.telemetryConfig({}).enabled, false);
    assert.equal(rules.telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }).enabled, false);
    assert.equal(rules.telemetryConfig({ OTEL_SERVICE_NAME: 'x' }).enabled, false);
    const on = rules.telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pw@otel.example:4318/base' });
    assert.equal(on.enabled, true);
    assert.equal(on.protocol, 'http/protobuf');
    assert.equal(on.serviceName, 'listen-along');
    assert.equal(on.endpointOrigin, 'https://otel.example:4318', 'never the credentials or path');
    assert.equal(rules.telemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://c:4318/v1/traces' }).enabled, true);
    assert.equal(rules.telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SERVICE_NAME: 'la-2' }).serviceName, 'la-2');
    assert.equal(rules.telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }).enabled, false);
    assert.equal(rules.telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }).protocol, 'http/json');
  });

  it('reads the sampler and the intervals the SDK no longer reads itself', () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' };
    assert.equal(rules.telemetryConfig(base).sampleRatio, 1);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1' }).sampleRatio, 0.1);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_TRACES_SAMPLER: 'always_off' }).sampleRatio, 0);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: 'x' }).sampleRatio, 1);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_BSP_SCHEDULE_DELAY: '1000' }).traceDelayMs, 1000);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_BSP_SCHEDULE_DELAY: '-5' }).traceDelayMs, 5000);
    assert.equal(rules.telemetryConfig({ ...base, OTEL_METRIC_EXPORT_INTERVAL: '10' }).metricIntervalMs, 60000);
  });

  it('does not trace the health probe, static files or Socket.IO polling', () => {
    for (const p of ['/health', '/health?x=1', '/app.js', '/shared/x.js?v=3', '/styles/app.css', '/favicon.ico', '/socket.io/?EIO=4&transport=polling']) {
      assert.equal(rules.ignoreIncomingPath(p), true, p);
    }
    for (const p of ['/', '/api/playlists', '/playlist/abc', '/auth/oidc/callback?code=x', '/api/library/1/file', '/healthz']) {
      assert.equal(rules.ignoreIncomingPath(p), false, p);
    }
  });

  it('keeps no query string, header, body, client address or SQL value', () => {
    const out = rules.sanitizeAttributes({
      'url.full': 'https://u:p@id.example/application/o/token/?code=SECRET#frag',
      'http.url': 'http://localhost:3100/auth/oidc/callback?code=SECRET&state=S',
      'http.target': '/auth/oidc/callback?code=SECRET',
      'url.path': '/auth/oidc/callback',
      'url.query': 'code=SECRET',
      'http.route': '/api/playlists/:id',
      'http.request.header.cookie': ['la_session=SECRET'],
      'http.request.header.authorization': ['Bearer la_SECRET'],
      'http.response.header.set-cookie': ['x=SECRET'],
      'db.query.text': "SELECT * FROM users WHERE email = 'a@b.c' AND id = $1",
      'db.statement': "UPDATE t SET body = 'it''s SECRET' WHERE id = $2",
      'db.postgresql.values': ['SECRET'],
      'db.query.parameter.0': 'SECRET',
      'client.address': '203.0.113.9',
      'network.peer.address': '10.0.0.2',
      'http.response.status_code': 200,
      'user_agent.original': 'curl/8',
    }, { server: true });
    assert.deepEqual(out, {
      'url.full': 'https://id.example/application/o/token/',
      'http.url': 'http://localhost:3100/auth/oidc/callback',
      'http.target': '/auth/oidc/callback',
      'url.path': '/auth/oidc/callback',
      'http.route': '/api/playlists/:id',
      'db.query.text': "SELECT * FROM users WHERE email = '?' AND id = $1",
      'db.statement': "UPDATE t SET body = '?' WHERE id = $2",
      'http.response.status_code': 200,
      'user_agent.original': 'curl/8',
    });
    // A client span keeps the address of the server it called.
    assert.equal(rules.sanitizeAttributes({ 'network.peer.address': '10.0.0.2' })['network.peer.address'], '10.0.0.2');
    // A route registered for two paths at once keeps the one that matched.
    assert.equal(rules.sanitizeAttributes({ 'http.route': '/api/playlists/:id,/api/lobbies/:id', 'url.path': '/api/lobbies/ab12' }, { server: true })['http.route'], '/api/lobbies/:id');
    assert.equal(rules.pickRoute('/api/playlists,/api/lobbies', '/api/playlists'), '/api/playlists');
    assert.equal(rules.pickRoute('/api/playlists/:id', '/x'), '/api/playlists/:id');
    assert.equal(rules.sanitizeSpanName('GET https://x/y?token=SECRET'), 'GET https://x/y');
    assert.equal(rules.sanitizeSpanName('GET /api/playlists/:id'), 'GET /api/playlists/:id');
  });
});

// The real server with the preload loaded through NODE_OPTIONS (as in the Docker
// image), exporting to a receiver in this test. The batch delay and the metric
// interval are a minute, so everything the receiver gets arrives through the
// shutdown flush on SIGTERM.
async function runServer(receiver, extraEnv = {}) {
  const srv = await startServer({
    NODE_OPTIONS: `--require=${TELEMETRY}`,
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_BSP_SCHEDULE_DELAY: '60000',
    OTEL_METRIC_EXPORT_INTERVAL: '60000',
    OTEL_SERVICE_NAME: '',
    ...extraEnv,
  });
  const stopGracefully = async () => {
    const t0 = Date.now();
    const exited = new Promise((r) => srv.proc.once('exit', (code, signal) => r({ code, signal })));
    srv.proc.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    if (result === 'timeout') await srv.stop();
    return { result, ms: Date.now() - t0 };
  };
  return { srv, stopGracefully };
}

describe('telemetry: on, against a local OTLP receiver', { timeout: 60_000 }, () => {
  let receiver;
  let run;
  let exit;
  let payload;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-otel-'));

  before(async () => {
    receiver = await startReceiver();
    run = await runServer(receiver, { SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    const base = run.srv.base;
    const cookie = cookieFor('otel-user-1');
    await fetch(`${base}/health`);
    await fetch(`${base}/app.css`);
    await fetch(`${base}/api/playlists/abcd1234?token=QUERYSECRET`, { headers: { cookie } });
    await fetch(`${base}/api/lobbies/efgh5678`, { headers: { authorization: 'Bearer la_HEADERSECRET' } });
    await fetch(`${base}/auth/oidc/callback?code=CODESECRET&state=STATESECRET`, { redirect: 'manual' });
    await fetch(`${base}/api/playlists`, { headers: { cookie } });
    exit = await run.stopGracefully();
    payload = JSON.stringify(receiver.got);
  });

  after(async () => {
    if (receiver) await receiver.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('SIGTERM flushes and the process still exits promptly', () => {
    assert.deepEqual(exit.result, { code: 0, signal: null }, run.srv.log());
    assert.ok(exit.ms < 5000, `exit took ${exit.ms}ms`);
    assert.ok(receiver.got.traces.length > 0, 'spans arrived (only the shutdown flush sends them)');
    assert.ok(receiver.got.metrics.length > 0, 'metrics arrived');
  });

  it('server spans are named by route template, not by raw path', () => {
    const server = spansOf(receiver.got).filter((s) => s.kind === 2);
    const names = server.map((s) => s.name).sort();
    assert.ok(names.includes('GET /api/playlists/:id'), names.join(', '));
    assert.ok(names.includes('GET /api/playlists'), names.join(', '));
    assert.ok(!names.some((n) => /abcd1234/.test(n)), names.join(', '));
    const one = server.find((s) => s.name === 'GET /api/playlists/:id');
    assert.equal(one.attrs['http.route'], '/api/playlists/:id');
    assert.equal(one.attrs['url.path'], '/api/playlists/abcd1234');
    assert.equal(one.resource['service.name'], 'listen-along');
  });

  it('no span for /health or static files', () => {
    const paths = spansOf(receiver.got).map((s) => s.attrs['url.path']).filter(Boolean);
    assert.ok(!paths.includes('/health'), paths.join(', '));
    assert.ok(!paths.some((p) => p.endsWith('.css')), paths.join(', '));
  });

  it('no query string, cookie, Authorization header or OIDC code leaves the process', () => {
    for (const secret of ['QUERYSECRET', 'HEADERSECRET', 'CODESECRET', 'STATESECRET', 'la_dev_login', 'cookie', 'authorization']) {
      assert.ok(!payload.includes(secret), `${secret} found in the export`);
    }
    const callback = spansOf(receiver.got).find((s) => s.attrs['url.path'] === '/auth/oidc/callback');
    assert.ok(callback, 'the callback request is traced');
    assert.equal(callback.attrs['url.query'], undefined);
  });

  it('exports HTTP and runtime metrics', () => {
    const names = metricNames(receiver.got);
    assert.ok(names.has('http.server.request.duration'), [...names].join(', '));
    assert.ok([...names].some((n) => n.startsWith('nodejs.') || n.startsWith('v8js.')), [...names].join(', '));
  });

  it('log lines written during a request carry its trace id', () => {
    const traceIds = new Set(spansOf(receiver.got).map((s) => s.traceId));
    const tagged = run.srv.log().split('\n').filter((l) => /\[http\] GET \/api\/playlists/.test(l));
    assert.ok(tagged.length > 0, run.srv.log());
    for (const line of tagged) {
      const m = line.match(/trace_id=([0-9a-f]{32}) span_id=[0-9a-f]{16}/);
      assert.ok(m, line);
      assert.ok(traceIds.has(m[1]), `${m[1]} is an exported trace`);
    }
  });
});

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skipDb = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('telemetry: database spans', { skip: skipDb, timeout: 180_000 }, () => {
  let container;
  let receiver;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-otel-db-'));
  const LOOKED_UP = '6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab'; // not a user: the lookup is the point

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_otel').withUsername('test').withPassword('pwSECRET').start();
    receiver = await startReceiver();
    const run = await runServer(receiver, {
      DATABASE_URL: container.getConnectionUri(),
      SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
    });
    // SELECT id FROM users WHERE id::text = $1, with the id as the parameter.
    const res = await fetch(`${run.srv.base}/auth/dev/login?user=${LOOKED_UP}`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    const exit = await run.stopGracefully();
    assert.deepEqual(exit.result, { code: 0, signal: null });
  });

  after(async () => {
    if (receiver) await receiver.close();
    if (container) await container.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a query made while serving a request is a child span with its statement, not its values', () => {
    const spans = spansOf(receiver.got);
    const login = spans.find((s) => s.kind === 2 && s.attrs['http.route'] === '/auth/dev/login');
    assert.ok(login, spans.map((s) => s.name).join(', '));
    const queries = spans.filter((s) => s.traceId === login.traceId && s.attrs['db.query.text']);
    const lookup = queries.find((s) => /WHERE id::text = \$1/.test(s.attrs['db.query.text']));
    assert.ok(lookup, queries.map((s) => s.attrs['db.query.text']).join(' | '));
    assert.equal(lookup.parentSpanId, login.spanId);
    const payload = JSON.stringify(receiver.got);
    assert.ok(!payload.includes(LOOKED_UP), 'the parameter value is not exported');
    assert.ok(!payload.includes('pwSECRET'), 'the database password is not exported');
  });

  it('boot-time queries (no request) are not traced', () => {
    const orphanQueries = spansOf(receiver.got).filter((s) => s.attrs['db.query.text'] && !s.parentSpanId);
    assert.deepEqual(orphanQueries.map((s) => s.attrs['db.query.text']), []);
  });
});
