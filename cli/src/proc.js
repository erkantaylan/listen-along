'use strict';

const { spawn } = require('child_process');
const { CliError, EXIT } = require('./errors');

/** ffmpeg install command per OS (ffprobe ships with it). */
function ffmpegInstall(platform = process.platform) {
  if (platform === 'win32') return '`winget install --id Gyan.FFmpeg` (or `choco install ffmpeg` / `scoop install ffmpeg`), then open a new terminal';
  if (platform === 'darwin') return '`brew install ffmpeg`';
  return '`sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora), `sudo pacman -S ffmpeg` (Arch)';
}

/** How to install each external program, for this OS. */
function installHints(platform = process.platform) {
  return {
    'yt-dlp': platform === 'linux'
      ? 'Install yt-dlp: `pipx install yt-dlp` (recommended, then `pipx upgrade yt-dlp` regularly), or `python3 -m pip install --user -U yt-dlp`, or download the binary from https://github.com/yt-dlp/yt-dlp/releases. Override the path with LA_YTDLP_BIN.'
      : `Install yt-dlp: run \`la worker --install-ytdlp\` (downloads the official standalone binary for this computer), or ${platform === 'win32' ? '`winget install yt-dlp.yt-dlp`' : '`brew install yt-dlp`'}, or download it from https://github.com/yt-dlp/yt-dlp/releases. Override the path with LA_YTDLP_BIN.`,
    ffmpeg: `Install ffmpeg (provides ffmpeg and ffprobe): ${ffmpegInstall(platform)}. Override paths with LA_FFMPEG_BIN / LA_FFPROBE_BIN.`,
    ffprobe: `ffprobe ships with ffmpeg: ${ffmpegInstall(platform)}. Override the path with LA_FFPROBE_BIN.`,
  };
}

const INSTALL_HINTS = installHints();

function missingDependency(name, bin) {
  return new CliError(`Required program not found: ${name}${bin && bin !== name ? ` (${bin})` : ''}`, {
    exitCode: EXIT.DEPENDENCY,
    code: 'MISSING_DEPENDENCY',
    hint: installHints()[name],
  });
}

/**
 * Run a program and collect its output.
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.name] - logical name for dependency errors ('yt-dlp', 'ffmpeg', ...)
 * @param {(chunk: string) => void} [opts.onStderr] - live stderr callback
 * @param {boolean} [opts.detached] - own process group / console (see above)
 * @param {(child) => void} [opts.onSpawn] - called with the ChildProcess (to kill it later)
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(bin, args, { name = bin, onStderr, env, detached = false, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // detached (la worker): the child gets its own process group (POSIX) /
      // console (Windows), so a Ctrl+C in the terminal reaches only la, which
      // can then let the current download finish. windowsHide: no console
      // window pops up on Windows.
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env, detached, windowsHide: true });
      if (onSpawn) onSpawn(child);
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

/**
 * Kill a child and whatever it started (yt-dlp runs ffmpeg): the process
 * group on POSIX (needs detached), `taskkill /T /F` on Windows.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
  } catch { /* already gone */ }
}

module.exports = { run, splitArgs, missingDependency, killTree, installHints, ffmpegInstall, INSTALL_HINTS };
