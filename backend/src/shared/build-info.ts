// Build/version info for GET /api/version. The Docker build writes
// build-info.json (commit from GIT_COMMIT build arg or the context's .git);
// env vars override it at runtime. No git binary needed at runtime.
import fs from 'node:fs';
import path from 'node:path';

/** backend/build-info.json (/app/build-info.json in the image). */
const DEFAULT_FILE = path.join(import.meta.dirname, '..', '..', 'build-info.json');

/** What GET /api/version answers. */
export interface VersionInfo {
  version: string;
  name: string;
  /** 7 hex digits, or 'unknown' */
  commit: string;
  commitDate: string | null;
  builtAt: string | null;
}

interface BuildFile {
  commit?: unknown;
  commitDate?: unknown;
  builtAt?: unknown;
}

function readBuildFile(file: string): BuildFile {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function getVersionInfo({ pkg, env = process.env, file = DEFAULT_FILE }: {
  pkg: { version: string; name: string };
  env?: Record<string, string | undefined>;
  file?: string;
}): VersionInfo {
  const b = readBuildFile(file);
  const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const full = clean(env.GIT_COMMIT) || clean(env.SOURCE_COMMIT) || clean(b.commit);
  return {
    version: env.VERSION || pkg.version,
    name: pkg.name,
    commit: full ? full.slice(0, 7) : 'unknown',
    commitDate: clean(env.GIT_COMMIT_DATE) || clean(b.commitDate) || null,
    builtAt: clean(b.builtAt) || null,
  };
}
