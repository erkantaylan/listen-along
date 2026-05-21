// Node 18+ has global fetch; spotify-url-info requires you to pass it
const { getPreview } = require('spotify-url-info')(fetch);

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
    return null;
  } catch {
    return null;
  }
}

async function getTrack(url) {
  const data = await getPreview(url);
  const title = data.title || 'Unknown';
  const artist = data.artist || 'Unknown Artist';
  return {
    title: `${title} - ${artist}`,
    artist,
    thumbnail: data.image || null,
    duration: 0,
    searchQuery: `${title} ${artist}`
  };
}

module.exports = { parseSpotifyUrl, getTrack };
