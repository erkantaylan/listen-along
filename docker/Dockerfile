FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg

# Bump this value to force a fresh yt-dlp install on the next build. YouTube
# breaks yt-dlp often and fixes land within days, so a stale binary is a common
# cause of "can't download anything" — rebuild after bumping to pull the latest.
ARG YTDLP_CACHE_BUST=2026-06-24
# yt-dlp plus:
#  - bgutil-ytdlp-pot-provider: PO Token plugin (client side; talks to the
#    bgutil-provider sidecar) to get past YouTube's "not a bot" IP block.
#  - yt-dlp-ejs: the EJS challenge-solver scripts yt-dlp needs to solve YouTube's
#    signature / n-sig challenges. It runs them on a JS runtime — we use the
#    Node already in this image (see YTDLP_JS_RUNTIME=node), as Deno (the yt-dlp
#    default) has no clean musl/alpine build.
RUN pip3 install --break-system-packages --upgrade \
      yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./
COPY frontend/ ./frontend/
COPY CHANGELOG.md ./CHANGELOG.md

EXPOSE 3000

CMD ["node", "src/index.js"]
