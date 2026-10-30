// Build/version info for GET /api/version. The Docker build writes
// build-info.json (commit from GIT_COMMIT build arg or the context's .git);
// env vars override it at runtime. No git binary needed at runtime.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'build-info.json');

function readBuildFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function getVersionInfo({ pkg, env = process.env, file = DEFAULT_FILE } = {}) {
  const b = readBuildFile(file);
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const full = clean(env.GIT_COMMIT) || clean(env.SOURCE_COMMIT) || clean(b.commit);
  return {
    version: env.VERSION || pkg.version,
    name: pkg.name,
    commit: full ? full.slice(0, 7) : 'unknown',
    commitDate: clean(env.GIT_COMMIT_DATE) || clean(b.commitDate) || null,
    builtAt: clean(b.builtAt) || null,
  };
}

module.exports = { getVersionInfo };
