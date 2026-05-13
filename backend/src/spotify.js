// Node 18+ has global fetch; spotify-url-info requires you to pass it
const { getPreview, getTracks } = require('spotify-url-info')(fetch);

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

async function getPlaylistTracks(url) {
  const [preview, tracks] = await Promise.all([getPreview(url), getTracks(url)]);

  if (!tracks || tracks.length === 0) {
    throw new Error('Spotify playlist is empty or could not be read');
  }

  const items = tracks.map(t => {
    const name = t.name || 'Unknown';
    const artist = t.artist || 'Unknown Artist';
    return {
      title: `${name} - ${artist}`,
      artist,
      thumbnail: null,
      duration: t.duration ? t.duration / 1000 : 0,
      searchQuery: `${name} ${artist}`
    };
  });

  return {
    title: preview.title || 'Spotify Playlist',
    items,
    total: items.length,
    limited: items.length >= 100
  };
}

module.exports = { parseSpotifyUrl, getTrack, getPlaylistTracks };
