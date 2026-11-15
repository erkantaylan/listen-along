#!/bin/sh
# `npm run dev` at the repo root: the frontend compiler in watch mode next to
# the backend in watch mode (backend `npm run dev`). Ctrl+C stops both.
set -e
cd "$(dirname "$0")/.."
npx tsc -b frontend -w --force --preserveWatchOutput &
TSC=$!
trap 'kill "$TSC" 2>/dev/null' EXIT INT TERM
npm --prefix backend run dev
