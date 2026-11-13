// The `la` CLI this server ships (cli/ copied into the image), offered to
// `la worker` / `la update` so downloaders update themselves.
//
// At boot the bundled cli/package.json version is read and the CLI's files
// (bin/**, src/**, package.json, README.md; never test/) are packed into one
// deterministic bundle, kept in memory with its sha256:
//
//   bundle = gzip(JSON {
//     format: 'la-cli-bundle', format_version: 1, version,
//     files: [{ path, mode, size, sha256, data }]   // sorted by path
//   })
//
// path is relative with '/' separators, mode 0o755 (executable) or 0o644, data
// base64. The CLI unpacks it with Node built-ins only (zlib + JSON); it has no
// npm dependencies, so an update is just these files.
//
//   GET /api/cli/latest  -> { version, sha256, size, url }
//   GET /api/cli/bundle  -> the bundle (application/gzip, ETag "<sha256>")
//
// Both take any valid CLI Bearer token (a worker has one); 404 NO_CLI_BUNDLE
// when the server runs without cli/ (a dev checkout started elsewhere).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');

const FORMAT = 'la-cli-bundle';
const FORMAT_VERSION = 1;
const BUNDLE_URL = '/api/cli/bundle';
const TOP_FILES = ['package.json', 'README.md'];
const TOP_DIRS = ['bin', 'src'];
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two x.y.z versions: -1, 0, 1; null when either is not x.y.z. */
function compareVersions(a, b) {
  const pa = VERSION_RE.exec(String(a || '').trim().replace(/^v/, ''));
  const pb = VERSION_RE.exec(String(b || '').trim().replace(/^v/, ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `version` is a valid x.y.z older than `latest`. */
function isOutdated(version, latest) {
  return compareVersions(version, latest) === -1;
}

/** Where cli/ is: CLI_DIR, else next to src/ (Docker: /app/cli), else the repo's. */
function findCliDir(env = process.env) {
  if (env.CLI_DIR) return path.resolve(env.CLI_DIR);
  for (const dir of [path.join(__dirname, '..', 'cli'), path.join(__dirname, '..', '..', 'cli')]) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'bin', 'la.js'))) return dir;
  }
  return null;
}

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, childRel, out);
    else if (ent.isFile()) out.push(childRel); // no symlinks, sockets, ...
  }
}

/**
 * Pack a cli/ directory. Throws when it is not a usable CLI.
 * @returns {{ version, buffer: Buffer, sha256, size, files: number }}
 */
function buildBundle(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const version = String(pkg.version || '');
  if (!VERSION_RE.test(version)) throw new Error(`cli/package.json has no x.y.z version (${version || 'none'})`);
  const rels = [];
  for (const d of TOP_DIRS) if (fs.existsSync(path.join(dir, d))) walk(dir, d, rels);
  for (const f of TOP_FILES) if (fs.existsSync(path.join(dir, f))) rels.push(f);
  if (!rels.includes('bin/la.js') || !rels.includes('src/cli.js')) throw new Error('cli/ has no bin/la.js or src/cli.js');
  rels.sort();
  let total = 0;
  const files = rels.map((rel) => {
    const abs = path.join(dir, ...rel.split('/'));
    const data = fs.readFileSync(abs);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('cli/ is too large to bundle');
    const executable = rel.startsWith('bin/') || (fs.statSync(abs).mode & 0o111) !== 0;
    return {
      path: rel,
      mode: executable ? 0o755 : 0o644,
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      data: data.toString('base64'),
    };
  });
  const json = JSON.stringify({ format: FORMAT, format_version: FORMAT_VERSION, version, files });
  const buffer = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  return { version, buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length, files: files.length };
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.dir] - cli/ directory (default findCliDir())
 * @param {(...a) => void} [opts.log]
 */
function createCliRelease(opts = {}) {
  const log = opts.log || ((...a) => console.log('[cli]', ...a));
  const dir = opts.dir !== undefined ? opts.dir : findCliDir();
  let bundle = null;

  function load() {
    bundle = null;
    if (!dir) { log('no cli/ directory: `la` self-update is off'); return null; }
    try {
      bundle = buildBundle(dir);
      log(`la ${bundle.version} bundled for self-update (${bundle.files} files, ${bundle.size} bytes, sha256 ${bundle.sha256.slice(0, 12)}…)`);
    } catch (err) {
      log(`cannot bundle ${dir}: ${err.message}; \`la\` self-update is off`);
    }
    return bundle;
  }

  /** { version, sha256, size, url } or null. */
  function latest() {
    return bundle ? { version: bundle.version, sha256: bundle.sha256, size: bundle.size, url: BUNDLE_URL } : null;
  }

  return { load, latest, bundle: () => bundle, dir };
}

/**
 * GET /api/cli/latest and /api/cli/bundle.
 * @param {object} o
 * @param {ReturnType<typeof createCliRelease>} o.release
 * @param {Function} o.requireToken - tokens.requireToken
 * @param {Function} [o.limiter]
 */
function createCliRouter({ release, requireToken, limiter }) {
  const router = express.Router();
  const pass = (req, res, next) => next();
  const notFound = (res) => res.status(404).json({ error: 'This server does not offer la updates', code: 'NO_CLI_BUNDLE' });

  router.get('/api/cli/latest', limiter || pass, requireToken, (req, res) => {
    const l = release.latest();
    if (!l) return notFound(res);
    res.set('Cache-Control', 'no-store');
    res.json(l);
  });

  router.get(BUNDLE_URL, limiter || pass, requireToken, (req, res) => {
    const b = release.bundle();
    if (!b) return notFound(res);
    const etag = `"${b.sha256}"`;
    res.set({ 'Cache-Control': 'private, no-cache', ETag: etag });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Length': String(b.size),
      'Content-Disposition': `attachment; filename="la-cli-${b.version}.json.gz"`,
      'X-La-Version': b.version,
      'X-La-Sha256': b.sha256,
    });
    res.end(b.buffer);
  });

  return router;
}

module.exports = { createCliRelease, createCliRouter, buildBundle, findCliDir, compareVersions, isOutdated, FORMAT, FORMAT_VERSION, BUNDLE_URL };
