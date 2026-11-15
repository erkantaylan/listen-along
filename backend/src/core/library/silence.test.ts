// Silence measurements: ffmpeg's silencedetect output read into lead-in / tail,
// and the scanner's order and discipline, with a stand-in database and
// measurer (no ffmpeg, no Postgres). Real ffmpeg: silence.ffmpeg.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSilencedetect, edgeSilence, createSilenceScanner } from './silence.ts';
import type { EdgeSilence, SilenceDb } from './silence.ts';
import { silenceOf } from './silenceRoutes.ts';

const stderr = (lines: string[], time = '00:00:17.00') => [
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'x.m4a\':',
  '  Duration: 00:00:17.02, start: 0.000000, bitrate: 63 kb/s',
  ...lines.map((l) => `[silencedetect @ 0x7f114c003380] ${l}`),
  `size=N/A time=${time} bitrate=N/A speed= 322x`,
].join('\n');

describe('reading silencedetect', () => {
  it('lead-in and tail', () => {
    const p = parseSilencedetect(stderr(['silence_start: 0', 'silence_end: 4.000042 | silence_duration: 4.000042', 'silence_start: 11.999979', 'silence_end: 17.002667 | silence_duration: 5.002687']));
    assert.equal(p.duration, 17);
    assert.deepEqual(edgeSilence(p), { leadMs: 4000, trailMs: 5000 });
  });

  it('a tail that ffmpeg leaves open (no silence_end at the end of the file)', () => {
    assert.deepEqual(edgeSilence(parseSilencedetect(stderr(['silence_start: 12.5']))), { leadMs: 0, trailMs: 4500 });
  });

  it('only the very start and the very end count: a quiet middle does not', () => {
    const p = parseSilencedetect(stderr(['silence_start: 6', 'silence_end: 9 | silence_duration: 3']));
    assert.deepEqual(edgeSilence(p), { leadMs: 0, trailMs: 0 });
    const both = parseSilencedetect(stderr(['silence_start: 0', 'silence_end: 2 | silence_duration: 2', 'silence_start: 6', 'silence_end: 9 | silence_duration: 3', 'silence_start: 15', 'silence_end: 17 | silence_duration: 2']));
    assert.deepEqual(edgeSilence(both), { leadMs: 2000, trailMs: 2000 });
  });

  it('no silence at all', () => {
    assert.deepEqual(edgeSilence(parseSilencedetect(stderr([]))), { leadMs: 0, trailMs: 0 });
  });

  it('a file that is silence from end to end is all lead-in, no tail', () => {
    assert.deepEqual(edgeSilence(parseSilencedetect(stderr(['silence_start: 0', 'silence_end: 17 | silence_duration: 17']))), { leadMs: 17000, trailMs: 0 });
  });

  it('the length falls back to the container when there is no time= line; unknown = no answer', () => {
    const p = parseSilencedetect('  Duration: 00:03:10.50, start: 0\n[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5');
    assert.equal(p.duration, 190.5);
    assert.equal(edgeSilence(parseSilencedetect('[silencedetect @ 0x1] silence_start: 0')), null);
  });

  it('the view: numbers or null', () => {
    assert.deepEqual(silenceOf({ lead_silence_ms: 4000, trail_silence_ms: 0 }), { lead_silence_ms: 4000, trail_silence_ms: 0 });
    assert.deepEqual(silenceOf({ lead_silence_ms: null }), { lead_silence_ms: null, trail_silence_ms: null });
  });
});

// A stand-in for library_songs: rows with created_at order, answering the scanner's queries.
interface FakeRow { id: string; file_path: string; created_at: Date; lead_silence_ms: number | null; trail_silence_ms: number | null }
function fakeDb(rows: FakeRow[], { available = true } = {}): SilenceDb & { updates: unknown[][] } {
  const updates: unknown[][] = [];
  const sorted = () => rows.slice().sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || (a.id < b.id ? 1 : -1));
  return {
    updates,
    isAvailable: () => available,
    async query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ');
      if (sql.startsWith('SELECT count(*)::int AS n')) return { rows: [{ n: rows.filter((r) => r.lead_silence_ms === null).length }], rowCount: 1 } as never;
      if (sql.includes('FILTER')) return { rows: [{ measured: rows.filter((r) => r.lead_silence_ms !== null).length, unmeasured: rows.filter((r) => r.lead_silence_ms === null).length }], rowCount: 1 } as never;
      if (sql.includes('WHERE lead_silence_ms IS NULL')) {
        let list = sorted().filter((r) => r.lead_silence_ms === null);
        if (params.length) {
          const [at, id] = params as [Date, string];
          list = list.filter((r) => r.created_at.getTime() < at.getTime() || (r.created_at.getTime() === at.getTime() && r.id < id));
        }
        return { rows: list.slice(0, 1).map((r) => ({ ...r })), rowCount: 1 } as never;
      }
      if (sql.startsWith('SELECT id::text AS id, file_path, created_at FROM library_songs WHERE id = $1')) {
        return { rows: rows.filter((r) => r.id === params[0]).map((r) => ({ ...r })), rowCount: 1 } as never;
      }
      if (sql.startsWith('UPDATE library_songs SET lead_silence_ms = NULL')) {
        for (const r of rows) if (r.id === params[0]) { r.lead_silence_ms = null; r.trail_silence_ms = null; }
        updates.push(['reset', params[0]]);
        return { rows: [], rowCount: 1 } as never;
      }
      if (sql.startsWith('UPDATE library_songs SET lead_silence_ms = $2')) {
        const [id, lead, trail, file] = params as [string, number, number, string];
        for (const r of rows) if (r.id === id && r.file_path === file) { r.lead_silence_ms = lead; r.trail_silence_ms = trail; }
        updates.push(['set', id, lead, trail]);
        return { rows: [], rowCount: 1 } as never;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe('the scanner', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-scan-'));
  const file = (name: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, 'x'); return f; };
  const row = (id: string, minutesAgo: number, f: string | null, lead: number | null = null): FakeRow => ({
    id, file_path: f || path.join(tmp, `missing-${id}`), created_at: new Date(Date.UTC(2026, 0, 1) - minutesAgo * 60_000), lead_silence_ms: lead, trail_silence_ms: lead,
  });
  const quiet = () => {};

  it('backfills newest first, one at a time, skips missing files, and leaves measured songs alone', async () => {
    const rows = [row('a', 30, file('a.m4a')), row('b', 10, file('b.m4a')), row('c', 20, null), row('d', 5, file('d.m4a'), 1200)];
    const db = fakeDb(rows);
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const scanner = createSilenceScanner({
      db, songsPath: tmp, startDelayMs: 0, pauseMs: 0, log: quiet, enabled: true, ffmpegCheck: async () => true,
      measure: async (f) => { running++; most = Math.max(most, running); order.push(path.basename(f)); await new Promise((r) => setTimeout(r, 5)); running--; return { leadMs: 1000, trailMs: 2000 }; },
    });
    await scanner.start();
    await scanner.idle();
    assert.deepEqual(order, ['b.m4a', 'a.m4a'], 'newest first; the missing file is never handed to ffmpeg; d was measured already');
    assert.equal(most, 1, 'strictly one at a time');
    assert.deepEqual(rows.map((r) => [r.id, r.lead_silence_ms]), [['a', 1000], ['b', 1000], ['c', null], ['d', 1200]]);
    const stats = await scanner.stats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.passDone, true);
    assert.equal(stats.done, 2);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.unmeasured, 1);
    scanner.stop();
  });

  it('a new start continues with what is still unmeasured', async () => {
    const rows = [row('a', 30, file('a2.m4a'), 0), row('b', 10, file('b2.m4a'))];
    const db = fakeDb(rows);
    const seen: string[] = [];
    const scanner = createSilenceScanner({ db, songsPath: tmp, startDelayMs: 0, pauseMs: 0, log: quiet, enabled: true, ffmpegCheck: async () => true, measure: async (f) => { seen.push(path.basename(f)); return { leadMs: 0, trailMs: 0 }; } });
    await scanner.start();
    await scanner.idle();
    assert.deepEqual(seen, ['b2.m4a']);
    scanner.stop();
  });

  it('uploads and replaces go first; a replace forgets the old numbers before measuring', async () => {
    const rows = [row('old1', 60, file('o1.m4a')), row('old2', 50, file('o2.m4a')), row('new', 1, file('n.m4a'), 5000)];
    const db = fakeDb(rows);
    const seen: string[] = [];
    let release: (() => void) | null = null;
    const scanner = createSilenceScanner({
      db, songsPath: tmp, startDelayMs: 0, pauseMs: 0, log: quiet, enabled: true, ffmpegCheck: async () => true,
      measure: async (f) => {
        seen.push(path.basename(f));
        // Hold the first backfill measurement until the hooks have queued their songs.
        if (seen.length === 1) await new Promise<void>((r) => { release = r; });
        return { leadMs: 10, trailMs: 20 } satisfies EdgeSilence;
      },
    });
    await scanner.start();
    while (!release) await new Promise((r) => setTimeout(r, 2));
    scanner.songReplaced({ id: 'new' });
    scanner.songAdded({ id: 'new' }); // already queued: once
    (release as () => void)();
    await scanner.idle();
    assert.deepEqual(seen, ['o2.m4a', 'n.m4a', 'o1.m4a']);
    assert.deepEqual(db.updates.filter((u) => u[1] === 'new'), [['reset', 'new'], ['set', 'new', 10, 20]]);
    scanner.stop();
  });

  it('a path outside the songs folder is never handed to ffmpeg', async () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.m4a`);
    fs.writeFileSync(outside, 'x');
    const rows = [row('in', 2, file('in.m4a')), row('out', 1, outside)];
    const db = fakeDb(rows);
    const seen: string[] = [];
    const songsFile = (f: string) => { if (!path.resolve(f).startsWith(tmp + path.sep)) throw new Error('outside the songs folder'); return path.resolve(f); };
    const scanner = createSilenceScanner({ db, songsPath: tmp, songsFile, startDelayMs: 0, pauseMs: 0, log: quiet, enabled: true, ffmpegCheck: async () => true, measure: async (f) => { seen.push(f); return { leadMs: 0, trailMs: 0 }; } });
    await scanner.start();
    await scanner.idle();
    scanner.stop();
    fs.rmSync(outside, { force: true });
    assert.deepEqual(seen.map((f) => path.basename(f)), ['in.m4a']);
    assert.equal(rows[1].lead_silence_ms, null);
  });

  it('numbers for a file the song no longer has are not stored', async () => {
    const rows = [row('s', 1, file('s1.m4a'))];
    const db = fakeDb(rows);
    const scanner = createSilenceScanner({
      db, songsPath: tmp, startDelayMs: 0, pauseMs: 0, log: quiet, enabled: true, ffmpegCheck: async () => true,
      measure: async () => { rows[0].file_path = file('s2.m4a'); return { leadMs: 1, trailMs: 1 }; }, // replaced meanwhile
    });
    await scanner.start();
    await scanner.idle();
    scanner.stop();
    assert.equal(rows[0].lead_silence_ms, null);
  });

  it('off without a database, without ffmpeg, without the songs folder, or switched off; hooks are then no-ops', async () => {
    const logs: string[] = [];
    const cases = [
      createSilenceScanner({ db: fakeDb([], { available: false }), songsPath: tmp, startDelayMs: 0, log: (m) => logs.push(m), enabled: true, ffmpegCheck: async () => true }),
      createSilenceScanner({ db: fakeDb([]), songsPath: tmp, startDelayMs: 0, log: (m) => logs.push(m), enabled: true, ffmpegCheck: async () => false }),
      createSilenceScanner({ db: fakeDb([]), songsPath: path.join(tmp, 'nope'), startDelayMs: 0, log: (m) => logs.push(m), enabled: true, ffmpegCheck: async () => true }),
      createSilenceScanner({ db: fakeDb([]), songsPath: tmp, startDelayMs: 0, log: (m) => logs.push(m), enabled: false, ffmpegCheck: async () => true }),
    ];
    for (const s of cases) {
      await s.start();
      s.songAdded({ id: 'x' });
      const st = await s.stats();
      assert.equal(st.enabled, false);
      assert.ok(st.reason);
      await s.idle();
      s.stop();
    }
    assert.ok(logs.some((l) => l.includes('ffmpeg not found')));
  });

  it('the waiting line is bounded', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`q${i}`, i, file(`q${i}.m4a`), 0));
    const db = fakeDb(rows);
    const seen: string[] = [];
    const scanner = createSilenceScanner({ db, songsPath: tmp, startDelayMs: 0, pauseMs: 0, maxQueued: 2, log: quiet, enabled: true, ffmpegCheck: async () => true, measure: async (f) => { seen.push(path.basename(f)); return { leadMs: 0, trailMs: 0 }; } });
    await scanner.start();
    await scanner.idle();
    for (const r of rows) scanner.songAdded({ id: r.id });
    await new Promise((r) => setTimeout(r, 20));
    await scanner.idle();
    scanner.stop();
    assert.equal(seen.length, 2, 'two queued, the rest left for the next pass');
  });
});
