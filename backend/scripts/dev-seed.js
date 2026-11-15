#!/usr/bin/env node
/**
 * Local development seed, run by the Aspire AppHost (aspire/apphost.mts) once
 * the server is healthy. Never part of the image and never run against
 * production: it inserts known dev tokens. Idempotent: every run converges on
 * the same data, so it runs on every `make up`.
 *
 * What it makes:
 *   - accounts "Dev User" (the one /auth/dev/login without ?user signs in;
 *     linked to the fake IdP's sub `dev-1` so LISTEN_AUTH=oidc finds it too)
 *     and "Dev Listener", both approved
 *   - a CLI token for each, with known values (DEV_WORKER_TOKEN, used by the
 *     optional `la worker`; DEV_LISTENER_TOKEN); only their SHA-256 is stored,
 *     exactly as tokens.js does
 *   - five library songs: real AAC (.m4a) and Opus (.opus) files of a few
 *     seconds of tone, made with ffmpeg into $DEV_DATA_DIR/seed-audio and
 *     uploaded through the real API (ffprobe validation, duplicate checks)
 *   - playlists: "Dev Mix" (public) and "Late Night" (private) for Dev User,
 *     "Road Trip" (public) for Dev Listener, with songs
 *   - a few chat messages
 *
 * Users, tokens and chat go straight into Postgres; songs and playlists go
 * through the HTTP API so the server's in-memory state and its rules apply.
 *
 * Environment: DATABASE_URL, LISTEN_URL (the server), DEV_DATA_DIR,
 * DEV_WORKER_TOKEN, DEV_LISTENER_TOKEN; FFMPEG (default `ffmpeg`).
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const need = (name) => {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`dev-seed: ${name} is not set`); process.exit(2); }
  return v;
};

const DATABASE_URL = need('DATABASE_URL');
const LISTEN_URL = need('LISTEN_URL').replace(/\/+$/, '');
const DEV_DATA_DIR = need('DEV_DATA_DIR');
const WORKER_TOKEN = need('DEV_WORKER_TOKEN');
const LISTENER_TOKEN = need('DEV_LISTENER_TOKEN');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const USERS = [
  { key: 'dev', providerId: 'dev', name: 'Dev User', oidcSub: 'dev-1', token: WORKER_TOKEN, tokenLabel: 'dev worker (seed)' },
  { key: 'listener', providerId: 'dev-listener', name: 'Dev Listener', oidcSub: null, token: LISTENER_TOKEN, tokenLabel: 'dev listener (seed)' },
];

// Distinct tones, so every file has its own bytes (the library refuses the same sha256 twice).
const SONGS = [
  { file: 'a440.m4a', freq: 440, seconds: 6, title: 'Concert Pitch', artist: 'The Test Tones', album: 'Seed Sessions' },
  { file: 'c523.m4a', freq: 523, seconds: 5, title: 'High C', artist: 'The Test Tones', album: 'Seed Sessions' },
  { file: 'e330.opus', freq: 330, seconds: 7, title: 'Low E Drone', artist: 'Sine Wave Collective' },
  { file: 'g392.opus', freq: 392, seconds: 4, title: 'Sol', artist: 'Sine Wave Collective, Dev Listener' },
  { file: 'b247.m4a', freq: 247, seconds: 8, title: 'Bass Hum', artist: 'Oscillator & Friends' },
];

const PLAYLISTS = [
  { owner: 'dev', name: 'Dev Mix', visibility: 'public', songs: [0, 1, 2, 3] },
  { owner: 'dev', name: 'Late Night', visibility: 'private', songs: [4, 2] },
  { owner: 'listener', name: 'Road Trip', visibility: 'public', songs: [3, 0, 4] },
];

const CHAT = [
  { user: 'dev', body: 'Welcome to the local listen-along. Everything here comes from backend/scripts/dev-seed.js.' },
  { user: 'listener', body: 'Hi! Road Trip is my playlist; Dev Mix is public too.' },
  { user: 'dev', body: 'Late Night is private: only Dev User sees it.' },
];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function seedUsers(pg) {
  const ids = {};
  const now = Date.now();
  for (const u of USERS) {
    // Same row /auth/dev/login creates for "Dev User" (provider dev, provider_id dev).
    await pg.query(
      `INSERT INTO users (provider, provider_id, name, display_name, status, created_at, updated_at)
       VALUES ('dev', $1, $2, $2, 'approved', $3, $3) ON CONFLICT DO NOTHING`,
      [u.providerId, u.name, now]
    );
    const r = await pg.query(`SELECT id, status FROM users WHERE provider = 'dev' AND provider_id = $1`, [u.providerId]);
    ids[u.key] = r.rows[0].id;
    if (r.rows[0].status !== 'approved') console.log(`dev-seed: ${u.name} is ${r.rows[0].status} (left as an admin set it)`);
    if (u.oidcSub) {
      // So the fake IdP's sign-in (LISTEN_AUTH=oidc, sub dev-1) lands on this account.
      await pg.query(
        `UPDATE users SET oidc_sub = $2 WHERE id = $1 AND oidc_sub IS NULL
           AND NOT EXISTS (SELECT 1 FROM users WHERE oidc_sub = $2)`,
        [ids[u.key], u.oidcSub]
      );
    }
    await pg.query(
      `INSERT INTO api_tokens (name, token_hash, token_prefix, user_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL, user_id = EXCLUDED.user_id`,
      [u.tokenLabel, sha256(u.token), u.token.slice(0, 10), ids[u.key]]
    );
  }
  return ids;
}

function ensureAudio(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return SONGS.map((s) => {
    const file = path.join(dir, s.file);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      const codec = s.file.endsWith('.opus') ? ['-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg'] : ['-c:a', 'aac', '-b:a', '96k', '-f', 'mp4'];
      const tmp = `${file}.tmp`;
      execFileSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `sine=frequency=${s.freq}:duration=${s.seconds}:sample_rate=48000`,
        '-ac', '2', ...codec, '-map_metadata', '-1', '-fflags', '+bitexact', tmp,
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      fs.renameSync(tmp, file);
    }
    return file;
  });
}

async function api(method, url, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(LISTEN_URL + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}

async function seedSongs(files) {
  const ids = [];
  for (const [i, s] of SONGS.entries()) {
    const form = new FormData();
    form.set('title', s.title);
    form.set('artist', s.artist);
    if (s.album) form.set('album', s.album);
    form.set('duration_sec', String(s.seconds));
    const type = s.file.endsWith('.opus') ? 'audio/ogg' : 'audio/mp4';
    form.set('file', new Blob([fs.readFileSync(files[i])], { type }), s.file);
    const r = await api('POST', '/api/library/upload', WORKER_TOKEN, form);
    if (r.status === 201) { ids.push(r.body.song.id); continue; }
    if (r.status === 409 && r.body && r.body.song) { ids.push(r.body.song.id); continue; }
    throw new Error(`upload of ${s.file} failed: ${r.status} ${r.text.slice(0, 300)}`);
  }
  return ids;
}

async function seedPlaylists(userIds, songIds) {
  const tokenOf = { dev: WORKER_TOKEN, listener: LISTENER_TOKEN };
  const out = [];
  for (const p of PLAYLISTS) {
    const token = tokenOf[p.owner];
    const list = await api('GET', '/api/playlists', token);
    if (list.status !== 200) throw new Error(`listing playlists failed: ${list.status} ${list.text.slice(0, 200)}`);
    let pl = list.body.playlists.find((x) => x.name === p.name && x.ownerId === userIds[p.owner]);
    if (!pl) {
      const made = await api('POST', '/api/playlists', token, { name: p.name, visibility: p.visibility });
      if (made.status !== 201) throw new Error(`creating "${p.name}" failed: ${made.status} ${made.text.slice(0, 200)}`);
      pl = made.body;
    }
    // A song already there is skipped (the API's default), so a re-run adds nothing.
    const add = await api('POST', `/api/playlists/${pl.id}/songs`, token, { songs: p.songs.map((i) => songIds[i]) });
    if (add.status !== 200) throw new Error(`adding songs to "${p.name}" failed: ${add.status} ${add.text.slice(0, 200)}`);
    out.push(`${p.name} (${p.visibility}, ${add.body.song_count} songs, /playlist/${pl.id})`);
  }
  return out;
}

async function seedChat(pg, userIds) {
  const seeded = await pg.query(
    `SELECT count(*)::int AS n FROM global_chat_messages WHERE user_id = ANY($1::uuid[])`,
    [Object.values(userIds)]
  );
  if (seeded.rows[0].n > 0) return 0;
  const base = Date.now() - CHAT.length * 60_000;
  for (const [i, m] of CHAT.entries()) {
    const u = USERS.find((x) => x.key === m.user);
    await pg.query(
      `INSERT INTO global_chat_messages (user_id, author_name, body, created_at) VALUES ($1, $2, $3, $4)`,
      [userIds[m.user], u.name, m.body, base + i * 60_000]
    );
  }
  return CHAT.length;
}

async function main() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    const userIds = await seedUsers(pg);
    const files = ensureAudio(path.join(DEV_DATA_DIR, 'seed-audio'));
    const songIds = await seedSongs(files);
    const playlists = await seedPlaylists(userIds, songIds);
    const chat = await seedChat(pg, userIds);
    console.log(`dev-seed: users Dev User (${userIds.dev}) and Dev Listener (${userIds.listener}), both approved`);
    console.log(`dev-seed: ${songIds.length} library songs; playlists: ${playlists.join('; ')}`);
    console.log(`dev-seed: chat ${chat ? `${chat} messages added` : 'already seeded'}; CLI tokens for both accounts in place`);
    console.log(`dev-seed: sign in at ${LISTEN_URL}/auth/dev/login (Dev User) or ${LISTEN_URL}/auth/dev/login?user=${userIds.listener} (Dev Listener)`);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(`dev-seed: ${err.message}`);
  process.exit(1);
});
