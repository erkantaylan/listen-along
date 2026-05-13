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

module.exports = { parseSpotifyUrl };
