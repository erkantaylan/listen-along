'use strict';

const fs = require('fs');
const path = require('path');
const { run: defaultRun, missingDependency } = require('./proc');
const { CliError } = require('./errors');

/** Lower-case every tag key so "TITLE", "Title" and "title" all match. */
function normTags(...sources) {
  const out = {};
  for (const tags of sources) {
    for (const [k, v] of Object.entries(tags || {})) {
      const key = k.toLowerCase();
      if (out[key] === undefined && v !== undefined && v !== '') out[key] = String(v).trim();
    }
  }
  return out;
}

/**
 * ffprobe/ffmpeg wrapper. All process spawning for local media goes through
 * here so tests can replace it.
 */
class Media {
  constructor({ ffmpeg, ffprobe, run = defaultRun, env = process.env } = {}) {
    this.ffmpeg = ffmpeg || env.LA_FFMPEG_BIN || 'ffmpeg';
    this.ffprobe = ffprobe || env.LA_FFPROBE_BIN || 'ffprobe';
    this.run = run;
  }

  /** Verify ffmpeg and ffprobe both run. */
  async check() {
    for (const [name, bin] of [['ffmpeg', this.ffmpeg], ['ffprobe', this.ffprobe]]) {
      const { code } = await this.run(bin, ['-version'], { name });
      if (code !== 0) throw missingDependency(name, bin);
    }
  }

  /**
   * Inspect a media file.
   * @returns {Promise<{ format: string, codec: string|null, duration: number|null,
   *   hasCover: boolean, tags: { title?, artist?, album?, comment?, ... } }>}
   */
  async probe(file) {
    const { code, stdout, stderr } = await this.run(this.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', file,
    ], { name: 'ffprobe' });
    if (code !== 0) {
      throw new CliError(`Not a readable audio file: ${stderr.trim().split('\n').pop() || `ffprobe exit ${code}`}`, { code: 'BAD_MEDIA' });
    }
    let data;
    try { data = JSON.parse(stdout); } catch { throw new CliError('ffprobe returned unparseable output', { code: 'BAD_MEDIA' }); }
    const streams = data.streams || [];
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!audio) throw new CliError('File has no audio stream', { code: 'BAD_MEDIA' });
    const duration = Number(data.format?.duration || audio.duration);
    return {
      format: data.format?.format_name || '',
      codec: audio.codec_name || null,
      duration: Number.isFinite(duration) ? duration : null,
      hasCover: streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic),
      // Container tags win over stream tags (ogg/opus keep them on the stream).
      tags: normTags(data.format?.tags, audio.tags),
    };
  }

  /** True if this probe result is AAC in an MP4/M4A container (uploadable as-is). */
  static isAacM4a(probe, file) {
    return /(^|,)(mov|mp4|m4a)(,|$)/.test(probe.format) && probe.codec === 'aac' && /\.(m4a|mp4)$/i.test(file);
  }

  /** True if this probe result is Opus in an Ogg container (any file name). */
  static isOggOpus(probe) {
    return /(^|,)ogg(,|$)/.test(probe.format) && probe.codec === 'opus';
  }

  /**
   * The upload format this file already is, as the server names them: 'm4a'
   * (AAC in MP4, .m4a/.mp4), 'opus' (Opus in Ogg, named .opus), else null.
   */
  static uploadFormat(probe, file) {
    if (Media.isAacM4a(probe, file)) return 'm4a';
    if (Media.isOggOpus(probe) && /\.opus$/i.test(file)) return 'opus';
    return null;
  }

  /**
   * Copy the Opus stream of any container (WebM, Matroska, Ogg) into an Ogg
   * `.opus` file without re-encoding, keeping the tags. Cover art is dropped.
   */
  async toOpus(input, output) {
    const res = await this.run(this.ffmpeg, [
      '-v', 'error', '-y', '-i', input, '-map', '0:a:0', '-c:a', 'copy', '-map_metadata', '0', '-f', 'ogg', output,
    ], { name: 'ffmpeg' });
    if (res.code !== 0) {
      fs.rmSync(output, { force: true });
      throw new CliError(`ffmpeg remux to Opus failed: ${res.stderr.trim().split('\n').pop()}`, { code: 'CONVERT_FAILED' });
    }
    return output;
  }

  /**
   * Transcode any audio file to AAC m4a (~192k), keeping tags and, when
   * possible, embedded cover art.
   */
  async toM4a(input, output, { bitrate = '192k' } = {}) {
    const base = ['-v', 'error', '-y', '-i', input, '-map_metadata', '0'];
    const tail = ['-c:a', 'aac', '-b:a', bitrate, '-f', 'mp4', '-brand', 'M4A ', '-movflags', '+faststart', output];
    // First try with cover art (mjpeg/png attached pics are valid in mp4).
    let res = await this.run(this.ffmpeg, [...base, '-map', '0:a:0', '-map', '0:v:0?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...tail], { name: 'ffmpeg' });
    if (res.code !== 0) {
      res = await this.run(this.ffmpeg, [...base, '-map', '0:a:0', '-vn', ...tail], { name: 'ffmpeg' });
    }
    if (res.code !== 0) {
      throw new CliError(`ffmpeg conversion failed: ${res.stderr.trim().split('\n').pop()}`, { code: 'CONVERT_FAILED' });
    }
    return output;
  }

  /**
   * Embed a JPEG cover into an m4a or an Ogg `.opus` in place, without
   * re-encoding. m4a: the plain mp4 muxer, as ffmpeg's "ipod" muxer (picked
   * for .m4a) rejects mjpeg, which is why yt-dlp's own --embed-thumbnail fails
   * without mutagen. Opus: see embedOggCover.
   */
  async embedCover(file, cover) {
    if (/\.opus$/i.test(file)) return this.embedOggCover(file, cover);
    const tmp = `${file}.cover.tmp`;
    const res = await this.run(this.ffmpeg, [
      '-v', 'error', '-y', '-i', file, '-i', cover,
      '-map', '0:a', '-map', '1:0', '-c', 'copy', '-disposition:v:0', 'attached_pic',
      '-map_metadata', '0', '-f', 'mp4', '-brand', 'M4A ', '-movflags', '+faststart', tmp,
    ], { name: 'ffmpeg' });
    if (res.code !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new CliError(`Embedding cover failed: ${res.stderr.trim().split('\n').pop()}`, { code: 'COVER_FAILED' });
    }
    fs.renameSync(tmp, file);
    return file;
  }

  /**
   * Ogg has no picture stream: a cover is a METADATA_BLOCK_PICTURE comment (a
   * base64 FLAC picture block). The ogg muxer of ffmpeg (7.0) refuses an
   * attached picture, so the comment is written through an ffmetadata file
   * (too long for a command-line argument). Audio and tags are copied as is.
   */
  async embedOggCover(file, cover) {
    const tmp = `${file}.cover.tmp`;
    const meta = `${file}.cover.ffmeta`;
    try {
      fs.writeFileSync(meta, `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${escapeFfmeta(flacPictureBlock(fs.readFileSync(cover)).toString('base64'))}\n`);
      const res = await this.run(this.ffmpeg, [
        '-v', 'error', '-y', '-i', file, '-f', 'ffmetadata', '-i', meta,
        '-map', '0:a', '-c', 'copy', '-map_metadata', '1', '-f', 'ogg', tmp,
      ], { name: 'ffmpeg' });
      if (res.code !== 0) {
        fs.rmSync(tmp, { force: true });
        throw new CliError(`Embedding cover failed: ${res.stderr.trim().split('\n').pop()}`, { code: 'COVER_FAILED' });
      }
      fs.renameSync(tmp, file);
      return file;
    } finally {
      fs.rmSync(meta, { force: true });
    }
  }
}

/** Width and height of a JPEG (from its SOF marker), or zeros. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { width: 0, height: 0 };
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

/**
 * A FLAC METADATA_BLOCK_PICTURE (front cover) for a JPEG, the format Vorbis
 * comments carry (base64) in Ogg Opus / Vorbis files.
 */
function flacPictureBlock(jpeg, mime = 'image/jpeg') {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const { width, height } = jpegSize(jpeg);
  return Buffer.concat([
    u32(3), // picture type: front cover
    u32(Buffer.byteLength(mime)), Buffer.from(mime),
    u32(0), // no description
    u32(width), u32(height), u32(24), u32(0), // width, height, colour depth, palette size
    u32(jpeg.length), jpeg,
  ]);
}

/** Escape a value for an ffmetadata file (= ; # \ and newlines). */
function escapeFfmeta(value) {
  return String(value).replace(/[\\=;#\n]/g, (c) => `\\${c}`);
}

const AUDIO_EXTS = new Set(['.m4a', '.mp4', '.aac', '.mp3', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.webm', '.alac', '.aiff', '.aif', '.ape', '.wv', '.mka']);

/**
 * Expand file/dir arguments into a flat sorted list of audio files.
 * Directories are walked recursively and filtered by audio extension;
 * explicitly named files are always included.
 * @returns {{ files: string[], missing: string[] }}
 */
function expandInputs(inputs) {
  const files = [];
  const missing = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) files.push(p);
    }
  };
  for (const input of inputs) {
    let st;
    try { st = fs.statSync(input); } catch { missing.push(input); continue; }
    if (st.isDirectory()) walk(input);
    else files.push(input);
  }
  return { files: [...new Set(files.map((f) => path.resolve(f)))], missing };
}

module.exports = { Media, expandInputs, normTags, AUDIO_EXTS, flacPictureBlock, jpegSize, escapeFfmeta };
