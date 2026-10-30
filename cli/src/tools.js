'use strict';

/**
 * External tools for `la worker`: a per-user tools directory holding the
 * official standalone yt-dlp binary (downloaded on request, checksum-checked),
 * yt-dlp freshness, and OS-specific ffmpeg install hints. ffmpeg is never
 * installed automatically.
 *
 * Tools dir (LA_TOOLS_DIR overrides):
 *   Linux    $XDG_DATA_HOME/listen-along/bin  (default ~/.local/share/listen-along/bin)
 *   macOS    ~/Library/Application Support/listen-along/bin
 *   Windows  %LOCALAPPDATA%\listen-along\bin
 *
 * yt-dlp lookup order (every command): LA_YTDLP_BIN, then the tools dir copy
 * if present, then `yt-dlp` on PATH.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError, EXIT } = require('./errors');

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
/** A yt-dlp older than this many days is "outdated" (YouTube changes often). */
const MAX_AGE_DAYS = 60;

function toolsDir(env = process.env, platform = process.platform) {
  if (env.LA_TOOLS_DIR) return env.LA_TOOLS_DIR;
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'listen-along', 'bin');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'listen-along', 'bin');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'listen-along', 'bin');
}

function installedYtdlpPath(env = process.env, platform = process.platform) {
  return path.join(toolsDir(env, platform), platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

/** The yt-dlp to run: LA_YTDLP_BIN, else our installed copy, else PATH. */
function resolveYtdlpBin(env = process.env, platform = process.platform) {
  if (env.LA_YTDLP_BIN) return env.LA_YTDLP_BIN;
  const mine = installedYtdlpPath(env, platform);
  try { if (fs.statSync(mine).isFile()) return mine; } catch { /* not installed */ }
  return 'yt-dlp';
}

/**
 * The official release asset for this OS / CPU (standalone: no Python needed).
 * @returns {string|null} null when there is no build for it
 */
function ytdlpAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'; // x64 build also runs on ARM64 Windows
  if (platform === 'darwin') return 'yt-dlp_macos'; // universal (Intel + Apple silicon)
  if (platform === 'linux') {
    if (arch === 'x64') return 'yt-dlp_linux';
    if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
    if (arch === 'arm') return 'yt-dlp_linux_armv7l';
  }
  return null;
}

/** "2026.10.26" / "2026.10.26.233005" -> Date, else null. */
function versionDate(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Age of a yt-dlp version in days, or null if the version is not a date. */
function versionAgeDays(version, now = Date.now()) {
  const d = versionDate(version);
  return d ? Math.floor((now - d.getTime()) / 86400000) : null;
}

function isOutdated(version, now = Date.now(), maxAgeDays = MAX_AGE_DAYS) {
  const age = versionAgeDays(version, now);
  return age !== null && age > maxAgeDays;
}

async function fetchOk(fetchImpl, url, what) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (err) {
    throw new CliError(`Could not download ${what}: ${err.cause?.code || err.message}`, { code: 'TOOL_DOWNLOAD_FAILED', exitCode: EXIT.DEPENDENCY });
  }
  if (!res.ok) throw new CliError(`Could not download ${what}: HTTP ${res.status}`, { code: 'TOOL_DOWNLOAD_FAILED', exitCode: EXIT.DEPENDENCY });
  return res;
}

/**
 * Download the official standalone yt-dlp for this OS into the tools dir,
 * verified against the release's SHA2-256SUMS.
 * @returns {Promise<string>} the installed path
 */
async function installYtdlp({ env = process.env, fetch: fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch, out } = {}) {
  const asset = ytdlpAssetName(platform, arch);
  if (!asset) {
    throw new CliError(`There is no standalone yt-dlp build for ${platform}/${arch}`, {
      code: 'TOOL_UNSUPPORTED', exitCode: EXIT.DEPENDENCY, hint: 'Install yt-dlp with pip (`python3 -m pip install -U yt-dlp`) and make sure it is on PATH.',
    });
  }
  const dest = installedYtdlpPath(env, platform);
  if (out) out.info(`Downloading ${asset} from ${RELEASES}/ …`);
  const sums = await (await fetchOk(fetchImpl, `${RELEASES}/SHA2-256SUMS`, 'the yt-dlp checksums')).text();
  const line = sums.split(/\r?\n/).find((l) => l.trim().split(/\s+/)[1]?.replace(/^\*/, '') === asset);
  const expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new CliError(`The yt-dlp release has no checksum for ${asset}`, { code: 'TOOL_DOWNLOAD_FAILED', exitCode: EXIT.DEPENDENCY });
  }
  const data = Buffer.from(await (await fetchOk(fetchImpl, `${RELEASES}/${asset}`, asset)).arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) {
    throw new CliError(`Checksum mismatch for ${asset} (a new release may have just come out; try again)`, { code: 'TOOL_CHECKSUM', exitCode: EXIT.DEPENDENCY });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.download`;
  fs.writeFileSync(tmp, data, { mode: 0o755 });
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    // Windows: a running yt-dlp.exe cannot be replaced.
    fs.rmSync(tmp, { force: true });
    throw new CliError(`Could not write ${dest}: ${err.message}`, { code: 'TOOL_WRITE_FAILED', exitCode: EXIT.DEPENDENCY });
  }
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  if (out) out.info(`Installed yt-dlp at ${dest}`);
  return dest;
}

module.exports = {
  RELEASES,
  MAX_AGE_DAYS,
  toolsDir,
  installedYtdlpPath,
  resolveYtdlpBin,
  ytdlpAssetName,
  versionDate,
  versionAgeDays,
  isOutdated,
  installYtdlp,
};
