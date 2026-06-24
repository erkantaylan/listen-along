FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg

# Bump this value to force a fresh yt-dlp install on the next build. YouTube
# breaks yt-dlp often and fixes land within days, so a stale binary is a common
# cause of "can't download anything" — rebuild after bumping to pull the latest.
ARG YTDLP_CACHE_BUST=2026-06-24
RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./
COPY frontend/ ./frontend/
COPY CHANGELOG.md ./CHANGELOG.md

EXPOSE 3000

CMD ["node", "src/index.js"]
