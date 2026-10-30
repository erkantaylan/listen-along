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
   * Embed a JPEG cover into an m4a in place, without re-encoding. Uses the
   * plain mp4 muxer: ffmpeg's "ipod" muxer (picked for .m4a) rejects mjpeg,
   * which is why yt-dlp's own --embed-thumbnail fails without mutagen.
   */
  async embedCover(file, cover) {
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

module.exports = { Media, expandInputs, normTags, AUDIO_EXTS };
