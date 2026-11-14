/**
 * Is a library song really broken? The server's own answer, never a client's.
 *
 * The web player files a "needs replacement" report by itself when a song
 * fails to play (`auto: true`, songReports.js). Such a report takes the song
 * out of Radio and the artist pages for everyone, and a browser cannot be the
 * authority on it: its cache, its audio device and its codecs all fail in ways
 * that look like a broken file. So before an automatic report is stored,
 * verifyBroken() establishes one of two things from the server's side, and
 * refuses otherwise:
 *
 *   'missing'      the song's file is not there (ENOENT) AND the storage is
 *                  demonstrably healthy: the files of other songs are. See
 *                  storageHealth().
 *   'undecodable'  the file is there and ffmpeg cannot decode it from start to
 *                  end, for reasons ffmpeg puts on the file, twice
 *                  (checkFile()). A file ffmpeg decodes is not broken, whatever
 *                  a browser said.
 *
 * The file routes use storageHealth() too, to answer a missing file with 404
 * FILE_MISSING only while the rest of the storage is there (else the same 404
 * says STORAGE_UNAVAILABLE).
 */

const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');

// --- Storage health ---------------------------------------------------------
// A bad mount after a redeploy leaves an empty folder; one upload later it is
// no longer empty, and a restore may be partial. So "is the storage there" is
// asked of the files that should be in it: a sample of OTHER songs, taken
// from the oldest ones and from the ones uploaded around the song in question
// (never just the newest: those may be the only files a fresh mount has).
// Each row's own file_path is checked, wherever it points (library folder or
// a legacy cache location).
const SAMPLE_OLDEST = 10;
const SAMPLE_NEAR = 5;         // each side of the song's own upload time
const MIN_SAMPLE = 5;          // fewer than this proves nothing (a tiny library)
const HEALTHY_RATIO = 0.9;     // at least this share of the sample must exist

async function exists(filePath) {
  try { await fs.promises.access(filePath, fs.constants.R_OK); return true; } catch { return false; }
}

/**
 * @returns {Promise<{ sampled: number, present: number, healthy: boolean, unhealthy: boolean }>}
 *   healthy:   enough other songs were sampled and (nearly) all their files exist
 *   unhealthy: some were sampled and too many are missing
 *   neither:   too few other songs to tell
 */
async function storageHealth(songId) {
  const r = await db.query(
    `WITH me AS (SELECT created_at FROM library_songs WHERE id = $1)
     SELECT id, file_path FROM (
       (SELECT id, file_path FROM library_songs WHERE id <> $1 ORDER BY created_at ASC, id LIMIT $2)
       UNION
       (SELECT id, file_path FROM library_songs WHERE id <> $1 AND created_at <= (SELECT created_at FROM me) ORDER BY created_at DESC, id LIMIT $3)
       UNION
       (SELECT id, file_path FROM library_songs WHERE id <> $1 AND created_at > (SELECT created_at FROM me) ORDER BY created_at ASC, id LIMIT $3)
     ) s`,
    [songId, SAMPLE_OLDEST, SAMPLE_NEAR]
  );
  const found = await Promise.all(r.rows.map((row) => exists(row.file_path)));
  const sampled = found.length;
  const present = found.filter(Boolean).length;
  const ratio = sampled ? present / sampled : 0;
  return {
    sampled,
    present,
    healthy: sampled >= MIN_SAMPLE && ratio >= HEALTHY_RATIO,
    unhealthy: sampled > 0 && ratio < HEALTHY_RATIO,
  };
}

// The file routes ask on every request for a missing file: remember the answer
// for a moment. verifyBroken never reads this (a report is always re-checked).
const HEALTH_TTL_MS = 3000;
const healthCache = new Map(); // song id -> { at, health }
async function storageHealthCached(songId) {
  const hit = healthCache.get(songId);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.health;
  const health = await storageHealth(songId);
  if (healthCache.size > 500) healthCache.clear();
  healthCache.set(songId, { at: Date.now(), health });
  return health;
}

// --- Decode check -----------------------------------------------------------
// The whole first audio stream decoded to nowhere; -xerror makes a decode error
// the exit code. One at a time, niced, with a time limit: it reads a whole
// file, and it runs because a client asked.
//
// A failed run is not yet a broken file. ffmpeg also exits non-zero when it
// runs out of memory or file handles, when the disk errs, when the file is not
// readable or has just been deleted (a replace). So "broken" needs all of:
// ffmpeg's own words blame the input (BAD_INPUT) and name nothing of the
// surroundings (ENVIRONMENT), on two runs, with the file still there and
// unchanged (size, mtime) after each. Anything else is "not established", and
// only a certain verdict is remembered.
const decodeTimeoutMs = () => Number(process.env.VERIFY_DECODE_TIMEOUT_MS) || 60000;
const ffmpegBin = () => process.env.VERIFY_FFMPEG || 'ffmpeg'; // tests put a stand-in here
const MAX_WAITING = 4;
const VERDICT_TTL_MS = 10 * 60 * 1000;
const STDERR_MAX = 8192;
const ENVIRONMENT = /cannot allocate memory|out of memory|input\/output error|no such file|permission denied|operation not permitted|too many open files|stale file handle|resource temporarily unavailable|no space left|device or resource busy|killed|command not found|cannot execute/i;
const BAD_INPUT = /invalid data found when processing input|moov atom not found|error submitting packet to decoder|error while decoding|decoding error|decode error|error opening input/i;
const verdicts = new Map(); // `${path}|${size}|${mtimeMs}` -> { at, ok }
let chain = Promise.resolve();
let waiting = 0;

// One ffmpeg run -> 'ok' (decoded to the end), 'bad' (ffmpeg blames the input),
// or 'doubt' (it did not run, was killed, or failed for some other reason).
function runDecode(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('nice', ['-n', '10', ffmpegBin(), '-nostdin', '-v', 'error', '-xerror', '-i', filePath, '-map', '0:a:0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      return resolve('doubt');
    }
    let stderr = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(watchdog); resolve(value); } };
    const watchdog = setTimeout(() => { proc.kill('SIGKILL'); finish('doubt'); }, decodeTimeoutMs());
    proc.stderr.on('data', (d) => { if (stderr.length < STDERR_MAX) stderr += d.toString().slice(0, STDERR_MAX - stderr.length); });
    proc.on('error', () => finish('doubt'));
    proc.on('close', (code, signal) => {
      if (code === 0 && !signal) return finish('ok');
      // 125-127: nice could not run ffmpeg. A signal: killed (the OOM killer too).
      if (signal || code === null || (code >= 125 && code <= 127)) return finish('doubt');
      finish(!ENVIRONMENT.test(stderr) && BAD_INPUT.test(stderr) ? 'bad' : 'doubt');
    });
  });
}

// The file as it is now: { size, mtimeMs } when it is a readable regular file, else null.
async function readableFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    await fs.promises.access(filePath, fs.constants.R_OK);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}
const sameFile = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Does ffmpeg decode the file from start to end? No queue, no memory.
 * @returns {Promise<boolean|null>} true, false (see above), or null = not established
 */
async function checkFile(filePath) {
  const before = await readableFile(filePath);
  if (!before) return null;
  const first = await runDecode(filePath);
  if (first === 'ok') return true;
  if (first !== 'bad' || !sameFile(before, await readableFile(filePath))) return null;
  const second = await runDecode(filePath);
  if (second !== 'bad' || !sameFile(before, await readableFile(filePath))) return null;
  return false;
}

/**
 * checkFile, one at a time, with a short waiting line and a memory of certain verdicts.
 * @returns {Promise<boolean|null>} null also when it is too busy
 */
async function decodes(filePath, stat) {
  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  const hit = verdicts.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.ok;
  if (waiting >= MAX_WAITING) return null;
  waiting += 1;
  const run = chain.then(() => checkFile(filePath));
  chain = run.catch(() => {});
  let ok;
  try { ok = await run; } finally { waiting -= 1; }
  if (ok !== null) {
    if (verdicts.size > 500) verdicts.clear();
    verdicts.set(key, { at: Date.now(), ok });
  }
  return ok;
}

/**
 * @param {{ id: string, file_path: string }} song - a library_songs row
 * @returns {Promise<{ broken: 'missing'|'undecodable'|null, why: string, file_path: string }>}
 *   broken null = not established (`why` is for the log only). `file_path` is
 *   the file the verdict is about: the report may only be stored while the
 *   song still has it (songReports.report), since a replace can commit while
 *   this runs.
 */
async function verifyBroken(song) {
  const file_path = song.file_path;
  const no = (why) => ({ broken: null, why, file_path });
  let stat;
  try {
    stat = await fs.promises.stat(file_path);
  } catch (err) {
    if (err.code !== 'ENOENT') return no(`cannot read the file (${err.code})`);
    const health = await storageHealth(song.id);
    if (!health.healthy) return no(`file missing, but the storage is not known to be healthy (${health.present}/${health.sampled} other files present)`);
    // Still missing after the look around?
    const again = await fs.promises.stat(file_path).then(() => null, (e) => e.code);
    if (again !== 'ENOENT') return no('the file is there after all');
    return { broken: 'missing', why: `file missing, ${health.present}/${health.sampled} other files present`, file_path };
  }
  if (!stat.isFile()) return no('not a file');
  const ok = await decodes(file_path, stat);
  if (ok === false) return { broken: 'undecodable', why: 'ffmpeg cannot decode it (twice, file unchanged)', file_path };
  return no(ok ? 'the file decodes' : 'the decode check gave no certain answer (busy, timed out, no ffmpeg, the file changed or is unreadable, or an error that is not about the file)');
}

module.exports = { verifyBroken, checkFile, storageHealth, storageHealthCached, MIN_SAMPLE, HEALTHY_RATIO };
