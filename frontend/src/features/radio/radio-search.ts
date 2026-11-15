// Radio's search: which songs of the station order the page shows for a query.
// Pure functions (no DOM), unit tested in Node (radio-search.test.ts).
//
// The search only filters what is SHOWN. The order itself (radio-order.ts) and
// the player's queue are never touched: a song picked from the results plays
// from its place in the full shuffled order, and Radio goes on from there
// through the whole station (DESIGN.md "Radio").
//
// Matching is the sidebar's and the artist page's (foldText): every word of the
// query must appear in the title, the artist or the album; i/ı/I/İ are one
// letter and ş/ğ/ü/ö/ç match s/g/u/o/c.
import { foldText } from '../playlists/playlist-filter.ts';
import type { Track } from '../../shared/types.ts';

/** What the search reads from a song. */
export type SearchableSong = Pick<Track, 'title'> & Partial<Pick<Track, 'libraryId' | 'artist'>>;

/** The folded words of a query; none for an empty or blank one. */
export function queryWords(query: string | null | undefined): string[] {
  return foldText(query).split(' ').filter(Boolean);
}

/** The folded text a song is searched in: title, artist and album. */
export function songHaystack(song: SearchableSong, album?: string | null): string {
  return foldText(`${song.title || ''} ${song.artist || ''} ${album || ''}`);
}

/**
 * The positions in `order` the page shows for `query`, in order. Every position
 * when the query has no words. haystackOf gives a song's folded text (the page
 * caches it per song, so a keystroke over a few thousand songs stays cheap).
 */
export function matchingPositions<T extends SearchableSong>(order: readonly T[], query: string | null | undefined, haystackOf: (song: T) => string = (s) => songHaystack(s)): number[] {
  const words = queryWords(query);
  const out: number[] = [];
  for (let i = 0; i < order.length; i++) {
    if (!words.length) { out.push(i); continue; }
    const hay = haystackOf(order[i]);
    if (words.every((w) => hay.includes(w))) out.push(i);
  }
  return out;
}

/**
 * Where Play starts on the page: the first song shown (the top of the full order
 * without a search, the first result with one), or -1 when nothing is shown.
 */
export function firstShown(shown: readonly number[]): number {
  return shown.length ? shown[0] : -1;
}

/**
 * The status next to the field: nothing without a search, else how many songs
 * of the station match ("3 of 2,108 songs"; "No songs match" when none).
 */
export type SearchStatus = { kind: 'none' } | { kind: 'some'; shown: number; total: number } | { kind: 'empty'; total: number };

export function searchStatus(query: string | null | undefined, shown: number, total: number): SearchStatus {
  if (!queryWords(query).length) return { kind: 'none' };
  return shown ? { kind: 'some', shown, total } : { kind: 'empty', total };
}
