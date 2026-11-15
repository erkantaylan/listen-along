// Silence measurements with the real ffmpeg on generated files: why -50 dBFS
// for at least 1 s at the very start / end (silence.ts). Kept apart from the
// unit tests: these decode real files. Deterministic under load: no timing in
// any assertion, a generous per-file limit (120 s; a 15 s file takes well
// under a second), files made once, run one after the other.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureFile } from './silence.ts';

const has = (cmd: string) => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = has('ffmpeg') ? false : 'ffmpeg not available';

// Amplitude of a peak level in dBFS.
const amp = (db: number) => Math.pow(10, db / 20).toFixed(6);
const tone = (seconds: number, db: number, hz = 440) => `aevalsrc=${amp(db)}*sin(2*PI*${hz}*t):s=48000:d=${seconds}`;
const silence = (seconds: number) => `aevalsrc=0:s=48000:d=${seconds}`;
const hiss = (seconds: number, db: number) => `anoisesrc=d=${seconds}:c=white:r=48000:a=${amp(db)}`;

describe('silence measured by ffmpeg', { skip, timeout: 600_000 }, () => {
  let tmp: string;
  const make = (name: string, parts: string[], { opus = false, filter = '' } = {}) => {
    const file = path.join(tmp, name);
    const inputs = parts.map((p, i) => `${p}[s${i}]`).join(';');
    const graph = `${inputs};${parts.map((_, i) => `[s${i}]`).join('')}concat=n=${parts.length}:v=0:a=1${filter ? `,${filter}` : ''}[out]`;
    const codec = opus ? ['-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'] : ['-c:a', 'aac', '-b:a', '128k', '-f', 'mp4'];
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-filter_complex', graph, '-map', '[out]', '-ac', '2', ...codec, file], { stdio: ['ignore', 'ignore', 'inherit'] });
    return file;
  };
  const measure = (file: string) => measureFile(file, { timeoutMs: 120_000 });
  const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) <= 150, `${what}: ${actual} ms, expected about ${expected}`);

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-ffmpeg-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a video upload with dead air (m4a): the lead-in and the tail', async () => {
    const r = await measure(make('dead-air.m4a', [silence(4), tone(6, -12), silence(5)]));
    assert.ok(r);
    near(r.leadMs, 4000, 'lead');
    near(r.trailMs, 5000, 'tail');
  });

  it('the same in Opus', async () => {
    const r = await measure(make('dead-air.opus', [silence(3), tone(6, -12), silence(6)], { opus: true }));
    assert.ok(r);
    near(r.leadMs, 3000, 'lead');
    near(r.trailMs, 6000, 'tail');
  });

  it('a pianissimo classical-style intro at -40 dBFS is music: nothing is cut', async () => {
    const r = await measure(make('pianissimo-40.m4a', [tone(5, -40, 330), tone(5, -12, 330)]));
    assert.deepEqual(r, { leadMs: 0, trailMs: 0 });
  });

  it('even at -46 dBFS, an intro is kept', async () => {
    const r = await measure(make('pianissimo-46.m4a', [tone(5, -46, 262), tone(5, -12, 262)]));
    assert.deepEqual(r, { leadMs: 0, trailMs: 0 });
  });

  it('a fade-in from silence and a fade-out to it are not dead air', async () => {
    const r = await measure(make('fades.m4a', [tone(10, -12)], { filter: 'afade=t=in:st=0:d=3,afade=t=out:st=7:d=3' }));
    assert.deepEqual(r, { leadMs: 0, trailMs: 0 });
  });

  it('room hiss at -60 dBFS before the music is dead air', async () => {
    const r = await measure(make('hiss.m4a', [hiss(3, -60), tone(6, -12)]));
    assert.ok(r);
    near(r.leadMs, 3000, 'lead');
    assert.equal(r.trailMs, 0);
  });

  it('a pause in the middle of a song is never trimmed', async () => {
    const r = await measure(make('middle.m4a', [tone(4, -12), silence(3), tone(4, -12)]));
    assert.deepEqual(r, { leadMs: 0, trailMs: 0 });
  });

  it('half a second of nothing is the song\'s own breath', async () => {
    const r = await measure(make('short.m4a', [silence(0.5), tone(6, -12), silence(0.6)]));
    assert.deepEqual(r, { leadMs: 0, trailMs: 0 });
  });

  it('a file of nothing but silence is all lead-in', async () => {
    const r = await measure(make('nothing.m4a', [silence(5)]));
    assert.ok(r);
    near(r.leadMs, 5000, 'lead');
    assert.equal(r.trailMs, 0);
  });

  it('no file, or not audio: no answer', async () => {
    assert.equal(await measure(path.join(tmp, 'missing.m4a')), null);
    const junk = path.join(tmp, 'junk.m4a');
    fs.writeFileSync(junk, 'not audio at all');
    assert.equal(await measure(junk), null);
  });
});
