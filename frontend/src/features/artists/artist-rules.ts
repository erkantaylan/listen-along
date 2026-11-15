// Artists: the pure rules (no DOM), unit tested in artist-rules.test.ts.
// Artists come from GET /api/artists ({ key, name, count, duration_sec,
// cover_youtube_id }), most songs first; songs are player tracks (libraryId).
import { foldText } from '../playlists/playlist-filter.ts';
import type { Artist, Track } from '../../shared/types.ts';

/** Options of shelfArtists. */
export interface ShelfOptions {
  limit?: number;
  minSongs?: number;
}

export const SHELF_LIMIT = 20;
export const SHELF_MIN_SONGS = 2;

// The landing page's shelf: the artists with the most songs. An artist with a
// single song is a thin "album", so they wait for "Show all", unless nobody
// has more than one.
export function shelfArtists<A extends Pick<Artist, 'count'>>(artists: readonly A[] | null | undefined, { limit = SHELF_LIMIT, minSongs = SHELF_MIN_SONGS }: ShelfOptions = {}): A[] {
  const list = Array.isArray(artists) ? artists : [];
  const rich = list.filter((a) => a.count >= minSongs);
  return (rich.length ? rich : list).slice(0, limit);
}

// "Show all": A-Z in the Turkish alphabet, numbers as numbers.
export function sortByName<A extends Pick<Artist, 'name' | 'key'>>(artists: readonly A[]): A[] {
  return artists.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'tr', { sensitivity: 'base', numeric: true })
    || String(a.key).localeCompare(String(b.key)));
}

// Every word of the query must be in the name (Turkish-aware, accents folded).
export function filterArtists<A extends Pick<Artist, 'name'>>(artists: A[], query: string): A[] {
  const words = foldText(query).split(' ').filter(Boolean);
  if (!words.length) return artists;
  return artists.filter((a) => {
    const hay = foldText(a.name);
    return words.every((w) => hay.includes(w));
  });
}

// The library changed while an artist's list is in use: take the fresh list,
// but a song on air that left it (deleted, marked broken) stays where it was
// until the player moves on, so the place in the list is not lost.
export function keepCurrent<T extends Pick<Track, 'libraryId'>>(fresh: readonly T[], old: readonly T[], currentId: Track['libraryId'] | null): T[] {
  if (!currentId || fresh.some((s) => s.libraryId === currentId)) return fresh.slice();
  const at = old.findIndex((s) => s.libraryId === currentId);
  if (at < 0) return fresh.slice();
  const out = fresh.slice();
  out.splice(Math.min(at, out.length), 0, old[at]);
  return out;
}
