// The server's own "is this file broken?" check (songVerify.js), on files in a
// temp folder (no database: verifyBroken only asks it for a MISSING file).
// "Broken" needs ffmpeg to blame the file, twice, with the file unchanged;
// everything else (unreadable, out of memory, no ffmpeg, a timeout, a file
// that vanished or changed, a full queue) is "not established".
// VERIFY_FFMPEG puts a stand-in script in ffmpeg's place.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const BAD_INPUT = 'Error opening input: Invalid data found when processing input';

describe('songVerify: the decode check', { skip: !has('ffmpeg -version') && 'ffmpeg not available' }, () => {
  let verifyBroken;
  let dir;
  let n = 0;
  const garbage = () => { const p = path.join(dir, `bad${++n}.m4a`); fs.writeFileSync(p, crypto.randomBytes(20000)); return p; };
  const fake = (body) => { const p = path.join(dir, `fake${++n}.sh`); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
  const check = (file_path) => verifyBroken({ id: 'x', file_path });

  before(() => {
    ({ verifyBroken } = require('./songVerify'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-verify-'));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => { delete process.env.VERIFY_FFMPEG; delete process.env.VERIFY_DECODE_TIMEOUT_MS; });

  it('a good file decodes; garbage, an empty file and a damaged middle do not', async () => {
    const good = path.join(dir, 'good.m4a');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', good]);
    assert.equal((await check(good)).broken, null);
    const opus = path.join(dir, 'good.opus');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', opus]);
    assert.equal((await check(opus)).broken, null);

    const bad = garbage();
    const v = await check(bad);
    assert.equal(v.broken, 'undecodable');
    assert.equal(v.file_path, bad, 'the verdict names the file it is about');
    const empty = path.join(dir, 'empty.m4a');
    fs.writeFileSync(empty, '');
    assert.equal((await check(empty)).broken, 'undecodable');
    const damaged = Buffer.from(fs.readFileSync(good));
    crypto.randomFillSync(damaged, Math.floor(damaged.length / 3), Math.floor(damaged.length / 3));
    const mid = path.join(dir, 'mid.m4a');
    fs.writeFileSync(mid, damaged);
    assert.equal((await check(mid)).broken, 'undecodable');
  });

  it('an unreadable file is not a broken file', { skip: process.getuid && process.getuid() === 0 && 'running as root' }, async () => {
    const p = garbage();
    fs.chmodSync(p, 0o000);
    try {
      assert.equal((await check(p)).broken, null);
    } finally {
      fs.chmodSync(p, 0o644);
    }
    assert.equal((await check(p)).broken, 'undecodable', 'and that doubt was not remembered');
  });

  it('ffmpeg failing for reasons of its surroundings is not a broken file, and is not remembered', async () => {
    const p = garbage();
    for (const line of [
      'Error opening input: Cannot allocate memory',
      `Error opening input file ${p}.\nError opening input files: No such file or directory`,
      'Error opening input: Input/output error',
      'Error opening input: Permission denied',
      'Error opening input: Too many open files',
      // Even next to words that blame the input.
      `${BAD_INPUT}\nCannot allocate memory`,
      // Nothing that says what went wrong.
      'something went wrong',
      '',
    ]) {
      process.env.VERIFY_FFMPEG = fake(`cat <<'MSG' >&2\n${line}\nMSG\nexit 1`);
      assert.equal((await check(p)).broken, null, JSON.stringify(line));
    }
    delete process.env.VERIFY_FFMPEG;
    assert.equal((await check(p)).broken, 'undecodable', 'the real check still runs afterwards');
  });

  it('no ffmpeg, a killed one and a timeout are not a broken file', async () => {
    const p = garbage();
    process.env.VERIFY_FFMPEG = path.join(dir, 'no-such-ffmpeg');
    assert.equal((await check(p)).broken, null, 'absent');
    process.env.VERIFY_FFMPEG = fake(`echo "${BAD_INPUT}" >&2\nkill -9 $$`);
    assert.equal((await check(p)).broken, null, 'killed');
    process.env.VERIFY_FFMPEG = fake('exec sleep 5');
    process.env.VERIFY_DECODE_TIMEOUT_MS = '300';
    const started = Date.now();
    assert.equal((await check(p)).broken, null, 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  it('one failed run is not enough: the second must fail too', async () => {
    const p = garbage();
    const marker = path.join(dir, 'ran-once');
    process.env.VERIFY_FFMPEG = fake(`if [ -e "${marker}" ]; then exit 0; fi\n: > "${marker}"\necho "${BAD_INPUT}" >&2\nexit 1`);
    assert.equal((await check(p)).broken, null);
    assert.equal(fs.existsSync(marker), true);
  });

  it('a file that vanished or changed while it was checked (a replace) is not a broken file', async () => {
    const gone = garbage();
    // $6 is the input path (… -xerror -i <file> …).
    process.env.VERIFY_FFMPEG = fake(`rm -f "$6"\necho "${BAD_INPUT}" >&2\nexit 1`);
    assert.equal((await check(gone)).broken, null, 'deleted during the check');
    assert.equal(fs.existsSync(gone), false);

    const changed = garbage();
    process.env.VERIFY_FFMPEG = fake(`echo more >> "$6"\necho "${BAD_INPUT}" >&2\nexit 1`);
    assert.equal((await check(changed)).broken, null, 'rewritten during the check');
  });

  it('a burst is queued up to a limit; beyond it the answer is "not established", never "broken"', async () => {
    const files = Array.from({ length: 10 }, garbage);
    const out = await Promise.all(files.map(check));
    const broken = out.filter((v) => v.broken === 'undecodable').length;
    const busy = out.filter((v) => v.broken === null).length;
    assert.equal(broken + busy, 10);
    assert.ok(broken >= 1 && broken <= 4, `ran ${broken}`);
    assert.ok(busy >= 6, `turned away ${busy}`);
    // Asked again when it is quiet, a turned-away one is checked.
    assert.equal((await check(files[9])).broken, 'undecodable');
  });
});
