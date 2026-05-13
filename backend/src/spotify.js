const https = require('https');

let accessToken = null;
let tokenExpiry = 0;
let refreshToken = process.env.SPOTIFY_REFRESH_TOKEN || null;
let enabled = false;
let tokenFetchInFlight = null;

const REQUEST_TIMEOUT_MS = 15000;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

function init() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('Spotify integration disabled: missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET');
    enabled = false;
    return false;
  }
  enabled = true;
  if (refreshToken) {
    console.log('[Spotify] Integration enabled (Authorization Code flow — playlist import ready)');
  } else {
    console.log('[Spotify] Integration enabled (Client Credentials only — playlist import requires setup, visit /auth/spotify/setup)');
  }
  return true;
}

function isEnabled() { return enabled; }

function hasUserAuth() { return !!refreshToken; }

function setRefreshToken(token) {
  refreshToken = token;
  // Invalidate cached access token so next call uses the new refresh token
  accessToken = null;
  tokenExpiry = 0;
  console.log('[Spotify] Refresh token stored — Authorization Code flow active');
}

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

function postToAccounts(body) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const bodyStr = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Spotify auth failed (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse Spotify auth response')); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Spotify auth timed out')));
    req.on('error', err => reject(new Error(`Spotify auth request failed: ${err.message}`)));
    req.write(bodyStr);
    req.end();
  });
}

// Exchange authorization code for tokens (called once during setup)
async function exchangeCode(code, redirectUri) {
  const json = await postToAccounts({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  accessToken = json.access_token;
  tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  console.log(`[Spotify] Granted scopes: ${json.scope}`);
  setRefreshToken(json.refresh_token);
  // Log which account connected
  try {
    const me = await spotifyApi('/v1/me');
    console.log(`[Spotify] Connected account: ${me.display_name} (${me.id}) country=${me.country}`);
  } catch (e) {
    console.warn('[Spotify] Could not fetch /v1/me after setup:', e.message);
  }
  return json;
}

function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return Promise.resolve(accessToken);
  if (tokenFetchInFlight) return tokenFetchInFlight;

  tokenFetchInFlight = (async () => {
    let json;
    if (refreshToken) {
      json = await postToAccounts({ grant_type: 'refresh_token', refresh_token: refreshToken });
      // Spotify may issue a new refresh token — rotate if so
      if (json.refresh_token) setRefreshToken(json.refresh_token);
    } else {
      json = await postToAccounts('grant_type=client_credentials');
    }
    accessToken = json.access_token;
    tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
    const flow = refreshToken ? 'refresh' : 'client_credentials';
    console.log(`[Spotify] Access token refreshed (${flow}), expires in ${json.expires_in}s`);
    return accessToken;
  })().finally(() => { tokenFetchInFlight = null; });

  return tokenFetchInFlight;
}

async function spotifyApi(path, attempt = 1) {
  const token = await getAccessToken();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.spotify.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429 && attempt <= 3) {
          const wait = parseInt(res.headers['retry-after'] || '2', 10);
          console.warn(`[Spotify] Rate limited on ${path}, retrying in ${wait}s (attempt ${attempt}/3)`);
          setTimeout(() => spotifyApi(path, attempt + 1).then(resolve).catch(reject), wait * 1000);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Spotify API error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse Spotify API response for ${path}`)); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Spotify API request timed out (${path})`)));
    req.on('error', err => reject(new Error(`Spotify API request failed: ${err.message} (${path})`)));
    req.end();
  });
}

async function getTrack(trackId) {
  const data = await spotifyApi(`/v1/tracks/${encodeURIComponent(trackId)}`);
  const artists = data.artists ? data.artists.map(a => a.name).join(', ') : 'Unknown Artist';
  const thumbnail = data.album && data.album.images && data.album.images.length > 0 ? data.album.images[0].url : null;
  return {
    title: `${data.name} - ${artists}`,
    artist: artists,
    thumbnail,
    duration: data.duration_ms ? data.duration_ms / 1000 : 0,
    searchQuery: `${data.name} ${artists}`
  };
}

async function getPlaylistTracks(playlistId) {
  const data = await spotifyApi(`/v1/playlists/${encodeURIComponent(playlistId)}`);
  const playlistTitle = data.name || 'Spotify Playlist';

  let allTrackItems = [];
  let nextUrl = `/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
  while (nextUrl) {
    const p = new URL(nextUrl, 'https://api.spotify.com');
    const page = await spotifyApi(p.pathname + p.search);
    if (page.items) allTrackItems = allTrackItems.concat(page.items);
    nextUrl = page.next ? (() => { const u = new URL(page.next); return u.pathname + u.search; })() : null;
  }

  const nullCount = allTrackItems.filter(i => !i.track).length;
  if (nullCount > 0) console.warn(`[Spotify] ${nullCount} items skipped (local files / unavailable tracks)`);
  console.log(`[Spotify] Playlist "${playlistTitle}": ${allTrackItems.length - nullCount} valid tracks`);

  const items = allTrackItems
    .filter(i => i.track)
    .map(i => {
      const t = i.track;
      const artists = t.artists ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist';
      const thumbnail = t.album && t.album.images && t.album.images.length > 0 ? t.album.images[0].url : null;
      return {
        title: `${t.name} - ${artists}`,
        artist: artists,
        thumbnail,
        duration: t.duration_ms ? t.duration_ms / 1000 : 0,
        searchQuery: `${t.name} ${artists}`
      };
    });

  return { title: playlistTitle, items, total: items.length, limited: false };
}

async function spotifyMe() {
  return spotifyApi('/v1/me');
}

module.exports = {
  init, isEnabled, hasUserAuth, setRefreshToken, exchangeCode, spotifyMe,
  parseSpotifyUrl, getTrack, getPlaylistTracks
};
