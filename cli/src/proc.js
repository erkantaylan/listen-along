'use strict';

const { spawn } = require('child_process');
const { CliError, EXIT } = require('./errors');

const INSTALL_HINTS = {
  'yt-dlp': 'Install yt-dlp: `pipx install yt-dlp` (recommended, then `pipx upgrade yt-dlp` regularly), or `python3 -m pip install --user -U yt-dlp`, or download the binary from https://github.com/yt-dlp/yt-dlp/releases. Override the path with LA_YTDLP_BIN.',
  ffmpeg: 'Install ffmpeg (provides ffmpeg and ffprobe): `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora), `sudo pacman -S ffmpeg` (Arch). Override paths with LA_FFMPEG_BIN / LA_FFPROBE_BIN.',
  ffprobe: 'ffprobe ships with ffmpeg: `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora), `sudo pacman -S ffmpeg` (Arch). Override the path with LA_FFPROBE_BIN.',
};

function missingDependency(name, bin) {
  return new CliError(`Required program not found: ${name}${bin && bin !== name ? ` (${bin})` : ''}`, {
    exitCode: EXIT.DEPENDENCY,
    code: 'MISSING_DEPENDENCY',
    hint: INSTALL_HINTS[name],
  });
}

/**
 * Run a program and collect its output.
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.name] - logical name for dependency errors ('yt-dlp', 'ffmpeg', ...)
 * @param {(chunk: string) => void} [opts.onStderr] - live stderr callback
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(bin, args, { name = bin, onStderr, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    } catch (err) {
      reject(err.code === 'ENOENT' ? missingDependency(name, bin) : err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (onStderr) onStderr(d); });
    child.on('error', (err) => {
      reject(err.code === 'ENOENT' || err.code === 'EACCES' ? missingDependency(name, bin) : err);
    });
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

/** Split a shell-style argument string ("--a 'b c' \"d\"") into argv. */
function splitArgs(str) {
  if (!str) return [];
  if (Array.isArray(str)) return str.flatMap(splitArgs);
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < str.length) cur += str[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (c === '\\' && i + 1 < str.length) {
      cur += str[++i]; has = true;
    } else if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c; has = true;
    }
  }
  if (quote) throw new CliError(`Unterminated quote in argument string: ${str}`, { exitCode: EXIT.USAGE, code: 'USAGE' });
  if (has) out.push(cur);
  return out;
}

module.exports = { run, splitArgs, missingDependency, INSTALL_HINTS };
