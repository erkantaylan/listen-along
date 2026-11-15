#!/bin/sh
# `npm run dev` / `make dev` at the repo root: build the frontend once (so the
# first page load has frontend/dist), then the frontend compiler in watch mode
# next to the backend in watch mode (backend `npm run dev`). Ctrl+C stops both.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
if [ ! -x node_modules/.bin/tsc ]; then
  echo "dev: run 'npm ci' at the repo root first (TypeScript)" >&2
  exit 1
fi
# The server's default FRONTEND_PATH is the Docker layout (/app/frontend);
# from a checkout serve this repo's frontend/ unless backend/.env says otherwise.
if [ -z "${FRONTEND_PATH:-}" ] && ! grep -qs '^FRONTEND_PATH=' backend/.env; then
  export FRONTEND_PATH="$ROOT/frontend"
fi
npx tsc -b frontend --force
npx tsc -b frontend -w --preserveWatchOutput &
TSC=$!
trap 'kill "$TSC" 2>/dev/null' EXIT INT TERM
npm --prefix backend run dev
