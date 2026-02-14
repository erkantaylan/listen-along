const https = require('https');

let accessToken = null;
let tokenExpiry = 0;
let enabled = false;

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
  return new Promise((resolve, reject) => {
    if (accessToken && Date.now() < tokenExpiry) {
      return resolve(accessToken);
    }

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
          return reject(new Error(`Spotify auth failed (${res.statusCode}): ${data}`));
        }
        try {
          const json = JSON.parse(data);
          accessToken = json.access_token;
          // Expire 60 seconds early to avoid edge cases
          tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
          resolve(accessToken);
        } catch (e) {
          reject(new Error('Failed to parse Spotify auth response'));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Spotify auth request failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Make a request to the Spotify API
 * @param {string} path - API path (e.g., /v1/tracks/xxx)
 * @returns {Promise<Object>}
 */
async function spotifyApi(path) {
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
        if (res.statusCode !== 200) {
          return reject(new Error(`Spotify API error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Spotify API response'));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Spotify API request failed: ${err.message}`));
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
  const artists = data.artists.map(a => a.name).join(', ');
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
 * Get all tracks from a Spotify playlist
 * @param {string} playlistId - Spotify playlist ID
 * @param {number} limit - Maximum number of tracks (default 50)
 * @returns {Promise<{ title: string, items: Array<{ title: string, artist: string, thumbnail: string, duration: number, searchQuery: string }> }>}
 */
async function getPlaylistTracks(playlistId, limit = 50) {
  const data = await spotifyApi(`/v1/playlists/${encodeURIComponent(playlistId)}?fields=name,tracks.items(track(name,artists(name),album(images),duration_ms)),tracks.total`);
  const playlistTitle = data.name || 'Spotify Playlist';
  const trackItems = data.tracks && data.tracks.items ? data.tracks.items : [];
  const total = data.tracks && data.tracks.total ? data.tracks.total : trackItems.length;

  const items = trackItems
    .slice(0, limit)
    .filter(item => item.track)
    .map(item => {
      const track = item.track;
      const artists = track.artists.map(a => a.name).join(', ');
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
    limited: total > limit
  };
}

module.exports = {
  init,
  isEnabled,
  parseSpotifyUrl,
  getTrack,
  getPlaylistTracks
};
