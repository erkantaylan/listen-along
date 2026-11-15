# listen-along

A web app where users create shared playlists (public, or private to their owner), share links with friends, and listen together.

## Quick Start

### Using Docker (recommended)

```bash
make build
make run
```

Open http://localhost:3000

### Local Development

```bash
make up      # everything, with a database, sample data and a dashboard (below)
make down
```

`make dev` still runs just the server and the frontend compiler, with no
database unless `backend/.env` sets `DATABASE_URL`.

## Local development

One command starts a complete local setup, orchestrated by an
[Aspire](https://aspire.dev) AppHost written in TypeScript (`aspire/apphost.mts`).
It is for development only: the Docker image and both compose files do not
use it.

### Prerequisites

- Node.js 22.18+ and npm
- Docker (or Podman with `ASPIRE_CONTAINER_RUNTIME=podman`)
- The Aspire CLI 13.6.4 or newer: `curl -sSL https://aspire.dev/install.sh | bash`
  ([install guide](https://aspire.dev/get-started/install-cli/)). **No .NET SDK
  is needed**: the CLI brings its own orchestration server, and the repo has no
  C# code. The AppHost's TypeScript SDK (`aspire/.aspire/modules/`) is generated
  by the CLI on the first run and is not committed.
- `ffmpeg` / `ffprobe` on `PATH` (uploads are checked with ffprobe; the seed
  makes its audio with ffmpeg). `yt-dlp` too for YouTube search and the worker.

### Start and stop

```bash
make up       # or: npm run aspire:up
make down     # or: npm run aspire:down
make reset    # down, then delete the dev database and .dev-data/
```

`make up` installs what is missing (`npm ci` in the root, `backend/` and
`aspire/`), runs `aspire run --detach` in `aspire/`, waits until the server is
healthy and the seed has finished, and prints two addresses:

- the app: <http://localhost:3100>
- the Aspire dashboard: <http://localhost:15260> (the printed link carries a
  one-time login token): resources, their logs, traces and metrics

`make down` runs `aspire stop`, then waits for the containers to go and stops
any process of this checkout's AppHost that is still running, so nothing is
left on the ports. The database volume is kept; the next `make up` reuses it
and the seed does not duplicate anything.

### What runs

| Resource | What |
|---|---|
| `postgres` / `listen` | PostgreSQL 16 (as in production) with a data volume, database `listen`, dev user `listen` / `listen-dev-password` |
| `pgweb` | a database browser (its address is in the dashboard); `LISTEN_PGWEB=0` leaves it out |
| `frontend` | `tsc -b frontend -w`: saving a `frontend/src/*.ts` file rebuilds `frontend/dist` |
| `listen-along` | the server, `node --watch`: saving a backend file restarts it. Dev sign-in, `ADMIN_PASSWORD=dev-admin`, telemetry to the dashboard |
| `seed` | `backend/scripts/dev-seed.js`, once the server is healthy; safe to run again |
| `worker` | `la worker` against the local server (only with `LISTEN_WORKER=1`) |
| `idp` | the repo's fake OpenID provider (only with `LISTEN_AUTH=oidc`) |

Every secret in `aspire/apphost.mts` is a dev value that exists only on your
machine; nothing comes from production.

### Dev accounts and signing in

The seed makes two approved accounts, six short songs (real AAC and Opus
files of a tone; "Dead Air (video upload)" has seconds of silence before and
after, for the player's Skip silence), three playlists and a few chat messages:

- **Dev User**: open <http://localhost:3100/auth/dev/login> (or press **Sign
  in**). Owns "Dev Mix" (public) and "Late Night" (private).
- **Dev Listener**: `/auth/dev/login?user=<id>`; the seed prints the id in its
  log (`cd aspire && aspire logs seed`). Owns "Road Trip" (public).
- `/dashboard` with the password `dev-admin`.
- CLI tokens with known values (in `aspire/apphost.mts`): `la_dev-worker-token-…`
  for Dev User, used by the worker.

### Options

Environment variables of `make up`:

- `LISTEN_PORT=3100`: the server's port.
- `LISTEN_WORKER=1`: also run a downloader (`la worker`, auto-update off, its
  config under `.dev-data/la/`), so the Download box and song requests work
  locally. It needs `yt-dlp` and `ffmpeg`, and downloads from YouTube.
- `LISTEN_AUTH=oidc`: real sign-in instead of the dev sign-in. The AppHost runs
  `node backend/src/fakeOidcIssuer.js --port 9400` and points `OIDC_ISSUER` /
  `OIDC_CLIENT_ID` at it; **Sign in** goes through the whole OpenID Connect
  round trip and lands on Dev User (the seed links it to the IdP's `sub`).
- `LISTEN_PGWEB=0`: no pgweb.

### Where data lives

- The database: the Docker volume `listen-along-dev-pgdata-<hash>` (one per
  checkout: the hash is of the checkout's path).
- Songs, covers and the seed's audio: `.dev-data/` at the repo root
  (gitignored, not in the Docker build context).
- `make reset` deletes both. The next `make up` starts empty and seeds again.

### Troubleshooting

- Logs of one resource: `cd aspire && aspire logs listen-along` (or `seed`,
  `frontend`, `worker`), or the dashboard. `sh scripts/aspire-dev.sh status`
  lists the resources.
- A port in use: `LISTEN_PORT=3200 make up`. The dashboard's ports (15260,
  19260, 19261, 20260) are in `aspire/aspire.config.json`.

## OpenTelemetry

The server can send traces and metrics over OTLP. **It is off by default**:
unless an OTLP endpoint is configured, `backend/src/telemetry.js` returns after
reading the environment (no OpenTelemetry module is loaded, nothing is patched,
no timer, no network, no log line). Production sets no such variable, so it
behaves as before until you opt in.

It is a preload, so it patches `http`, Express and `pg` before the server loads
them; `src/index.js` does not know about it:

```bash
# locally (make up does this, and `npm run dev` in backend/ too)
node --require ./src/telemetry.js src/index.js

# in the Docker image: no change to the image or its CMD, only environment
NODE_OPTIONS=--require=/app/src/telemetry.js
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example:4318
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…   # if the collector wants one
```

Settings (all standard OpenTelemetry variables): `OTEL_EXPORTER_OTLP_ENDPOINT`
(or the `_TRACES_` / `_METRICS_` ones), `OTEL_EXPORTER_OTLP_PROTOCOL`
(`http/protobuf`, the default, or `http/json`; gRPC is refused with a warning,
to keep the gRPC library out of the image), `OTEL_SERVICE_NAME` (default
`listen-along`), `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER` +
`OTEL_TRACES_SAMPLER_ARG` (for example `parentbased_traceidratio` and `0.1`),
`OTEL_BSP_SCHEDULE_DELAY`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_SDK_DISABLED=true`.

What is recorded:

- a span per HTTP request, named by its route template (`GET
  /api/playlists/:id`), with method, status, path and duration; outgoing HTTP
  and `fetch` calls made while serving a request; each Postgres query with its
  SQL text (parameters as `$1`), as a child of the request
- metrics: HTTP server and client durations, the `pg` pool, the Node runtime
  (event loop delay and utilisation, GC, heap)
- log lines written while a request is being served end with its `trace_id=… span_id=…`

What is never recorded: request or response bodies, any header (so no
cookies, `Authorization`, session ids), query strings (the OIDC callback's
`?code=` included), client IP addresses, SQL parameter values or quoted
literals, emails, chat text. `/health`, static files and Socket.IO's polling
requests are not traced at all. Socket.IO events are not traced (there is no
stable instrumentation, and presence traffic would drown the rest), and queries
made outside an HTTP request (socket handlers, timers, boot) are not either.
The rules are in `backend/src/telemetryRules.js` and tested in
`telemetry.test.js`.

When the backend moves to ES modules, `--require` stops patching: the preload
becomes `node --import ./src/telemetry.ts`, registering
`@opentelemetry/instrumentation/hook.mjs` with `module.register()` first, and
`NODE_OPTIONS=--import=…` in the image.

## Project Structure

```
├── aspire/           # Local development: the Aspire AppHost (TypeScript)
├── backend/          # Node.js + Express + Socket.IO server
│   ├── scripts/      # dev-seed.js (local development only)
│   └── src/
├── frontend/         # Web client: TypeScript in src/, compiled to dist/ (mobile-first)
├── docker/           # Docker configuration
├── docker-compose.yml
└── Makefile
```

## Requirements

- Docker and Docker Compose, OR
- Node.js 22.18+ (for local development), plus the Aspire CLI for `make up`

## Make Targets

| Command      | Description                    |
|--------------|--------------------------------|
| `make build` | Build Docker image             |
| `make run`   | Run with Docker Compose        |
| `make up`    | Local development with Aspire: database, server, frontend watch, seed, dashboard |
| `make down`  | Stop it (the database is kept) |
| `make reset` | Stop it and delete the dev database and `.dev-data/` |
| `make dev`   | Run the server and the frontend compiler only |
| `make test`  | Run tests                      |
| `make clean` | Remove containers and node_modules |
