'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, pickBest, findVideoId, watchUrl, isHttpUrl } = require('./youtube');
const { Media } = require('./media');
const { ApiError } = require('./api');
const { EXIT } = require('./errors');

/** Errors that must abort the whole batch instead of failing one item. */
function isFatal(err) {
  return err instanceof ApiError && (err.exitCode === EXIT.AUTH || err.code === 'UNREACHABLE')
    || err.exitCode === EXIT.DEPENDENCY;
}

function failure(base, err) {
  if (isFatal(err)) throw err;
  const r = { ...base, status: 'failed', error: err.message, code: err.code || 'ERROR' };
  if (err.detail && !err.message.includes(err.detail)) r.detail = err.detail;
  return r;
}

/** Make a string safe as a file name component. */
function safeName(s) {
  return String(s).replace(/[\/\\\0]/g, '-').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'untitled';
}

/** Find a previously kept copy "<anything> [<id>].m4a" in keepDir. */
function findKept(keepDir, id) {
  if (!keepDir || !id) return null;
  let names;
  try { names = fs.readdirSync(keepDir); } catch { return null; }
  const hit = names.find((n) => n.endsWith(`[${id}].m4a`));
  return hit ? path.join(keepDir, hit) : null;
}

/**
 * Pick the song's original source link.
 * Order: explicit override, caller fallback (e.g. yt-dlp's webpage_url), a
 * URL tag (yt-dlp's --embed-metadata writes the watch URL into comment, and
 * purl where the container supports it), else the watch URL of youtube_id.
 * A tag URL pointing at a different YouTube video than youtube_id is ignored.
 */
function pickSourceUrl({ override, fallback, tags = {}, youtubeId }) {
  if (isHttpUrl(override)) return override.trim();
  if (isHttpUrl(fallback)) return fallback.trim();
  for (const tag of [tags.purl, tags.comment]) {
    if (!isHttpUrl(tag)) continue;
    const url = tag.trim();
    const tagId = findVideoId(url);
    if (youtubeId && tagId && tagId !== youtubeId) continue;
    if (youtubeId && !tagId) continue; // a non-YouTube URL can't be this video's source
    return url;
  }
  return youtubeId ? watchUrl(youtubeId) : null;
}

/**
 * Read upload metadata from a file's tags, with overrides and fallbacks.
 * @returns {{ title, artist, album, duration_sec, youtube_id, source_url, probe }}
 */
async function readMeta(media, file, { overrides = {}, fallback = {} } = {}) {
  const probe = await media.probe(file);
  const t = probe.tags;
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const meta = {
    title: pick(overrides.title, t.title, fallback.title),
    artist: pick(overrides.artist, t.artist, t.album_artist, t.albumartist, t.composer, fallback.artist),
    album: pick(overrides.album, t.album, fallback.album),
    duration_sec: probe.duration ? Math.round(probe.duration) : pick(fallback.duration_sec),
    youtube_id: pick(overrides.youtube_id, findVideoId(overrides.source_url), fallback.youtube_id,
      findVideoId(t.comment), findVideoId(t.purl), findVideoId(t.description), findVideoId(path.basename(file))),
  };
  meta.source_url = pickSourceUrl({
    override: overrides.source_url, fallback: fallback.source_url, tags: t, youtubeId: meta.youtube_id,
  });
  return { ...meta, probe };
}

/** Fields for POST /api/library/upload. */
function uploadFields(meta, extra = {}) {
  const f = { title: meta.title, artist: meta.artist };
  if (meta.album) f.album = meta.album;
  if (meta.youtube_id) f.youtube_id = meta.youtube_id;
  if (meta.source_url) f.source_url = meta.source_url;
  if (meta.duration_sec) f.duration_sec = meta.duration_sec;
  if (extra.request_id !== undefined && extra.request_id !== null) f.request_id = extra.request_id;
  if (extra.allow_similar) f.allow_similar = '1';
  return f;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Skip reasons for a song the server already has. `already in library` (by
 * youtube_id) predates the others and is kept as is for scripts.
 */
const DUPLICATE_REASON = {
  already_in_library: 'already in library',
  duplicate_hash: 'duplicate_hash',
  duplicate_metadata: 'duplicate_metadata',
};

/** The matched existing song, as reported on a skipped result. */
function duplicateOf(song, code) {
  if (!song || song.id === undefined || song.id === null) return undefined;
  const d = { id: song.id, title: song.title ?? null, artist: song.artist ?? null };
  if (song.youtube_id) d.youtube_id = song.youtube_id;
  if (code) d.match = code;
  return d;
}

function duplicateSkip(base, code, song) {
  const r = { ...base, status: 'skipped', reason: DUPLICATE_REASON[code] || 'duplicate (server already has it)' };
  if (song) r.song = song;
  const of = duplicateOf(song, code);
  if (of) r.duplicate_of = of;
  return r;
}

/**
 * Ask the server (POST /api/library/check) whether this is already in the
 * library. Exact matches (youtube_id, file hash) always count; a probable
 * (metadata) match counts unless allowSimilar. null = go ahead (also when
 * the server is too old to answer).
 * @returns {Promise<{reason: string, song: object}|null>}
 */
async function preCheck(api, query, { allowSimilar = false } = {}) {
  if (!api || typeof api.check !== 'function') return null;
  const res = await api.check(query);
  if (!res || !res.duplicate) return null;
  const matches = res.matches || [];
  return matches.find((m) => m.exact) || (!allowSimilar && matches.find((m) => !m.exact)) || null;
}

/**
 * Guess artist/title before downloading from a YouTube result: "Artist -
 * Title" video titles, else the channel (minus " - Topic") as the artist.
 */
function guessArtistTitle(title, channel) {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(String(title || '').trim());
  if (m) return { artist: m[1], title: m[2] };
  return { artist: String(channel || '').replace(/\s*-\s*topic$/i, ''), title: String(title || '') };
}

/** Upload and translate the result into a batch result. */
async function uploadOne(api, file, fields, base) {
  const res = await api.upload(file, fields);
  if (res.status === 'duplicate') return duplicateSkip(base, res.code, res.song);
  return { ...base, status: 'uploaded', song: res.song };
}

/** Replace library song `songId` with `file`; a replaced result. */
async function replaceOne(api, songId, file, fields, base) {
  const res = await api.replace(songId, file, fields);
  return { ...base, status: 'replaced', replaced_id: songId, song: res.song, previous: res.previous };
}

/**
 * Resolve `la download` inputs (URLs, playlists, search queries) into concrete
 * download targets. Resolution failures are reported through `onFail`.
 * @param {object[]} inputs - [{ input, request_id?, noPlaylist? }]
 * @returns {Promise<object[]>} targets: { input, id?, url, title?, request_id?, matched? }
 */
async function resolveTargets(ctx, inputs, onFail) {
  const { ytdlp, out } = ctx;
  const targets = [];
  for (const item of inputs) {
    const c = classify(item.input, { noPlaylist: item.noPlaylist });
    const base = { input: item.input, label: item.label || item.input };
    if (item.request_id !== undefined) base.request_id = item.request_id;
    try {
      if (c.kind === 'video') {
        targets.push({ ...base, id: c.id, url: c.url });
      } else if (c.kind === 'url') {
        targets.push({ ...base, url: c.url });
      } else if (c.kind === 'playlist') {
        out.info(`Listing playlist ${c.listId}…`);
        const entries = await ytdlp.playlist(c.url);
        out.info(`  ${entries.length} video(s)`);
        if (!entries.length) onFail(failure(base, new Error('Playlist is empty or unavailable')));
        for (const e of entries) {
          targets.push({ ...base, id: e.id, url: e.url, title: e.title, playlist: c.listId, label: e.title ? `${e.title} [${e.id}]` : e.id, hint: { title: e.title, channel: e.channel, duration: e.duration } });
        }
      } else {
        out.info(`Searching YouTube: ${c.query}`);
        const results = await ytdlp.search(c.query, 5);
        const best = pickBest(results, c.query);
        if (!best) {
          onFail(failure(base, Object.assign(new Error('No search results'), { code: 'NOT_FOUND' })));
          continue;
        }
        out.info(`  → ${best.title} (${best.channel || 'unknown channel'}) [${best.id}]`);
        targets.push({ ...base, id: best.id, url: best.url, title: best.title, matched: { title: best.title, channel: best.channel }, hint: { title: best.title, channel: best.channel, duration: best.duration } });
      }
    } catch (err) {
      onFail(failure(base, err));
    }
  }
  return targets;
}

/**
 * Download → tag → upload each target, with resume (library youtube_ids and
 * kept local copies), throttling, dry-run and keep handling.
 *
 * @param {object} ctx - { out, ytdlp, media, getApi, sleep }
 * @param {object[]} inputs - [{ input, request_id?, label?, noPlaylist? }]
 * Duplicates: besides the youtube_id listing, the server is asked (POST
 * /api/library/check) before a download when a search / playlist result
 * gives artist, title and duration, and after it (file hash + tags) before
 * the upload. A probable (metadata) match is skipped unless allowSimilar.
 * With opts.replace (a library song id) the single target replaces that
 * song instead (no duplicate checks; the server refuses another song's file).
 *
 * @param {object} opts - { dryRun, keep, keepDir, sleepSec, upload, skipLibraryCheck, allowSimilar, replace }
 * @param {import('./batch').Batch} batch
 */
async function downloadAndUpload(ctx, inputs, opts, batch) {
  const { out, ytdlp, media } = ctx;
  const upload = opts.upload !== false;
  const api = upload ? ctx.getApi() : null;

  if (!opts.dryRun) {
    await ytdlp.version();
    await media.check();
  }

  const replacing = opts.replace !== undefined && opts.replace !== null;
  // Resume: one library listing, then skip anything we already have.
  let have = new Map();
  if (api && !opts.skipLibraryCheck && !replacing) {
    out.info('Checking library for songs already uploaded…');
    have = await api.libraryIndex();
  }
  const checks = api && !replacing;

  const targets = await resolveTargets(ctx, inputs, (r) => batch.add(r));
  const seen = new Set();
  let downloadsDone = 0;
  const keepDir = opts.keep || !upload ? opts.keepDir : null;

  for (const t of targets) {
    const base = { input: t.input, label: t.label, youtube_id: t.id, url: t.url };
    if (t.request_id !== undefined) base.request_id = t.request_id;
    if (t.matched) base.matched = t.matched;

    if (t.id && seen.has(t.id) && t.request_id === undefined) {
      batch.add({ ...base, status: 'skipped', reason: 'duplicate in this batch' });
      continue;
    }
    if (t.id) seen.add(t.id);
    if (t.id && have.has(t.id) && t.request_id === undefined && !replacing) {
      const r = { ...base, status: 'skipped', reason: 'already in library' };
      const of = duplicateOf(have.get(t.id), 'already_in_library');
      if (of) r.duplicate_of = of;
      batch.add(r);
      continue;
    }
    // Before downloading: a search / playlist result that looks like a song
    // already in the library (normalized artist + title, duration ±3s).
    if (checks && t.request_id === undefined && t.hint && t.hint.title && Number(t.hint.duration) > 0) {
      const guess = guessArtistTitle(t.hint.title, t.hint.channel);
      const m = await preCheck(api, { youtube_id: t.id, title: guess.title, artist: guess.artist, duration_sec: Number(t.hint.duration) }, opts);
      if (m) {
        batch.add(duplicateSkip(base, m.reason, m.song));
        continue;
      }
    }
    const kept = findKept(keepDir, t.id);
    if (opts.dryRun) {
      const status = replacing ? 'would_replace' : 'would_download';
      batch.add({ ...base, status, reason: kept ? `local copy exists: ${kept}` : undefined, local_file: kept || undefined, ...(replacing ? { replaced_id: opts.replace } : {}) });
      continue;
    }

    let tmpDir = null;
    try {
      let file = kept;
      let info = {};
      if (!file) {
        if (downloadsDone > 0 && opts.sleepSec > 0) {
          out.debug(`Sleeping ${opts.sleepSec}s…`);
          await ctx.sleep(opts.sleepSec * 1000);
        }
        downloadsDone++;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-dl-'));
        out.info(`Downloading ${t.label}…`);
        const dl = await ytdlp.download(t.url, { outDir: tmpDir });
        file = dl.file;
        info = dl.info || {};
        if (dl.thumbnail) {
          try { await media.embedCover(file, dl.thumbnail); } catch (err) { out.warn(`${t.label}: cover not embedded (${err.message})`); }
        }
      } else {
        out.info(`Using local copy ${kept}`);
      }

      const meta = await readMeta(media, file, {
        fallback: {
          title: info.track || info.title,
          artist: info.artist || info.uploader || info.channel,
          album: info.album,
          duration_sec: info.duration,
          youtube_id: info.id || t.id,
          source_url: info.webpage_url || (info.id || t.id ? watchUrl(info.id || t.id) : t.url),
        },
      });
      if (!Media.isAacM4a(meta.probe, file)) {
        throw Object.assign(new Error(`Downloaded file is not AAC m4a (${meta.probe.codec} in ${meta.probe.format})`), { code: 'NOT_M4A' });
      }
      if (!meta.title || !meta.artist) {
        throw Object.assign(new Error('Could not determine title/artist from the video'), { code: 'MISSING_TAGS' });
      }
      base.youtube_id = meta.youtube_id || base.youtube_id;
      if (meta.source_url) base.source_url = meta.source_url;
      base.title = meta.title;
      base.artist = meta.artist;
      base.label = `${meta.artist} - ${meta.title}`;

      // Keep before upload so a failed upload doesn't lose the download.
      if (keepDir && file !== kept) {
        fs.mkdirSync(keepDir, { recursive: true });
        const dest = path.join(keepDir, safeName(`${meta.artist} - ${meta.title}`) + (meta.youtube_id ? ` [${meta.youtube_id}]` : '') + '.m4a');
        fs.copyFileSync(file, dest);
        file = dest;
        base.local_file = dest;
      } else if (kept) {
        base.local_file = kept;
      }

      if (!upload) {
        batch.add({ ...base, status: 'downloaded' });
      } else if (replacing) {
        out.info(`Replacing library song ${opts.replace} with ${base.label}…`);
        batch.add(await replaceOne(api, opts.replace, file, uploadFields(meta), base));
      } else {
        // After downloading: same file bytes, or tags that match a song already there.
        const m = t.request_id === undefined
          ? await preCheck(api, { youtube_id: meta.youtube_id, sha256: await sha256File(file), title: meta.title, artist: meta.artist, duration_sec: meta.duration_sec }, opts)
          : null;
        if (m) {
          batch.add(duplicateSkip(base, m.reason, m.song));
          continue;
        }
        out.info(`Uploading ${base.label}…`);
        const r = await uploadOne(api, file, uploadFields(meta, { request_id: t.request_id, allow_similar: opts.allowSimilar }), base);
        if (meta.youtube_id && r.song) have.set(meta.youtube_id, r.song);
        batch.add(r);
      }
    } catch (err) {
      batch.add(failure(base, err));
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Upload local files (converting non-m4a to AAC m4a first). Before each
 * upload the server is asked for duplicates (youtube_id, hash of the bytes
 * that would be uploaded, normalized artist + title ±3s); a probable
 * (metadata) match is skipped unless opts.allowSimilar. With opts.replace
 * (a library song id) the single file replaces that song instead.
 * @param {object} opts - { overrides, dryRun, requestId, bitrate, allowSimilar, replace }
 */
async function uploadFiles(ctx, files, opts, batch) {
  const { out, media } = ctx;
  const api = ctx.getApi();
  await media.check();
  let have = null; // lazily fetched library youtube_id -> song
  const replacing = opts.replace !== undefined && opts.replace !== null;

  for (const file of files) {
    const base = { file, label: file };
    let tmpDir = null;
    try {
      const meta = await readMeta(media, file, { overrides: opts.overrides });
      if (meta.youtube_id) base.youtube_id = meta.youtube_id;
      if (meta.source_url) base.source_url = meta.source_url;
      const missing = ['title', 'artist'].filter((k) => !meta[k]);
      if (missing.length) {
        throw Object.assign(new Error(`Missing ${missing.join(' and ')} tag; pass ${missing.map((k) => `--${k}`).join('/')} or tag the file`), { code: 'MISSING_TAGS' });
      }
      base.title = meta.title;
      base.artist = meta.artist;
      const needsConvert = !Media.isAacM4a(meta.probe, file);
      base.converted = needsConvert;

      // Also on --dry-run, so the preview matches what a real run would skip.
      const checks = !replacing && opts.requestId === undefined;
      if (checks && meta.youtube_id) {
        if (!have) have = await api.libraryIndex();
        if (have.has(meta.youtube_id)) {
          const r = { ...base, status: 'skipped', reason: 'already in library' };
          const of = duplicateOf(have.get(meta.youtube_id), 'already_in_library');
          if (of) r.duplicate_of = of;
          batch.add(r);
          continue;
        }
      }
      const query = { youtube_id: meta.youtube_id, title: meta.title, artist: meta.artist, duration_sec: meta.duration_sec };
      if (checks && !needsConvert) {
        const m = await preCheck(api, { ...query, sha256: await sha256File(file) }, opts);
        if (m) { batch.add(duplicateSkip(base, m.reason, m.song)); continue; }
      } else if (checks && opts.dryRun) {
        const m = await preCheck(api, query, opts);
        if (m) { batch.add(duplicateSkip(base, m.reason, m.song)); continue; }
      }
      const fields = uploadFields(meta, { request_id: opts.requestId, allow_similar: !replacing && opts.allowSimilar });
      if (opts.dryRun) {
        const r = { ...base, status: replacing ? 'would_replace' : 'would_upload', fields, reason: needsConvert ? `would convert ${meta.probe.codec} → aac m4a` : undefined };
        if (replacing) r.replaced_id = opts.replace;
        batch.add(r);
        continue;
      }
      let uploadPath = file;
      if (needsConvert) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-up-'));
        uploadPath = path.join(tmpDir, `${safeName(path.parse(file).name)}.m4a`);
        out.info(`Converting ${path.basename(file)} (${meta.probe.codec}) → AAC m4a…`);
        await media.toM4a(file, uploadPath, { bitrate: opts.bitrate });
      }
      if (replacing) {
        out.info(`Replacing library song ${opts.replace} with ${meta.artist} - ${meta.title}…`);
        batch.add(await replaceOne(api, opts.replace, uploadPath, fields, base));
        continue;
      }
      if (checks && needsConvert) {
        // Hash of the converted file, i.e. the bytes that would be uploaded.
        const m = await preCheck(api, { ...query, sha256: await sha256File(uploadPath) }, opts);
        if (m) { batch.add(duplicateSkip(base, m.reason, m.song)); continue; }
      }
      out.info(`Uploading ${meta.artist} - ${meta.title}…`);
      const r = await uploadOne(api, uploadPath, fields, base);
      if (have && meta.youtube_id && r.song) have.set(meta.youtube_id, r.song);
      batch.add(r);
    } catch (err) {
      batch.add(failure(base, err));
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  downloadAndUpload, uploadFiles, resolveTargets, readMeta, pickSourceUrl, uploadFields, safeName, findKept, isFatal,
  guessArtistTitle, duplicateSkip, preCheck, sha256File,
};
