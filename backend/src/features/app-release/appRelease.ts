// The latest Android release for the /app page: read from the public GitHub
// Releases API (no token), cached, and never an error for the page. The repo
// also has older backend releases (v2.x), so only android-vX.Y.Z tags count and
// /releases/latest cannot be used.
const REPO = 'erkantaylan/listen-along';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

const TTL_MS = 10 * 60 * 1000;   // how long an answer is reused
const RETRY_MS = 2 * 60 * 1000;  // how long after a failure GitHub is asked again
const TIMEOUT_MS = 5000;

const TAG_RE = /^android-v(\d+)\.(\d{1,2})\.(\d{1,2})$/;
const APK_RE = /^listen-along-[\w.-]+\.apk$/;
const SHA_IN_NOTES_RE = /SHA-256:\s*([a-f0-9]{64})\b/i;

/** The fields of a GitHub release (and its assets) this module reads; GitHub sends many more. */
export interface GithubAsset {
  name?: string;
  size?: number;
  digest?: string | null;
  browser_download_url?: string;
}
export interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  assets?: GithubAsset[];
}

/** One release as the /app page shows it. */
export interface AppReleaseView {
  version: string;
  tag: string;
  publishedAt: string | null;
  releaseUrl: string;
  apk: { name: string; url: string; size: number | null };
  sha256: string | null;
}

/** GET /api/app/latest's body. */
export type AppLatest =
  | ({ available: true } & AppReleaseView & { releasesUrl: string; stale: boolean })
  | { available: false; reason: 'none' | 'unavailable'; releasesUrl: string };

/** What createAppRelease needs from fetch (the global fetch's Response fits). */
export interface FetchAnswer {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchAnswer>;

export interface AppReleaseOptions {
  /** global fetch by default (injected by tests) */
  fetchImpl?: FetchImpl;
  /** the releases API (APP_RELEASES_API_URL overrides it for tests) */
  apiUrl?: string;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface AppRelease {
  /** Always resolves. */
  latest(): Promise<AppLatest>;
}

const isGithubUrl = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://github.com/');

function sha256Of(release: GithubRelease, asset: GithubAsset): string | null {
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '');
  if (digest) return digest[1];
  const inNotes = SHA_IN_NOTES_RE.exec(release.body || '');
  return inNotes ? inNotes[1].toLowerCase() : null;
}

/** The newest published android release with an APK, as the page needs it, or null. */
export function pickLatest(releases: unknown): AppReleaseView | null {
  if (!Array.isArray(releases)) throw new Error('unexpected answer from GitHub');
  let best: { code: number; view: AppReleaseView } | null = null;
  for (const release of releases as (GithubRelease | null | undefined)[]) {
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
        tag: release.tag_name as string,
        publishedAt: release.published_at || null,
        releaseUrl: isGithubUrl(release.html_url) ? release.html_url : RELEASES_PAGE,
        apk: { name: asset.name as string, url: asset.browser_download_url as string, size: Number(asset.size) || null },
        sha256: sha256Of(release, asset),
      },
    };
  }
  return best ? best.view : null;
}

export function createAppRelease({
  fetchImpl = (...args) => globalThis.fetch(...args), apiUrl = API_URL, now = Date.now,
  ttlMs = TTL_MS, retryMs = RETRY_MS, timeoutMs = TIMEOUT_MS, log = console.warn,
}: AppReleaseOptions = {}): AppRelease {
  let known: AppReleaseView | null = null;     // the last good answer (null: no android release yet)
  let lastCheckOk = false;
  let etag: string | null = null;
  let nextCheck = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const headers: Record<string, string> = {
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
      log(`App release check failed: ${(err as Error).message}`);
      lastCheckOk = false;
      nextCheck = now() + retryMs;
    }
  }

  async function latest(): Promise<AppLatest> {
    if (now() >= nextCheck && !inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    if (inFlight) await inFlight;
    if (known) return { available: true, ...known, releasesUrl: RELEASES_PAGE, stale: !lastCheckOk };
    return { available: false, reason: lastCheckOk ? 'none' : 'unavailable', releasesUrl: RELEASES_PAGE };
  }

  return { latest };
}
