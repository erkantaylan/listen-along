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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import type { RequestHandler, Router } from 'express';

export const FORMAT = 'la-cli-bundle';
export const FORMAT_VERSION = 1;
export const BUNDLE_URL = '/api/cli/bundle';
const TOP_FILES = ['package.json', 'README.md'];
const TOP_DIRS = ['bin', 'src'];
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two x.y.z versions: -1, 0, 1; null when either is not x.y.z. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
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
export function isOutdated(version: unknown, latest: unknown): boolean {
  return compareVersions(version, latest) === -1;
}

// The backend's src/ folder: this file is src/core/jobs/cliRelease.ts.
const SRC_DIR = path.join(import.meta.dirname, '..', '..');

/**
 * Where cli/ is: CLI_DIR (the image sets /app/cli), else next to src/
 * (Docker: /app/cli), else the repo's (a dev checkout: backend/src/../../cli).
 */
export function findCliDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLI_DIR) return path.resolve(env.CLI_DIR);
  for (const dir of [path.join(SRC_DIR, '..', 'cli'), path.join(SRC_DIR, '..', '..', 'cli')]) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'bin', 'la.js'))) return dir;
  }
  return null;
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, childRel, out);
    else if (ent.isFile()) out.push(childRel); // no symlinks, sockets, ...
  }
}

/** A packed cli/ (buildBundle). */
export interface CliBundle {
  version: string;
  buffer: Buffer;
  sha256: string;
  size: number;
  files: number;
}

/** What GET /api/cli/latest answers (and the worker welcome's cli_latest, without size). */
export interface CliLatestView {
  version: string;
  sha256: string;
  size: number;
  url: string;
}

/**
 * Pack a cli/ directory. Throws when it is not a usable CLI.
 */
export function buildBundle(dir: string): CliBundle {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const version = String(pkg.version || '');
  if (!VERSION_RE.test(version)) throw new Error(`cli/package.json has no x.y.z version (${version || 'none'})`);
  const rels: string[] = [];
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

export interface CliRelease {
  load(): CliBundle | null;
  /** { version, sha256, size, url } or null. */
  latest(): CliLatestView | null;
  bundle(): CliBundle | null;
  dir: string | null;
}

/**
 * @param opts.dir cli/ directory (default findCliDir())
 */
export function createCliRelease(opts: { dir?: string | null; log?: (...a: unknown[]) => void } = {}): CliRelease {
  const log = opts.log || ((...a: unknown[]) => console.log('[cli]', ...a));
  const dir = opts.dir !== undefined ? opts.dir : findCliDir();
  let bundle: CliBundle | null = null;

  function load(): CliBundle | null {
    bundle = null;
    if (!dir) { log('no cli/ directory: `la` self-update is off'); return null; }
    try {
      bundle = buildBundle(dir);
      log(`la ${bundle.version} bundled for self-update (${bundle.files} files, ${bundle.size} bytes, sha256 ${bundle.sha256.slice(0, 12)}…)`);
    } catch (err) {
      log(`cannot bundle ${dir}: ${(err as Error).message}; \`la\` self-update is off`);
    }
    return bundle;
  }

  /** { version, sha256, size, url } or null. */
  function latest(): CliLatestView | null {
    return bundle ? { version: bundle.version, sha256: bundle.sha256, size: bundle.size, url: BUNDLE_URL } : null;
  }

  return { load, latest, bundle: () => bundle, dir };
}

/**
 * GET /api/cli/latest and /api/cli/bundle.
 * @param o.requireToken tokens.requireToken
 */
export function createCliRouter({ release, requireToken, limiter }: {
  release: Pick<CliRelease, 'latest' | 'bundle'>;
  requireToken: RequestHandler;
  limiter?: RequestHandler;
}): Router {
  const router = express.Router();
  const pass: RequestHandler = (req, res, next) => next();
  const notFound = (res: express.Response) => res.status(404).json({ error: 'This server does not offer la updates', code: 'NO_CLI_BUNDLE' });

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

