const https = require('https');

let accessToken = null;
let tokenExpiry = 0;
let enabled = false;
let tokenFetchInFlight = null;

const REQUEST_TIMEOUT_MS = 15000;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

/**
 * Initialize Spotify integration.
 * Logs status and returns whether Spotify is enabled.
 */
function init() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('Spotify integration disabled: missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET');
    enabled = false;
    return false;
  }
  enabled = true;
  console.log('Spotify integration enabled');
  return true;
}

/**
 * Check if Spotify integration is enabled
 */
function isEnabled() {
  return enabled;
}

/**
 * Check if a URL is a Spotify track or playlist URL
 * @param {string} url
 * @returns {{ type: 'track'|'playlist', id: string } | null}
 */
function parseSpotifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'open.spotify.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const type = parts[0];
    const id = parts[1];
    if (type === 'track' && id) return { type: 'track', id };
    if (type === 'playlist' && id) return { type: 'playlist', id };
    return null;
  } catch {
    return null;
  }
}

/**
 * Get an access token using Client Credentials flow
 */
function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return Promise.resolve(accessToken);
  }

  // Deduplicate concurrent token requests
  if (tokenFetchInFlight) return tokenFetchInFlight;

  tokenFetchInFlight = new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const body = 'grant_type=client_credentials';

    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Spotify auth failed (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(data);
          accessToken = json.access_token;
          tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
          console.log(`[Spotify] Access token refreshed, expires in ${json.expires_in}s`);
          resolve(accessToken);
        } catch (e) {
          reject(new Error('Failed to parse Spotify auth response'));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Spotify auth request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`Spotify auth request failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  }).finally(() => {
    tokenFetchInFlight = null;
  });

  return tokenFetchInFlight;
}

/**
 * Make a request to the Spotify API
 * @param {string} path - API path (e.g., /v1/tracks/xxx)
 * @returns {Promise<Object>}
 */
async function spotifyApi(path, attempt = 1) {
  const token = await getAccessToken();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.spotify.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429 && attempt <= 3) {
          const retryAfter = parseInt(res.headers['retry-after'] || '2', 10);
          console.warn(`[Spotify] Rate limited on ${path}, retrying in ${retryAfter}s (attempt ${attempt}/3)`);
          setTimeout(() => {
            spotifyApi(path, attempt + 1).then(resolve).catch(reject);
          }, retryAfter * 1000);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Spotify API error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Spotify API response for ${path}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Spotify API request timed out after ${REQUEST_TIMEOUT_MS}ms (${path})`));
    });

    req.on('error', (err) => {
      reject(new Error(`Spotify API request failed: ${err.message} (${path})`));
    });

    req.end();
  });
}

/**
 * Get track metadata from Spotify
 * @param {string} trackId - Spotify track ID
 * @returns {Promise<{ title: string, artist: string, thumbnail: string, duration: number, searchQuery: string }>}
 */
async function getTrack(trackId) {
  const data = await spotifyApi(`/v1/tracks/${encodeURIComponent(trackId)}`);
  const artists = data.artists ? data.artists.map(a => a.name).join(', ') : 'Unknown Artist';
  const title = data.name;
  const thumbnail = data.album && data.album.images && data.album.images.length > 0
    ? data.album.images[0].url
    : null;
  const duration = data.duration_ms ? data.duration_ms / 1000 : 0;

  return {
    title: `${title} - ${artists}`,
    artist: artists,
    thumbnail,
    duration,
    searchQuery: `${title} ${artists}`
  };
}

/**
 * Get all tracks from a Spotify playlist (with pagination)
 * @param {string} playlistId - Spotify playlist ID
 * @returns {Promise<{ title: string, items: Array<{ title: string, artist: string, thumbnail: string, duration: number, searchQuery: string }>, total: number, limited: boolean }>}
 */
async function getPlaylistTracks(playlistId) {
  const data = await spotifyApi(`/v1/playlists/${encodeURIComponent(playlistId)}`);
  const playlistTitle = data.name || 'Spotify Playlist';
  const total = data.tracks && data.tracks.total ? data.tracks.total : 0;

  console.log(`[Spotify] Playlist "${playlistTitle}" (${playlistId}): total=${total}, items=${data.tracks && data.tracks.items ? data.tracks.items.length : 'null'}, next=${data.tracks && data.tracks.next ? 'yes' : 'no'}`);

  let allTrackItems = data.tracks && data.tracks.items ? [...data.tracks.items] : [];
  let nextUrl = data.tracks && data.tracks.next ? data.tracks.next : null;

  // Paginate through remaining tracks
  while (nextUrl) {
    // Extract path from full URL for our spotifyApi helper
    const parsed = new URL(nextUrl);
    const pageData = await spotifyApi(parsed.pathname + parsed.search);
    if (pageData.items) {
      allTrackItems = allTrackItems.concat(pageData.items);
    }
    nextUrl = pageData.next || null;
  }

  const nullTrackCount = allTrackItems.filter(item => !item.track).length;
  if (nullTrackCount > 0) console.warn(`[Spotify] ${nullTrackCount} items had null track (local files / unavailable tracks), skipping`);
  console.log(`[Spotify] Fetched ${allTrackItems.length} total items, ${allTrackItems.length - nullTrackCount} valid tracks`);

  const items = allTrackItems
    .filter(item => item.track)
    .map(item => {
      const track = item.track;
      const artists = track.artists ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist';
      const title = track.name;
      const thumbnail = track.album && track.album.images && track.album.images.length > 0
        ? track.album.images[0].url
        : null;
      const duration = track.duration_ms ? track.duration_ms / 1000 : 0;

      return {
        title: `${title} - ${artists}`,
        artist: artists,
        thumbnail,
        duration,
        searchQuery: `${title} ${artists}`
      };
    });

  return {
    title: playlistTitle,
    items,
    total,
    limited: false
  };
}

module.exports = {
  init,
  isEnabled,
  parseSpotifyUrl,
  getTrack,
  getPlaylistTracks
};
