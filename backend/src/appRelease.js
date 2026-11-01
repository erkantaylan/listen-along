// The latest Android release for the /app page: read from the public GitHub
// Releases API (no token), cached, and never an error for the page. The repo
// also has older backend releases (v2.x), so only android-vX.Y.Z tags count and
// /releases/latest cannot be used.
const REPO = 'erkantaylan/listen-along';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

const TTL_MS = 10 * 60 * 1000;   // how long an answer is reused
const RETRY_MS = 2 * 60 * 1000;  // how long after a failure GitHub is asked again
const TIMEOUT_MS = 5000;

const TAG_RE = /^android-v(\d+)\.(\d{1,2})\.(\d{1,2})$/;
const APK_RE = /^listen-along-[\w.-]+\.apk$/;
const SHA_IN_NOTES_RE = /SHA-256:\s*([a-f0-9]{64})\b/i;

const isGithubUrl = (url) => typeof url === 'string' && url.startsWith('https://github.com/');

function sha256Of(release, asset) {
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '');
  if (digest) return digest[1];
  const inNotes = SHA_IN_NOTES_RE.exec(release.body || '');
  return inNotes ? inNotes[1].toLowerCase() : null;
}

/** The newest published android release with an APK, as the page needs it, or null. */
function pickLatest(releases) {
  if (!Array.isArray(releases)) throw new Error('unexpected answer from GitHub');
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const tag = TAG_RE.exec(release.tag_name || '');
    if (!tag) continue;
    const asset = (release.assets || []).find((a) => APK_RE.test(a.name || '') && isGithubUrl(a.browser_download_url));
    if (!asset) continue;
    const [x, y, z] = tag.slice(1).map(Number);
    const code = x * 10000 + y * 100 + z;
    if (best && best.code >= code) continue;
    best = {
      code,
      view: {
        version: `${x}.${y}.${z}`,
        tag: release.tag_name,
        publishedAt: release.published_at || null,
        releaseUrl: isGithubUrl(release.html_url) ? release.html_url : RELEASES_PAGE,
        apk: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || null },
        sha256: sha256Of(release, asset),
      },
    };
  }
  return best ? best.view : null;
}

/**
 * @param fetchImpl  global fetch by default (injected by tests)
 * @param apiUrl     the releases API (APP_RELEASES_API_URL overrides it for tests)
 * @returns {{ latest: () => Promise<object> }} latest() always resolves.
 */
function createAppRelease({
  fetchImpl = (...args) => globalThis.fetch(...args), apiUrl = API_URL, now = Date.now,
  ttlMs = TTL_MS, retryMs = RETRY_MS, timeoutMs = TIMEOUT_MS, log = console.warn,
} = {}) {
  let known = null;     // the last good answer (null: no android release yet)
  let lastCheckOk = false;
  let etag = null;
  let nextCheck = 0;
  let inFlight = null;

  async function refresh() {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'listen-along-server',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) headers['If-None-Match'] = etag;
    try {
      const res = await fetchImpl(apiUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        known = pickLatest(await res.json());
        etag = res.headers.get('etag');
      }
      lastCheckOk = true;
      nextCheck = now() + ttlMs;
    } catch (err) {
      log(`App release check failed: ${err.message}`);
      lastCheckOk = false;
      nextCheck = now() + retryMs;
    }
  }

  async function latest() {
    if (now() >= nextCheck && !inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    if (inFlight) await inFlight;
    if (known) return { available: true, ...known, releasesUrl: RELEASES_PAGE, stale: !lastCheckOk };
    return { available: false, reason: lastCheckOk ? 'none' : 'unavailable', releasesUrl: RELEASES_PAGE };
  }

  return { latest };
}

module.exports = { createAppRelease, pickLatest, RELEASES_PAGE };
