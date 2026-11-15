// listen-along -- LOCAL DEVELOPMENT ONLY. One command brings up everything the
// server needs on a laptop; nothing here is used by the Docker image, the
// compose files or CI, and every secret below is a dev literal that exists only
// on this machine.
//
//   make up      (= cd aspire && aspire run --detach --non-interactive --nologo --format Json)
//   make down    (= aspire stop, then a sweep for anything left behind)
//
// Resources:
//   postgres + listen   Postgres 16 with a data volume (kept across runs), database `listen`
//   pgweb               a browser for that database (LISTEN_PGWEB=0 leaves it out)
//   frontend            `tsc -b frontend -w`: frontend/src/*.ts -> frontend/dist on every save
//   listen-along        the server, `node --watch` (restarts on a backend edit), dev sign-in,
//                       OpenTelemetry into this dashboard
//   seed                backend/scripts/dev-seed.js once the server is healthy (idempotent)
//   worker              `la worker` against this server (LISTEN_WORKER=1)
//   idp                 the repo's fake OpenID provider, real sign-in (LISTEN_AUTH=oidc)
//
// Options are environment variables of `aspire run` (or `make up`):
//   LISTEN_PORT=3100    the server's port (fixed, so the URL and cookies stay put)
//   LISTEN_WORKER=1     add the downloader (needs yt-dlp + ffmpeg on PATH; downloads from YouTube)
//   LISTEN_AUTH=oidc    sign in through the fake IdP instead of INSECURE_DEV_LOGIN
//   LISTEN_PGWEB=0      no pgweb container
//
// Lessons carried over from mercatus (lessons/05): the URL is a postgres:// URL
// built here, because ConnectionStrings__x is ADO format; the Postgres password
// is pinned (URL-safe); executables are not proxied; the health check expects
// the status the endpoint really answers (/health is 200); the dashboard ports
// are fixed in aspire.config.json's `http` profile, so the OTLP endpoint is
// plain http and needs no dev certificate.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder, refExpr, EndpointProperty, OtlpProtocol } from './.aspire/modules/aspire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const devData = path.join(repo, '.dev-data');

const env = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();
const port = Number(env('LISTEN_PORT', '3100'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`LISTEN_PORT must be a port number (got "${env('LISTEN_PORT')}")`);
const withWorker = env('LISTEN_WORKER') === '1';
const withOidc = env('LISTEN_AUTH') === 'oidc';
const withPgweb = env('LISTEN_PGWEB', '1') !== '0';

// ---------------------------------------------------------------------------
// Dev literals. Not credentials anywhere: this topology exists only on a laptop.
// ---------------------------------------------------------------------------
const BASE_URL = `http://localhost:${port}`;
const SESSION_SECRET = 'listen-along-dev-session-secret-local-only';
const ADMIN_PASSWORD = 'dev-admin';
// CLI tokens the seed inserts (only their SHA-256 is stored, as tokens.js does):
// the worker's, owned by Dev User, and the second account's, used by the seed.
const DEV_WORKER_TOKEN = 'la_dev-worker-token-local-only-not-a-secret-000';
const DEV_LISTENER_TOKEN = 'la_dev-listener-token-local-only-not-a-secret-00';
const IDP_PORT = Number(env('LISTEN_IDP_PORT', '9400'));
const IDP_ISSUER = `http://127.0.0.1:${IDP_PORT}/application/o/listen-along/`;

const builder = await createBuilder();

// ---------------------------------------------------------------------------
// Postgres, the major version production runs (docker-compose.yml). The data
// volume outlives `aspire stop` (the container does not). Its name carries a
// hash of this checkout's path, so another clone or worktree gets its own
// database; scripts/aspire-dev.sh computes the same name for `make reset`.
// ---------------------------------------------------------------------------
const pgUser = await builder.addParameter('pg-user', { value: 'listen' });
// URL-safe on purpose: it goes into a postgres:// URL unescaped.
const pgPassword = await builder.addParameter('pg-password', { value: 'listen-dev-password', secret: true });
const volume = `listen-along-dev-pgdata-${createHash('sha256').update(repo).digest('hex').slice(0, 10)}`;

let postgres = builder
  .addPostgres('postgres', { userName: pgUser, password: pgPassword })
  .withImageTag('16-alpine')
  .withDataVolume({ name: volume });
if (withPgweb) postgres = postgres.withPgWeb();
const pg = await postgres;
const db = await pg.addDatabase('listen', { databaseName: 'listen' });

const pgHostPort = await pg.getEndpoint('tcp').property(EndpointProperty.HostAndPort);
const DATABASE_URL = refExpr`postgres://listen:${pgPassword}@${pgHostPort}/listen`;

// ---------------------------------------------------------------------------
// The frontend compiler, its own log stream. The server serves frontend/dist
// (and frontend/) from disk, so a rebuild is live on the next page load.
// ---------------------------------------------------------------------------
await builder.addExecutable('frontend', 'node', repo, [
  'node_modules/typescript/bin/tsc', '-b', 'frontend', '-w', '--preserveWatchOutput',
]);

// ---------------------------------------------------------------------------
// The server. `node --watch` restarts it on any backend edit; the telemetry
// preload goes first so http / express / pg are patched before index.js loads
// them (and stays off when the OTLP variables are absent, as in production).
// ---------------------------------------------------------------------------
let backend = builder
  .addExecutable('listen-along', 'node', path.join(repo, 'backend'), [
    '--watch', '--require', './src/telemetry.js', 'src/index.js',
  ])
  // Not proxied: the process binds the port itself, so BASE_URL is the real one.
  .withHttpEndpoint({ port, env: 'PORT', isProxied: false })
  .withEnvironment('NODE_ENV', 'development')
  .withEnvironment('BASE_URL', BASE_URL)
  .withEnvironment('FRONTEND_URL', BASE_URL)
  .withEnvironment('FRONTEND_PATH', path.join(repo, 'frontend'))
  .withEnvironment('DATABASE_URL', DATABASE_URL)
  .withEnvironment('SESSION_SECRET', SESSION_SECRET)
  .withEnvironment('ADMIN_PASSWORD', ADMIN_PASSWORD)
  .withEnvironment('SONGS_PATH', path.join(devData, 'songs'))
  .withEnvironment('COVERS_DIR', path.join(devData, 'covers'))
  // OTLP/HTTP (protobuf) to the dashboard: telemetry.js does not ship a gRPC exporter.
  .withOtlpExporter({ protocol: OtlpProtocol.HttpProtobuf })
  // /health answers 200 (cheap: no database round trip).
  .withHttpHealthCheck({ path: '/health', statusCode: 200 })
  .waitFor(db);

if (withOidc) {
  // The repo's fake OpenID provider (backend/src/fakeOidcIssuer.js): every
  // sign-in is "Dev User" (sub dev-1), whom the seed links to its Dev User.
  const idp = await builder
    .addExecutable('idp', 'node', path.join(repo, 'backend'), ['src/fakeOidcIssuer.js', '--port', String(IDP_PORT)])
    .withHttpEndpoint({ port: IDP_PORT, isProxied: false })
    .withHttpHealthCheck({ path: '/application/o/listen-along/.well-known/openid-configuration', statusCode: 200 });
  backend = backend
    .withEnvironment('OIDC_ISSUER', IDP_ISSUER)
    .withEnvironment('OIDC_CLIENT_ID', 'listen-along')
    .waitFor(idp);
} else {
  // The dev sign-in: /auth/dev/login. Refused by the server in production and
  // next to OIDC_*, so it is only ever set on this branch.
  backend = backend.withEnvironment('INSECURE_DEV_LOGIN', '1');
}
const server = await backend;
const serverUrl = await server.getEndpoint('http');

// ---------------------------------------------------------------------------
// The seed: runs once the server is healthy (it creates the schema at boot)
// and exits. Idempotent, so every `make up` runs it again harmlessly.
// ---------------------------------------------------------------------------
const seed = await builder
  .addExecutable('seed', 'node', path.join(repo, 'backend'), ['scripts/dev-seed.js'])
  .withEnvironment('DATABASE_URL', DATABASE_URL)
  .withEnvironment('LISTEN_URL', serverUrl)
  .withEnvironment('DEV_DATA_DIR', devData)
  .withEnvironment('DEV_WORKER_TOKEN', DEV_WORKER_TOKEN)
  .withEnvironment('DEV_LISTENER_TOKEN', DEV_LISTENER_TOKEN)
  .waitFor(server);

// ---------------------------------------------------------------------------
// Optional downloader: `la worker` with the seeded token. Its config file and
// tools stay under .dev-data, never in ~/.config.
// ---------------------------------------------------------------------------
if (withWorker) {
  await builder
    .addExecutable('worker', 'node', repo, ['cli/bin/la.js', 'worker', '--name', 'dev-worker', '--no-auto-update'])
    .withEnvironment('LA_SERVER', serverUrl)
    .withEnvironment('LA_TOKEN', DEV_WORKER_TOKEN)
    .withEnvironment('LA_AUTO_UPDATE', 'false')
    .withEnvironment('LA_CONFIG', path.join(devData, 'la', 'config.json'))
    .waitForCompletion(seed);
}

await builder.build().run();
