// What a playlist row shows (pure, no DOM; queue.js renders it).
import type { QueueEntry } from '../../shared/types.ts';

/** A row's two lines: the song's own title and its artist ('' when unknown). */
export interface SongParts {
  title: string;
  artist: string;
}

// Queue titles are "Title - Artist" for library songs (the CLI and the app read
// that). With the artist known, the row shows them on two lines; without it (a
// request, an old entry) the title stays whole rather than guessing at " - ".
export function songParts({ title, artistName }: { title?: QueueEntry['title'] | null; artistName?: QueueEntry['artistName'] } = {}): SongParts {
  const full = title || '';
  const artist = artistName || '';
  const suffix = ` - ${artist}`;
  if (artist && full.endsWith(suffix) && full.length > suffix.length) return { title: full.slice(0, -suffix.length), artist };
  return { title: full, artist };
}

// "anonymous" is the placeholder old entries carry, not somebody's name.
export function addedByLabel(addedBy: QueueEntry['addedBy'] | null | undefined): string {
  const name = String(addedBy || '').trim();
  return /^anonymous$/i.test(name) ? '' : name;
}

export function addedDateLabel(addedAt: QueueEntry['addedAt'] | null | undefined, locale?: string | null): string {
  const when = Number(addedAt);
  if (!Number.isFinite(when) || when <= 0) return '';
  return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(when);
}
