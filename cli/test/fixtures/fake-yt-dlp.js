#!/usr/bin/env node
'use strict';

// A stand-in for yt-dlp for local end-to-end runs of `la worker` / `la
// download` without touching YouTube:  LA_YTDLP_BIN=cli/test/fixtures/fake-yt-dlp.js
// It answers --version, flat searches / playlist listings (-J) and downloads
// (writes a real 2-second AAC m4a with the real ffmpeg, tagged like yt-dlp's
// --embed-metadata would, and prints the after_move JSON). Video ids are
// derived from the query, so the same search always "finds" the same video.
// Ids starting with "agerestr" fail like an age-restricted video does.
// Searches remember "Artist - Title" per id (FAKE_YTDLP_STATE file, default
// in the temp dir) so the download is tagged with them.
// Env: FAKE_YTDLP_DELAY_MS (slow downloads down), LA_FFMPEG_BIN.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2026.10.26\n'); process.exit(0); }

const sep = argv.indexOf('--');
// The CLI puts targets after `--`; the server's metadata calls end with it.
const target = (sep >= 0 ? argv[sep + 1] : argv[argv.length - 1]) || '';
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const idFor = (s) => crypto.createHash('sha1').update(s).digest('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 11);
function split(q) {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(q);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: 'Fake Artist', title: q.trim() };
}

const stateFile = process.env.FAKE_YTDLP_STATE || path.join(os.tmpdir(), 'fake-yt-dlp-state.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
function remember(entries) {
  const st = readState();
  for (const e of entries) st[e.id] = e.title;
  try { fs.writeFileSync(stateFile, JSON.stringify(st)); } catch { /* best effort */ }
}

if (argv.includes('-J')) {
  let entries;
  const search = /^ytsearch\d*:(.*)$/.exec(target);
  if (search) {
    const q = search[1];
    entries = [{ id: idFor(q), title: q, channel: `${split(q).artist} - Topic`, duration: 2 }];
  } else {
    const list = new URL(target).searchParams.get('list') || 'x';
    entries = [1, 2].map((n) => ({ id: idFor(`${list}#${n}`), title: `Fake Artist - Playlist song ${n}`, channel: 'Fake Artist', duration: 2 }));
  }
  remember(entries);
  process.stdout.write(JSON.stringify({ entries }));
  process.exit(0);
}

// Download.
const id = (() => { try { return new URL(target).searchParams.get('v'); } catch { return null; } })() || idFor(target);
if (id.startsWith('agerestr')) {
  process.stderr.write(`ERROR: [youtube] ${id}: Sign in to confirm your age. This video may be inappropriate for some users.\n`);
  process.exit(1);
}
const delay = Number(process.env.FAKE_YTDLP_DELAY_MS || 0);
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
const outDir = opt('-P') || '.';
const file = path.join(outDir, `${id}.m4a`);
const known = readState()[id];
const names = known ? split(known) : { title: `Fake song ${id}`, artist: 'Fake Artist' };
const freq = 200 + (parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 4), 16) % 800);
const url = `https://www.youtube.com/watch?v=${id}`;
const r = spawnSync(process.env.LA_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
  '-c:a', 'aac', '-metadata', `title=${names.title}`, '-metadata', `artist=${names.artist}`, '-metadata', `comment=${url}`,
  '-f', 'mp4', file], { stdio: ['ignore', 'ignore', 'pipe'] });
if (r.status !== 0) { process.stderr.write(`ERROR: fake download failed: ${r.stderr}\n`); process.exit(1); }
process.stdout.write(`${JSON.stringify({ id, title: names.title, track: names.title, artist: names.artist, uploader: names.artist, duration: 2, filepath: file, webpage_url: url })}\n`);
