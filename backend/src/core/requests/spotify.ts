// Spotify track links: the page's preview (title, artist) through
// spotify-url-info's page scrape. No API credentials.
import { createRequire } from 'node:module';
import type { SpotifyUrlInfoModule } from 'spotify-url-info';

// A CommonJS package whose typings declare its default export as a type only:
// loaded with require, as before. Node 18+ has a global fetch; spotify-url-info
// requires you to pass it.
const require = createRequire(import.meta.url);
const { getPreview } = (require('spotify-url-info') as SpotifyUrlInfoModule)(fetch);

/** A Spotify track link, parsed. */
export interface SpotifyLink {
  type: 'track';
  id: string;
}

/** What getTrack reads from a track's page. */
export interface SpotifyTrack {
  name: string;
  /** "Title - Artist" */
  title: string;
  artist: string;
  thumbnail: string | null;
  duration: number;
  searchQuery: string;
}

export function parseSpotifyUrl(url: unknown): SpotifyLink | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'open.spotify.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Shared links often carry a locale first: /intl-tr/track/<id>
    if (parts.length && /^intl-[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(parts[0])) parts.shift();
    if (parts.length < 2) return null;
    const type = parts[0];
    const id = parts[1];
    if (type === 'track' && id) return { type: 'track', id };
    return null;
  } catch {
    return null;
  }
}

export async function getTrack(url: string): Promise<SpotifyTrack> {
  const data = await getPreview(url);
  const title = data.title || 'Unknown';
  const artist = data.artist || 'Unknown Artist';
  return {
    name: title,
    title: `${title} - ${artist}`,
    artist,
    thumbnail: data.image || null,
    duration: 0,
    searchQuery: `${title} ${artist}`
  };
}
