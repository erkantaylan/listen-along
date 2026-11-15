import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVersionInfo } from './build-info.ts';

const pkg = { version: '1.2.3', name: 'x' };

test('reads commit from build-info file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bi-')), 'b.json');
  fs.writeFileSync(f, JSON.stringify({ commit: '64f31f3abcdef0123', commitDate: '2026-10-30T00:00:00Z', builtAt: 'now' }));
  assert.deepStrictEqual(getVersionInfo({ pkg, env: {}, file: f }),
    { version: '1.2.3', name: 'x', commit: '64f31f3', commitDate: '2026-10-30T00:00:00Z', builtAt: 'now' });
});

test('env overrides file; missing file gives unknown', () => {
  assert.strictEqual(getVersionInfo({ pkg, env: {}, file: '/nonexistent' }).commit, 'unknown');
  assert.strictEqual(getVersionInfo({ pkg, env: { GIT_COMMIT: 'abcdef123456' }, file: '/nonexistent' }).commit, 'abcdef1');
});
