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

EXPOSE 3000

CMD ["node", "src/index.js"]
