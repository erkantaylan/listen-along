'use strict';

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
  return f;
}

/** Upload and translate the result into a batch result. */
async function uploadOne(api, file, fields, base) {
  const res = await api.upload(file, fields);
  if (res.status === 'duplicate') {
    return { ...base, status: 'skipped', reason: 'duplicate (server already has it)', song: res.song };
  }
  return { ...base, status: 'uploaded', song: res.song };
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
          targets.push({ ...base, id: e.id, url: e.url, title: e.title, playlist: c.listId, label: e.title ? `${e.title} [${e.id}]` : e.id });
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
        targets.push({ ...base, id: best.id, url: best.url, title: best.title, matched: { title: best.title, channel: best.channel } });
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
 * @param {object} opts - { dryRun, keep, keepDir, sleepSec, upload, skipLibraryCheck }
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

  // Resume: one library listing, then skip anything we already have.
  let have = new Set();
  if (api && !opts.skipLibraryCheck) {
    out.info('Checking library for songs already uploaded…');
    have = await api.libraryYoutubeIds();
  }

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
    if (t.id && have.has(t.id) && t.request_id === undefined) {
      batch.add({ ...base, status: 'skipped', reason: 'already in library' });
      continue;
    }
    const kept = findKept(keepDir, t.id);
    if (opts.dryRun) {
      batch.add({ ...base, status: 'would_download', reason: kept ? `local copy exists: ${kept}` : undefined, local_file: kept || undefined });
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
      } else {
        out.info(`Uploading ${base.label}…`);
        const r = await uploadOne(api, file, uploadFields(meta, { request_id: t.request_id }), base);
        if (meta.youtube_id) have.add(meta.youtube_id);
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
 * Upload local files (converting non-m4a to AAC m4a first).
 * @param {object} opts - { overrides, dryRun, requestId, bitrate }
 */
async function uploadFiles(ctx, files, opts, batch) {
  const { out, media } = ctx;
  const api = ctx.getApi();
  await media.check();
  let have = null; // lazily fetched library youtube_ids

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

      if (meta.youtube_id && opts.requestId === undefined) {
        if (!have && !opts.dryRun) have = await api.libraryYoutubeIds();
        if (have && have.has(meta.youtube_id)) {
          batch.add({ ...base, status: 'skipped', reason: 'already in library' });
          continue;
        }
      }
      const fields = uploadFields(meta, { request_id: opts.requestId });
      if (opts.dryRun) {
        batch.add({ ...base, status: 'would_upload', fields, reason: needsConvert ? `would convert ${meta.probe.codec} → aac m4a` : undefined });
        continue;
      }
      let uploadPath = file;
      if (needsConvert) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-up-'));
        uploadPath = path.join(tmpDir, `${safeName(path.parse(file).name)}.m4a`);
        out.info(`Converting ${path.basename(file)} (${meta.probe.codec}) → AAC m4a…`);
        await media.toM4a(file, uploadPath, { bitrate: opts.bitrate });
      }
      out.info(`Uploading ${meta.artist} - ${meta.title}…`);
      const r = await uploadOne(api, uploadPath, fields, base);
      if (have && meta.youtube_id) have.add(meta.youtube_id);
      batch.add(r);
    } catch (err) {
      batch.add(failure(base, err));
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

module.exports = { downloadAndUpload, uploadFiles, resolveTargets, readMeta, pickSourceUrl, uploadFields, safeName, findKept, isFatal };
