// What the stats strip on a playlist says (pure, no DOM; queue.js renders it,
// playlist-stats.test.ts tests it). Only from what the entries really
// carry: a value nothing supports is left out rather than guessed.
import { addedByLabel } from '../queue/queue-format.ts';
import type { QueueEntry } from '../../shared/types.ts';

/** What the stats read from a queue entry; any of it may be missing. */
export interface StatsSong {
  duration?: QueueEntry['duration'] | null;
  artistName?: QueueEntry['artistName'];
  addedBy?: QueueEntry['addedBy'] | null;
}

/** A name and how many songs carry it. */
export interface NameCount {
  name: string;
  count: number;
}

export interface PlaylistStats {
  songs: number;
  totalSeconds: number;
  timed: number;
  lengthKnown: boolean;
  lengthPartial: boolean;
  artists: number;
  topArtist: NameCount | null;
  topAdder: NameCount | null;
}

export interface LengthParts {
  hours: number;
  minutes: number;
  seconds: number;
}

// Names are compared without case, Turkish letters kept apart from their plain
// lookalikes (Ayşe is not Ayse). Trailing spaces do not make a new artist.
const nameKey = (name: string): string => name.trim().toLocaleLowerCase('tr');

// Most frequent name, the first one reached in playlist order on a tie, shown
// with the spelling it first appeared in.
function tally(names: (string | null | undefined)[]): { distinct: number; top: NameCount | null } {
  const counts = new Map<string, NameCount>();
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = nameKey(name);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { name, count: 1 });
  }
  let top: NameCount | null = null;
  for (const entry of counts.values()) if (!top || entry.count > top.count) top = entry;
  return { distinct: counts.size, top };
}

export function playlistStats(songs: readonly (StatsSong | null | undefined)[] | null | undefined): PlaylistStats {
  const list = Array.isArray(songs) ? songs : [];
  let totalSeconds = 0;
  let timed = 0;
  for (const song of list) {
    const seconds = Number(song && song.duration);
    if (Number.isFinite(seconds) && seconds > 0) { totalSeconds += seconds; timed++; }
  }
  const artists = tally(list.map((s) => s && s.artistName));
  const adders = tally(list.map((s) => s && addedByLabel(s.addedBy)));
  return {
    songs: list.length,
    totalSeconds,
    timed,                                     // songs whose length is known
    lengthKnown: list.length === 0 || timed > 0,
    lengthPartial: timed > 0 && timed < list.length,
    artists: artists.distinct,
    // "Top" needs a contest: at least two names, and a name that appears more than once.
    // (Two names or more means there is a top.)
    topArtist: artists.distinct >= 2 && (artists.top as NameCount).count >= 2 ? artists.top : null,
    topAdder: adders.distinct >= 2 && (adders.top as NameCount).count >= 2 ? adders.top : null,
  };
}

// Split a total for display: seconds below a minute, then whole minutes (rounded),
// with hours from 60 minutes.
export function lengthParts(totalSeconds: number): LengthParts {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return { hours: 0, minutes: 0, seconds };
  const minutes = Math.round(seconds / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: 0 };
}
