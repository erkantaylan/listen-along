'use strict';

/**
 * Self-update: the server ships the la it was built with (backend
 * cliRelease.js) and offers it as one bundle:
 *
 *   GET /api/cli/latest -> { version, sha256, size, url }
 *   GET <url>           -> gzip(JSON { format: 'la-cli-bundle', format_version: 1,
 *                          version, files: [{ path, mode, size, sha256, data(base64) }] })
 *
 * la has no npm dependencies, so an update is replacing bin/, src/,
 * package.json and README.md in the folder this file lives in (resolved from
 * __dirname; test/ and anything else there is left alone). Nothing from the
 * bundle is run here: `la worker` picks the new files up by restarting its
 * child process (supervisor.js), every other command at its next start.
 *
 * Trust: the bundle comes from the server the token is configured for, over
 * the same connection as everything else, its sha256 must match what
 * /api/cli/latest said, redirects are refused, and paths are checked before
 * anything is written. Never an older or equal version.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { CliError, EXIT } = require('./errors');

const FORMAT = 'la-cli-bundle';
const FORMAT_VERSION = 1;
/** What an update replaces, in this order. */
const ENTRIES = ['src', 'bin', 'package.json', 'README.md'];
const TOP_DIRS = new Set(['bin', 'src']);
const TOP_FILES = new Set(['package.json', 'README.md']);
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const STAGE_PREFIX = '.la-update-';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two x.y.z versions: -1, 0, 1; null when either is not x.y.z. */
function compareVersions(a, b) {
  const pa = VERSION_RE.exec(String(a ?? '').trim().replace(/^v/, ''));
  const pb = VERSION_RE.exec(String(b ?? '').trim().replace(/^v/, ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when `latest` is a valid version strictly newer than `current`. */
function isNewer(latest, current) {
  return compareVersions(latest, current) === 1;
}

/** The folder holding bin/la.js and src/ (this install). */
function installRoot() {
  return path.resolve(__dirname, '..');
}

/** The version on disk now (another process may have updated it). */
function diskVersion(root = installRoot()) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '') || null;
  } catch {
    return null;
  }
}

/** Inside a git checkout (cli/ of a cloned repo, or a cloned cli/)? */
function inGitCheckout(root = installRoot()) {
  return fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, '..', '.git'));
}

function fail(message, code = 'UPDATE_FAILED', hint) {
  return new CliError(message, { code, exitCode: EXIT.FAILURE, hint });
}

/** Absolute URL of the bundle on the configured server; never another origin. */
function bundleUrl(server, url) {
  const base = new URL(server.replace(/\/+$/, '') + '/');
  const target = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
    ? new URL(server.replace(/\/+$/, '') + url)
    : new URL(String(url || ''), base);
  if (target.origin !== base.origin) throw fail(`The server pointed the update at another host (${target.host}); refused`, 'UPDATE_REFUSED');
  return target.toString();
}

/**
 * Download the bundle (no redirects), check size and sha256.
 * @returns {Promise<Buffer>}
 */
async function downloadBundle({ server, token, latest, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  const url = bundleUrl(server, latest.url || '/api/cli/bundle');
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/gzip' },
      redirect: 'manual',
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    throw fail(`Cannot download the la ${latest.version} bundle: ${err.cause?.code || err.message}`, 'UPDATE_DOWNLOAD');
  }
  if (res.status >= 300 && res.status < 400) throw fail(`The server redirected the la bundle download (${res.status}); refused`, 'UPDATE_REFUSED');
  if (!res.ok) throw fail(`Downloading the la ${latest.version} bundle failed (HTTP ${res.status})`, 'UPDATE_DOWNLOAD');
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BUNDLE_BYTES) throw fail('The la bundle is too large', 'UPDATE_BAD_BUNDLE');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BUNDLE_BYTES) throw fail('The la bundle is too large', 'UPDATE_BAD_BUNDLE');
  verifySha256(buf, latest.sha256);
  return buf;
}

function verifySha256(buf, expected) {
  if (!/^[a-f0-9]{64}$/i.test(String(expected || ''))) throw fail('The server gave no valid sha256 for the la bundle', 'UPDATE_BAD_BUNDLE');
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== String(expected).toLowerCase()) throw fail(`The la bundle's sha256 does not match (got ${got.slice(0, 12)}…, expected ${String(expected).slice(0, 12)}…)`, 'UPDATE_BAD_CHECKSUM');
}

/** A bundle path is safe: relative, '/'-separated, plain names, under bin/ or src/ or a known top file. */
function safePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return false;
  const parts = p.split('/');
  if (!parts.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) return false;
  if (parts.length === 1) return TOP_FILES.has(p);
  return TOP_DIRS.has(parts[0]);
}

/**
 * Unpack and check a bundle (gzip + JSON).
 * @param {Buffer} buf
 * @param {object} [o]
 * @param {string} [o.expectVersion] - the version /api/cli/latest announced
 * @returns {{ version: string, files: {path: string, mode: number, data: Buffer}[] }}
 */
function parseBundle(buf, { expectVersion } = {}) {
  let doc;
  try {
    doc = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES }).toString('utf8'));
  } catch (err) {
    throw fail(`The la bundle cannot be read: ${err.message}`, 'UPDATE_BAD_BUNDLE');
  }
  if (!doc || doc.format !== FORMAT || doc.format_version !== FORMAT_VERSION || !Array.isArray(doc.files)) {
    throw fail('Not an la bundle this la understands', 'UPDATE_BAD_BUNDLE');
  }
  const version = String(doc.version || '');
  if (!VERSION_RE.test(version)) throw fail('The la bundle has no valid version', 'UPDATE_BAD_BUNDLE');
  if (expectVersion && version !== expectVersion) throw fail(`The bundle is la ${version}, not the announced ${expectVersion}`, 'UPDATE_BAD_BUNDLE');
  const seen = new Set();
  const files = doc.files.map((f) => {
    if (!f || !safePath(f.path)) throw fail(`The la bundle has an unsafe path: ${String(f && f.path).slice(0, 80)}`, 'UPDATE_BAD_BUNDLE');
    const key = f.path.toLowerCase(); // also no clashes on case-insensitive disks
    if (seen.has(key)) throw fail(`The la bundle lists ${f.path} twice`, 'UPDATE_BAD_BUNDLE');
    seen.add(key);
    if (typeof f.data !== 'string') throw fail(`The la bundle has no data for ${f.path}`, 'UPDATE_BAD_BUNDLE');
    const data = Buffer.from(f.data, 'base64');
    if (f.size !== undefined && data.length !== f.size) throw fail(`The la bundle's ${f.path} has the wrong size`, 'UPDATE_BAD_BUNDLE');
    if (f.sha256 && crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) throw fail(`The la bundle's ${f.path} is damaged`, 'UPDATE_BAD_BUNDLE');
    return { path: f.path, mode: (Number(f.mode) & 0o111) ? 0o755 : 0o644, data };
  });
  for (const need of ['bin/la.js', 'src/cli.js', 'package.json']) {
    if (!seen.has(need.toLowerCase())) throw fail(`The la bundle has no ${need}`, 'UPDATE_BAD_BUNDLE');
  }
  let pkgVersion = null;
  try { pkgVersion = JSON.parse(files.find((f) => f.path === 'package.json').data.toString('utf8')).version; } catch {}
  if (pkgVersion !== version) throw fail(`The la bundle's package.json says ${pkgVersion || 'nothing'}, not ${version}`, 'UPDATE_BAD_BUNDLE');
  return { version, files };
}

/** Synchronous sleep (rename retries; keeps the swap free of awaits). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename, retried a little: Windows antivirus / indexers hold files briefly. */
function renameRetry(fsi, from, to) {
  for (let i = 0; ; i++) {
    try { fsi.renameSync(from, to); return; } catch (err) {
      if (i >= 15 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code)) throw err;
      sleepSync(50 + i * 50);
    }
  }
}

function rmQuiet(fsi, p) {
  try { fsi.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; } catch { return false; }
}

/** Remove leftovers of an earlier update (an hour old: never a running one). */
function cleanLeftovers(root = installRoot(), { fs: fsi = fs, now = Date.now() } = {}) {
  let names = [];
  try { names = fsi.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    const p = path.join(root, name);
    try { if (now - fsi.statSync(p).mtimeMs > 3600 * 1000) rmQuiet(fsi, p); } catch { /* gone */ }
  }
}

/**
 * Swap the install's files for `files`, synchronously (no job can start in
 * between). The new tree is written to <root>/.la-update-new-*, then each of
 * src, bin, package.json, README.md is renamed aside to <root>/.la-update-old-*
 * and the new one renamed in. On any failure everything moved is put back and
 * the error is thrown: the old version stays in place, whole.
 * @param {string} root
 * @param {{path, mode, data}[]} files
 * @param {object} [o]
 * @param {object} [o.fs] - fs (tests inject failures)
 */
function installFiles(root, files, { fs: fsi = fs } = {}) {
  const stamp = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const stage = path.join(root, `${STAGE_PREFIX}new-${stamp}`);
  const aside = path.join(root, `${STAGE_PREFIX}old-${stamp}`);
  try {
    fsi.mkdirSync(stage);
    for (const f of files) {
      const dest = path.join(stage, ...f.path.split('/'));
      fsi.mkdirSync(path.dirname(dest), { recursive: true });
      fsi.writeFileSync(dest, f.data, { mode: f.mode });
      if (process.platform !== 'win32') fsi.chmodSync(dest, f.mode);
    }
    fsi.mkdirSync(aside);
  } catch (err) {
    rmQuiet(fsi, stage);
    rmQuiet(fsi, aside);
    throw fail(`Cannot write the new la files in ${root}: ${err.message}`, 'UPDATE_WRITE');
  }

  const done = []; // { entry, movedAside, movedIn }
  try {
    for (const entry of ENTRIES) {
      const cur = path.join(root, entry);
      const next = path.join(stage, entry);
      const step = { entry, movedAside: false, movedIn: false };
      done.push(step);
      if (fsi.existsSync(cur)) { renameRetry(fsi, cur, path.join(aside, entry)); step.movedAside = true; }
      if (fsi.existsSync(next)) { renameRetry(fsi, next, cur); step.movedIn = true; }
    }
  } catch (err) {
    const problems = [];
    for (const step of done.reverse()) {
      const cur = path.join(root, step.entry);
      try {
        if (step.movedIn) renameRetry(fsi, cur, path.join(stage, step.entry));
        if (step.movedAside) renameRetry(fsi, path.join(aside, step.entry), cur);
      } catch (e) {
        problems.push(`${step.entry}: ${e.message}`);
      }
    }
    if (!problems.length) { rmQuiet(fsi, stage); rmQuiet(fsi, aside); }
    throw fail(
      problems.length
        ? `Updating la failed (${err.message}) and putting the old files back failed too (${problems.join('; ')}); the old files are in ${aside}`
        : `Updating la failed: ${err.message}; the old version was put back`,
      problems.length ? 'UPDATE_ROLLBACK_FAILED' : 'UPDATE_FAILED',
    );
  }
  const asideGone = rmQuiet(fsi, aside);
  const stageGone = rmQuiet(fsi, stage);
  return { cleaned: asideGone && stageGone };
}

/**
 * GET /api/cli/latest. Resolves null when the server offers no updates (404).
 * @param {object} api - ApiClient
 */
async function fetchLatest(api) {
  const r = await api.request('GET', '/api/cli/latest', { okStatuses: [404], timeoutMs: 15000 });
  if (r.status === 404 || !r.data || !VERSION_RE.test(String(r.data.version || ''))) return null;
  return r.data;
}

/**
 * Download, verify and unpack `latest` (nothing written yet).
 * @returns {Promise<{ version, files }>}
 */
async function prepareUpdate({ server, token, latest, fetch: fetchImpl }) {
  const buf = await downloadBundle({ server, token, latest, fetch: fetchImpl });
  return parseBundle(buf, { expectVersion: latest.version });
}

/**
 * Check, then install `latest` if newer than `current` (the running code).
 * @returns {Promise<{ updated: boolean, from, to, root, reason?, git? }>}
 *   reason: 'up_to_date' | 'already_on_disk' (another process got it first)
 */
async function performUpdate({ server, token, latest, current, root = installRoot(), fetch: fetchImpl, fs: fsi }) {
  const base = { from: current, to: latest.version, root };
  if (!isNewer(latest.version, current)) return { ...base, updated: false, reason: 'up_to_date' };
  const onDisk = diskVersion(root);
  if (onDisk && compareVersions(onDisk, latest.version) >= 0) return { ...base, updated: true, reason: 'already_on_disk' };
  try { fs.accessSync(root, fs.constants.W_OK); } catch {
    throw fail(`Cannot update la: ${root} is not writable by this user`, 'UPDATE_NOT_WRITABLE', 'Update it by hand, or run la as the user that owns that folder');
  }
  cleanLeftovers(root);
  const prepared = await prepareUpdate({ server, token, latest, fetch: fetchImpl });
  installFiles(root, prepared.files, fsi ? { fs: fsi } : {});
  return { ...base, updated: true, git: inGitCheckout(root) };
}

// --- Daily hint for other commands --------------------------------------------

const HINT_EVERY_MS = 24 * 3600 * 1000;

function stampPath(configFile) {
  return path.join(path.dirname(configFile), 'update-check.json');
}

/**
 * At most once a day: ask the server for its la and say on stderr if it is
 * newer. Any failure is silent; capped by a short timeout.
 * @returns {Promise<string|null>} the hint printed, if any
 */
async function maybeHint({ api, configFile, current, stderr, now = Date.now(), timeoutMs = 2000 }) {
  const file = stampPath(configFile);
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (now - Number(st.checked_at || 0) < HINT_EVERY_MS) return null;
  } catch { /* never checked */ }
  let latest = null;
  try {
    const r = await api.request('GET', '/api/cli/latest', { okStatuses: [404], timeoutMs });
    latest = r.status === 200 && r.data ? r.data : null;
  } catch {
    return null; // offline / server down: ask again next time
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ checked_at: now, latest: latest ? latest.version : null })}\n`);
  } catch { /* read-only config dir: fine */ }
  if (!latest || !isNewer(latest.version, current)) return null;
  const hint = `la ${latest.version} is available (this is ${current}); run \`la update\``;
  stderr.write(`${hint}\n`);
  return hint;
}

module.exports = {
  compareVersions,
  isNewer,
  installRoot,
  diskVersion,
  inGitCheckout,
  bundleUrl,
  downloadBundle,
  verifySha256,
  parseBundle,
  safePath,
  installFiles,
  cleanLeftovers,
  fetchLatest,
  prepareUpdate,
  performUpdate,
  maybeHint,
  stampPath,
  ENTRIES,
  STAGE_PREFIX,
};
