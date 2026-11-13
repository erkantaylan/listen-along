'use strict';

// Self-update fixtures shared by update.test.js and worker.test.js: a bundle
// in the server's format (backend/src/cliRelease.js) and a pretend install.
// Not a test file itself.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./helpers');

/** A bundle in the server's format (backend/src/cliRelease.js). */
function makeBundle(version, extra = {}, { omit = [], doc: patchDoc } = {}) {
  const files = {
    'bin/la.js': { data: `#!/usr/bin/env node\n// la ${version}\n`, mode: 0o755 },
    'src/cli.js': `// cli ${version}\n`,
    'src/update.js': `// update ${version}\n`,
    'package.json': JSON.stringify({ name: 'listen-along-cli', version }),
    'README.md': `# la ${version}\n`,
    ...extra,
  };
  for (const k of omit) delete files[k];
  const list = Object.keys(files).sort().map((p) => {
    const f = typeof files[p] === 'string' ? { data: files[p] } : files[p];
    const data = Buffer.from(f.data);
    return { path: p, mode: f.mode || 0o644, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
  });
  let doc = { format: 'la-cli-bundle', format_version: 1, version, files: list };
  if (patchDoc) doc = patchDoc(doc);
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256, latest: { version, sha256, size: buffer.length, url: '/api/cli/bundle' } };
}

/** A pretend install (old version) with a test/ folder that must survive. */
function fakeInstall(version = '0.0.1') {
  const root = tmpDir('la-install-');
  const write = (rel, data, mode) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, mode ? { mode } : undefined);
  };
  write('bin/la.js', '// old bin\n', 0o755);
  write('src/cli.js', '// old cli\n');
  write('src/old-only.js', '// gone after the update\n');
  write('package.json', JSON.stringify({ name: 'listen-along-cli', version }));
  write('README.md', '# old\n');
  write('test/keep.test.js', '// mine\n');
  return root;
}

/** Every file under root (relative path -> content), for before/after checks. */
function snapshot(root) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out[r] = fs.readFileSync(path.join(root, r), 'utf8');
    }
  };
  walk('');
  return out;
}

module.exports = { makeBundle, fakeInstall, snapshot };
