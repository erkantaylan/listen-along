'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { UsageError, CliError, EXIT } = require('../errors');
const { resolvePlaylist, UUID_RE } = require('../playlists');
const {
  Puller, pool, m3u8, portableName, formatBytes, writeAtomic, isFatal, isDiskFatal,
} = require('../pull');

const CONFIRM_OVER = 20;

function expandHome(p) {
  return p ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : p;
}

function songLabel(s) {
  if (!s) return '';
  return s.artist ? `${s.artist} - ${s.title}` : String(s.title || s.id);
}

/** Ask "Pull N songs? [y/N]" on the terminal; without one, --yes is required. */
async function confirm(ctx, question) {
  if (ctx.deps.confirm) return ctx.deps.confirm(question);
  const stdin = ctx.deps.stdin || process.stdin;
  if (ctx.out.json || !stdin.isTTY) return null;
  const rl = readline.createInterface({ input: stdin, output: ctx.out.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function requireConfirmation(ctx, values, count, what) {
  if (values.yes) return;
  const ok = await confirm(ctx, `Pull ${count} songs (${what})?`);
  if (ok === null) {
    throw new CliError(`${what} matches ${count} songs; add --yes to pull them all`, {
      exitCode: EXIT.USAGE, code: 'CONFIRM_REQUIRED', hint: 'Narrow the search, or pass --yes',
    });
  }
  if (!ok) throw new CliError('Cancelled', { exitCode: EXIT.FAILURE, code: 'CANCELLED' });
}

function notFound(input, err) {
  const code = err.status === 404 ? 'NOT_FOUND' : (err.code || 'ERROR');
  return { input, status: 'failed', error: err.status === 404 ? 'not in the library' : err.message, code };
}

module.exports = {
  name: 'pull',
  summary: 'Download songs from the server library to this computer',
  usage: [
    'la pull [options] <library-id|yt:ID>...',
    'la pull --search "<query>" [--yes]',
    'la pull --playlist <id-or-name> [--flat]',
    'la pull --all --yes',
  ],
  description: `Copies library songs (GET /api/library/:id/file) into --dir (config \`keep-dir\`,
default ~/Music/listen-along), named like \`la download --keep\` names them:
"<Artist> - <Title> [<youtube_id>].m4a" (the library id when the song has no
YouTube id), with characters that Windows, macOS or Linux refuse in file names
replaced. Any token works (no special permission).

Pick songs by library id or yt:<youtube_id>, --search (every match; asks first, or
needs --yes, when more than ${CONFIRM_OVER} match), --playlist (repeatable; files go to
<dir>/<playlist name>/ with "<playlist name>.m3u8" in playlist order; --flat puts
them straight into --dir) or --all (the whole library; needs --yes). Forms combine;
a song is fetched once per folder.

Safe to re-run: a file that is already there with the server's content (sha256
prefix = file_version; by size on servers without it) is skipped, also when it
has another title but the same "[<id>]" (e.g. a --keep copy). A song whose audio
was replaced on the server is downloaded again over the old copy. Downloads go
to "<name>.<file_version>.part" and are renamed only when complete and verified;
an interrupted download resumes from the .part (HTTP Range) on the next run.`,
  options: {
    dir: { type: 'string', value: 'DIR', desc: 'Destination folder (config `keep-dir`, default ~/Music/listen-along)' },
    search: { type: 'string', multiple: true, value: 'QUERY', desc: 'Pull every library song matching QUERY (title/artist/album words); repeatable' },
    playlist: { type: 'string', multiple: true, value: 'ID|NAME', desc: 'Pull a playlist into <dir>/<name>/ and write <name>.m3u8; repeatable' },
    flat: { type: 'boolean', desc: 'With --playlist: no subfolder, files and .m3u8 go straight into --dir' },
    all: { type: 'boolean', desc: 'Pull the whole library (needs --yes)' },
    yes: { type: 'boolean', short: 'y', desc: `Do not ask before pulling more than ${CONFIRM_OVER} songs from --search / --all` },
    concurrency: { type: 'string', value: 'N', desc: 'Parallel downloads (1-8)', default: 2 },
    'dry-run': { type: 'boolean', desc: 'Show what would be pulled; write nothing' },
  },
  output: `Human: one line per song ([pulled] / [skipped] / [FAILED]) on stderr, then a summary.
--json: { "dir", "summary": {total, pulled, skipped, failed, would_pull?},
          "results": [ {input, id, status: pulled|skipped|failed|would_pull, title, artist,
                        youtube_id, file, bytes, resumed?, updated?, reason?, error?, code?,
                        playlist?} ],
          "playlists"?: [ {id, name, dir, m3u8, songs, listed, missing} ], "aborted"? }
Skip reasons: "already downloaded", "not in library" (a playlist entry that is
only a YouTube link). Exit: 0 nothing failed, 1 a song failed (or a playlist
was not found), 2 usage / more than ${CONFIRM_OVER} matches without --yes,
3 not configured, 4 token rejected, 5 server error/unreachable.`,
  examples: [
    'la pull 0b6f3b7e-6b0e-4a59-9a43-6bd1ef3c1f00 yt:dQw4w9WgXcQ',
    'la pull --search "daft punk"',
    'la pull --playlist "Road trip" --dir ~/Music/la',
    'la pull --all --yes --concurrency 4 --json',
    'la pull --playlist "Road trip" --dry-run',
  ],
  async run(ctx, values, positionals) {
    const searches = (values.search || []).map((q) => String(q).trim());
    const playlistRefs = (values.playlist || []).map((p) => String(p).trim());
    if (searches.some((q) => !q)) throw new UsageError('--search needs a query');
    if (playlistRefs.some((p) => !p)) throw new UsageError('--playlist needs a playlist id or name');
    if (!positionals.length && !searches.length && !playlistRefs.length && !values.all) {
      throw new UsageError('Nothing to pull', 'Give library ids, --search, --playlist or --all (see `la pull --help`)');
    }
    for (const p of positionals) {
      if (!UUID_RE.test(p) && !/^yt:[A-Za-z0-9_-]{11}$/.test(p)) {
        throw new UsageError(`Not a library id or yt:<youtube_id>: ${p}`, 'Find ids with `la library <search>`, or use --search');
      }
    }
    if (values.flat && !playlistRefs.length) throw new UsageError('--flat only applies with --playlist');
    const concurrency = values.concurrency === undefined ? 2 : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new UsageError(`--concurrency must be an integer 1-8, got: ${values.concurrency}`);
    }
    if (values.all && !values.yes) {
      throw new CliError('--all pulls the whole library; add --yes to confirm', { exitCode: EXIT.USAGE, code: 'CONFIRM_REQUIRED' });
    }
    const dir = path.resolve(expandHome(values.dir || ctx.cfg.values['keep-dir']));
    const dryRun = !!values['dry-run'];
    const api = ctx.getApi();
    const out = ctx.out;

    // --- Collect the songs ------------------------------------------------
    const jobs = []; // { input, song, dir, playlist? }
    const results = []; // ordered; jobs fill their slot
    const seen = new Map(); // `${dir}\0${id}` -> job
    const addJob = (input, song, jobDir, playlistName) => {
      const key = `${jobDir}\0${song.id}`;
      if (seen.has(key)) return seen.get(key);
      const job = { input, song, dir: jobDir, slot: results.length };
      if (playlistName) job.playlist = playlistName;
      results.push(null);
      seen.set(key, job);
      jobs.push(job);
      return job;
    };

    // Library ids / yt:IDs: look each up (in parallel).
    const looked = new Array(positionals.length);
    await pool(positionals, concurrency, async (input, i) => {
      try {
        const song = input.startsWith('yt:') ? await api.songByYoutubeId(input.slice(3)) : await api.song(input);
        looked[i] = song ? { song } : { fail: { input, status: 'failed', error: 'not in the library', code: 'NOT_FOUND' } };
      } catch (err) {
        if (isFatal(err)) throw err;
        looked[i] = { fail: notFound(input, err) };
      }
    });
    looked.forEach((l, i) => {
      if (l.song) addJob(positionals[i], l.song, dir);
      else results.push(l.fail);
    });

    for (const q of searches) {
      out.info(`Searching the library for "${q}"...`);
      const songs = await api.libraryAll({ q });
      if (!songs.length) out.warn(`no library song matches "${q}"`);
      if (songs.length > CONFIRM_OVER) await requireConfirmation(ctx, values, songs.length, `--search "${q}"`);
      for (const s of songs) addJob(`search:${q}`, s, dir);
    }

    if (values.all) {
      out.info('Listing the whole library...');
      const songs = await api.libraryAll();
      for (const s of songs) addJob('all', s, dir);
    }

    const playlistDocs = [];
    for (const ref of playlistRefs) {
      const p = await resolvePlaylist(api, ref);
      const { songs: entries = [] } = await api.playlistSongs(p.id);
      const plDir = values.flat ? dir : path.join(dir, portableName(p.name || p.id));
      const ids = [...new Set(entries.map((e) => e.library_id).filter(Boolean))];
      const songs = new Map();
      await pool(ids, concurrency, async (id) => {
        try { songs.set(id, await api.song(id)); } catch (err) { if (isFatal(err)) throw err; }
      });
      const doc = { id: p.id, name: p.name, dir: plDir, m3u8: null, songs: entries.length, listed: 0, missing: 0, entries: [] };
      for (const e of entries) {
        const input = `playlist:${p.name || p.id}#${e.position}`;
        const song = e.library_id && songs.get(e.library_id);
        if (song) {
          doc.entries.push({ job: addJob(input, song, plDir, p.name) });
        } else {
          const label = [e.artist, e.title].filter(Boolean).join(' - ') || e.url || e.entry_id;
          results.push({ input, status: 'skipped', reason: 'not in library', title: e.title, youtube_id: e.youtube_id || null, playlist: p.name });
          doc.entries.push({ missing: `${label} (not in library)` });
        }
      }
      playlistDocs.push(doc);
      out.info(`Playlist "${p.name}": ${entries.length} song(s)`);
    }

    // --- Pull ---------------------------------------------------------------
    const puller = new Puller({ api, out, dryRun });
    let done = 0;
    if (jobs.length) {
      out.info(`${dryRun ? 'Would pull' : 'Pulling'} ${jobs.length} song(s) to ${dir}${jobs.length > 1 && !dryRun ? ` (${concurrency} at a time)` : ''}`);
    }
    const report = (job, r) => {
      done++;
      const s = job.song;
      results[job.slot] = {
        input: job.input, id: s.id, status: r.status, title: s.title, artist: s.artist, youtube_id: s.youtube_id || null,
        ...r, ...(job.playlist ? { playlist: job.playlist } : {}),
      };
      const icon = { pulled: 'pulled', skipped: 'skipped', failed: 'FAILED', would_pull: 'would pull' }[r.status];
      let line = `[${icon}] (${done}/${jobs.length}) ${songLabel(s)}`;
      if (r.status === 'failed') line += ` — ${r.error}`;
      else {
        const bits = [r.reason, r.bytes >= 0 ? formatBytes(r.bytes) : null, r.resumed ? 'resumed' : null, r.updated ? 'replaced on server, updated' : null].filter(Boolean);
        if (bits.length) line += ` (${bits.join(', ')})`;
        if (r.status === 'pulled' && out.verbose) line += ` -> ${r.file}`;
      }
      out.info(line);
    };

    let aborted = null;
    try {
      await pool(jobs, concurrency, async (job) => {
        try {
          report(job, await puller.pullOne(job.song, job.dir));
        } catch (err) {
          if (isFatal(err) || isDiskFatal(err)) {
            report(job, { status: 'failed', error: err.message, code: err.code || 'ERROR' });
            throw err;
          }
          report(job, { status: 'failed', error: err.message, code: err.status === 404 ? 'NOT_FOUND' : (err.code || 'ERROR') });
        }
      });
    } catch (err) {
      if (!results.some(Boolean)) throw err;
      out.error(err);
      aborted = { code: err.code || 'ERROR', message: err.message, exitCode: err.exitCode || EXIT.FAILURE };
    }

    // --- Playlist files -----------------------------------------------------
    for (const doc of playlistDocs) {
      const lines = [];
      for (const e of doc.entries) {
        if (e.missing) { lines.push({ missing: e.missing }); doc.missing++; continue; }
        const r = results[e.job.slot];
        if (r && (r.status === 'pulled' || r.status === 'skipped') && r.file) {
          lines.push({ file: r.file, title: r.title, artist: r.artist, duration_sec: e.job.song.duration_sec });
          doc.listed++;
        } else {
          lines.push({ missing: `${songLabel(e.job.song)} (${r ? r.status : 'not pulled'})` });
          doc.missing++;
        }
      }
      const file = path.join(doc.dir, `${portableName(doc.name || doc.id)}.m3u8`);
      if (!dryRun && !aborted) {
        try {
          fs.mkdirSync(doc.dir, { recursive: true });
          writeAtomic(file, m3u8(lines, doc.dir));
          doc.m3u8 = file;
          out.info(`Wrote ${file} (${doc.listed} of ${doc.songs} songs)`);
        } catch (err) {
          out.warn(`could not write ${file}: ${err.message}`);
          doc.m3u8_error = err.message;
        }
      }
      delete doc.entries;
    }

    // --- Report -------------------------------------------------------------
    const final = results.filter(Boolean);
    const summary = { total: final.length, pulled: 0, skipped: 0, failed: 0 };
    for (const r of final) summary[r.status] = (summary[r.status] || 0) + 1;
    const docOut = { dir, summary, results: final };
    if (playlistDocs.length) docOut.playlists = playlistDocs;
    if (aborted) docOut.aborted = { code: aborted.code, message: aborted.message };
    out.result(docOut, () => {
      const parts = Object.entries(summary).filter(([k, v]) => k !== 'total' && v).map(([k, v]) => `${v} ${k.replace('_', ' ')}`);
      out.print(`\nSummary: ${summary.total} song(s)${parts.length ? `: ${parts.join(', ')}` : ''} -> ${dir}`);
      const failed = final.filter((r) => r.status === 'failed');
      if (failed.length) {
        out.print('Failed:');
        for (const r of failed) out.print(`  - ${r.title ? songLabel(r) : r.input}: ${r.error}${r.code ? ` [${r.code}]` : ''}`);
      }
      if (aborted) out.print(`Aborted: ${aborted.message}`);
    });
    if (aborted) return aborted.exitCode;
    return final.some((r) => r.status === 'failed') || playlistDocs.some((d) => d.m3u8_error) ? EXIT.FAILURE : EXIT.OK;
  },
};
