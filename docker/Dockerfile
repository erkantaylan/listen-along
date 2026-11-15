# Resolve the deployed commit in a throwaway stage so neither .git nor git
# ships in the final image. GIT_COMMIT (compose build arg) wins; otherwise read
# from the build context's .git; otherwise "unknown".
FROM alpine:3.20 AS buildinfo
RUN apk add --no-cache git
ARG GIT_COMMIT=
WORKDIR /src
COPY . .
RUN c="$GIT_COMMIT"; d=""; \
    if [ -z "$c" ] && [ -d .git ]; then \
      git config --global --add safe.directory /src; \
      c=$(git rev-parse HEAD 2>/dev/null || true); \
      d=$(git log -1 --format=%cI 2>/dev/null || true); \
    fi; \
    printf '{"commit":"%s","commitDate":"%s","builtAt":"%s"}\n' \
      "${c:-unknown}" "$d" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /build-info.json; \
    cat /build-info.json

# Compile the frontend's TypeScript (frontend/src -> frontend/dist) with the
# root package's dev dependencies. Only frontend/dist leaves this stage: the
# final image has no TypeScript and no root node_modules.
FROM node:22-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY frontend/package.json frontend/tsconfig.json ./frontend/
COPY frontend/src/ ./frontend/src/
RUN npm run build && test -d frontend/dist

FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg

# yt-dlp is only used for YouTube *metadata* (search + playlist listing with
# --flat-playlist); the server never downloads audio. ffmpeg/ffprobe validate
# uploaded m4a files. Bump to force a fresh yt-dlp on the next build.
ARG YTDLP_CACHE_BUST=2026-10-30
RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./
COPY frontend/ ./frontend/
# Served at the site root before frontend/ itself (src/frontendStatic.js).
COPY --from=frontend /src/frontend/dist/ ./frontend/dist/
COPY CHANGELOG.md ./CHANGELOG.md
# The la CLI (no npm dependencies), offered to `la worker` / `la update` for
# self-update (src/cliRelease.js bundles it at boot). Not its tests.
COPY cli/package.json cli/README.md ./cli/
COPY cli/bin/ ./cli/bin/
COPY cli/src/ ./cli/src/
COPY --from=buildinfo /build-info.json ./build-info.json

# libuv's threadpool (fs reads/writes, dns.lookup, crypto) defaults to 4
# threads: a few slow file reads or lookups (audio streams, uploads, hashing,
# a reconnecting pg pool) then queue every fs.stat behind them, which is what
# static pages like /login wait on. /health reports the wait as diag.fsProbeMs.
ENV UV_THREADPOOL_SIZE=16

EXPOSE 3000

CMD ["node", "src/index.js"]
