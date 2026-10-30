'use strict';

// `la pull`: copy songs from the server library to this computer.
//
// Files are named like `la download --keep` names them:
//   "<Artist> - <Title> [<youtube_id>].<ext>"  (the library id when the song
//   has no youtube_id), with the name made safe on Windows, macOS and Linux.
// A download goes to "<name>.<file_version>.part" first and is renamed when
// complete and verified, so an interrupted run leaves a .part that the next
// run resumes with an HTTP Range request.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { CliError, EXIT } = require('./errors');
const { isFatal } = require('./pipeline');

/** Audio extensions a library file can have, by the server's Content-Type. */
const EXT_BY_TYPE = {
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
};
const KNOWN_EXTS = ['.m4a', '.mp3', '.webm', '.ogg', '.opus', '.flac'];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
function truncateBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * Make `s` a file/folder name valid on Windows, macOS and Linux: no
 * < > : " / \ | ? * or control characters, no trailing dots/spaces, no
 * leading dot (hidden file), not a reserved Windows device name (CON, NUL,
 * COM1...), at most `maxBytes` UTF-8 bytes (file systems allow 255), NFC.
 */
function portableName(s, maxBytes = 180) {
  let t = String(s ?? '').normalize('NFC')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\/\\|]/g, '-')
    .replace(/"/g, "'")
    .replace(/[<>?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = truncateBytes(t, maxBytes).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!t) t = 'untitled';
  if (WINDOWS_RESERVED.test(t)) t = `_${t}`;
  return t;
}

/** The song's identity in its file name: the youtube_id, else the library id. */
function songKey(song) {
  return song.youtube_id || song.id;
}

/** File name without extension: "<Artist> - <Title> [<key>]". */
function songBaseName(song) {
  const artist = song.artist && String(song.artist).trim();
  const title = song.title && String(song.title).trim() ? song.title : 'untitled';
  return `${portableName(artist ? `${artist} - ${title}` : title)} [${portableName(songKey(song), 64)}]`;
}

function extForType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[type] || '.m4a';
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Does the local file hold this exact library version (file_version = sha256 prefix)? */
async function matchesVersion(file, fileVersion) {
  if (!fileVersion) return null;
  return (await sha256File(file)).startsWith(String(fileVersion).toLowerCase());
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

function formatBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Write a file via a temp file + rename (never a half-written file). */
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Run `fn(item, index)` over items with at most `limit` running at once.
 * After a fatal error no new items start; the error is rethrown once the
 * running ones have finished.
 */
async function pool(items, limit, fn) {
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (!fatal && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (err) {
        fatal = fatal || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (fatal) throw fatal;
}

/** Disk full / read-only etc.: every following item would fail the same way. */
function isDiskFatal(err) {
  return ['ENOSPC', 'EROFS', 'EDQUOT'].includes(err && err.code);
}

class Puller {
  /**
   * @param {object} opts
   * @param {object} opts.api - ApiClient
   * @param {object} opts.out - Output
   * @param {boolean} [opts.dryRun]
   */
  constructor({ api, out, dryRun = false }) {
    this.api = api;
    this.out = out;
    this.dryRun = dryRun;
    this.dirListings = new Map();
  }

  listDir(dir) {
    if (!this.dirListings.has(dir)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* missing dir */ }
      this.dirListings.set(dir, names);
    }
    return this.dirListings.get(dir);
  }

  /**
   * Local files that may already be this song: "<base><ext>" for any audio
   * extension first, then any "... [<key>]<ext>" in the same folder (e.g. a
   * `la download --keep` copy, or a song whose title changed since).
   */
  candidates(dir, song, base) {
    const names = this.listDir(dir);
    const exact = KNOWN_EXTS.map((ext) => base + ext).filter((n) => names.includes(n));
    const suffix = ` [${portableName(songKey(song), 64)}]`;
    const loose = names.filter((n) => !exact.includes(n)
      && KNOWN_EXTS.some((ext) => n.endsWith(suffix + ext)));
    return { exact: exact.map((n) => path.join(dir, n)), loose: loose.map((n) => path.join(dir, n)) };
  }

  /** Size of the server's file (HEAD), for servers without file_version. */
  async remoteSize(song) {
    const res = await this.api.openSongFile(song.id, { method: 'HEAD' });
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) ? n : -1;
  }

  /**
   * Is this local file already the server's version? By hash (file_version)
   * when the server gives one, else by size.
   */
  async isCurrent(file, song) {
    if (song.file_version) return matchesVersion(file, song.file_version);
    const remote = await this.remoteSize(song);
    return remote >= 0 && remote === sizeOf(file);
  }

  /**
   * Make sure `song` is in `dir`. Returns the result fields:
   * { status: pulled|skipped|would_pull, file, bytes, resumed?, updated?, reason? }
   */
  async pullOne(song, dir) {
    const base = songBaseName(song);
    const { exact, loose } = this.candidates(dir, song, base);
    let outdated = null;
    for (const file of exact) {
      if (await this.isCurrent(file, song)) return { status: 'skipped', reason: 'already downloaded', file, bytes: sizeOf(file) };
      outdated = outdated || file;
    }
    for (const file of loose) {
      if (await this.isCurrent(file, song)) return { status: 'skipped', reason: 'already downloaded', file, bytes: sizeOf(file) };
    }
    if (this.dryRun) {
      return { status: 'would_pull', file: outdated || path.join(dir, `${base}.m4a`), ...(outdated ? { updated: true } : {}) };
    }

    fs.mkdirSync(dir, { recursive: true });
    const version = song.file_version ? String(song.file_version).toLowerCase() : 'nover';
    const part = path.join(dir, `${base}.${version}.part`);
    // A .part of an older version of the song (replaced on the server since) is useless.
    for (const n of this.listDir(dir)) {
      if (n.startsWith(`${base}.`) && n.endsWith('.part') && n !== path.basename(part)) {
        try { fs.unlinkSync(path.join(dir, n)); } catch { /* ignore */ }
      }
    }

    let attempt = await this.fetchTo(song, part, sizeOf(part));
    if (song.file_version && !(await matchesVersion(part, song.file_version))) {
      fs.rmSync(part, { force: true });
      if (attempt.resumed) {
        this.out.debug(`  ${base}: resumed file does not match the server's hash, downloading again`);
        attempt = await this.fetchTo(song, part, 0);
        if (!(await matchesVersion(part, song.file_version))) {
          fs.rmSync(part, { force: true });
          throw new CliError('downloaded file does not match the server\'s file_version (sha256)', { code: 'HASH_MISMATCH' });
        }
      } else {
        throw new CliError('downloaded file does not match the server\'s file_version (sha256)', { code: 'HASH_MISMATCH' });
      }
    }
    const final = path.join(dir, base + attempt.ext);
    fs.renameSync(part, final);
    if (outdated && outdated !== final) fs.rmSync(outdated, { force: true });
    const listing = this.listDir(dir);
    if (!listing.includes(path.basename(final))) listing.push(path.basename(final));
    const r = { status: 'pulled', file: final, bytes: sizeOf(final), resumed: attempt.resumed };
    if (outdated) r.updated = true;
    return r;
  }

  /**
   * Download the song's file into `part`, resuming from `from` bytes when
   * the server honours the Range request (206). Returns { ext, resumed }.
   */
  async fetchTo(song, part, from) {
    let start = from > 0 ? from : 0;
    let res = await this.api.openSongFile(song.id, { from: start });
    if (res.status === 416) {
      // The .part is already as long as (or longer than) the file: start over.
      await res.body?.cancel().catch(() => {});
      start = 0;
      res = await this.api.openSongFile(song.id);
    }
    let resumed = false;
    if (start > 0 && res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
      if (m && Number(m[1]) === start) resumed = true;
      else {
        await res.body?.cancel().catch(() => {});
        start = 0;
        res = await this.api.openSongFile(song.id);
      }
    } else {
      start = 0; // a 200 answer to a Range request: the whole file follows
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new CliError(`unexpected HTTP ${res.status} for the audio file`, { code: `HTTP_${res.status}` });
    }
    if (!res.body) throw new CliError('empty response from the server', { code: 'EMPTY' });
    const expected = Number(res.headers.get('content-length'));
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
    } catch (err) {
      if (isDiskFatal(err)) throw err;
      throw new CliError(`download interrupted: ${err.message} (the partial file is kept; run again to resume)`, { code: 'INTERRUPTED' });
    }
    const got = sizeOf(part) - (resumed ? start : 0);
    if (Number.isFinite(expected) && expected > 0 && got !== expected) {
      throw new CliError(`download incomplete: got ${got} of ${expected} bytes (the partial file is kept; run again to resume)`, { code: 'INTERRUPTED' });
    }
    return { ext: extForType(res.headers.get('content-type')), resumed };
  }
}

/**
 * An .m3u8 playlist (UTF-8 M3U) in playlist order. `entries`: [{ file,
 * title, artist, duration_sec }] or { missing: label } for songs that could
 * not be pulled (written as comments). Paths are relative to the .m3u8 and
 * use "/" (understood by players on every OS).
 */
function m3u8(entries, m3uDir) {
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    if (e.missing) { lines.push(`# missing: ${e.missing.replace(/[\r\n]+/g, ' ')}`); continue; }
    const dur = Number.isFinite(Number(e.duration_sec)) && Number(e.duration_sec) > 0 ? Math.round(Number(e.duration_sec)) : -1;
    const label = [e.artist, e.title].filter(Boolean).join(' - ').replace(/[\r\n]+/g, ' ');
    lines.push(`#EXTINF:${dur},${label}`);
    lines.push(path.relative(m3uDir, e.file).split(path.sep).join('/'));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  Puller, pool, m3u8, portableName, songBaseName, songKey, extForType, truncateBytes,
  sha256File, formatBytes, writeAtomic, isFatal, isDiskFatal, EXIT,
};
