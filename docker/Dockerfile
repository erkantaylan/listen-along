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
COPY CHANGELOG.md ./CHANGELOG.md
COPY --from=buildinfo /build-info.json ./build-info.json

EXPOSE 3000

CMD ["node", "src/index.js"]
