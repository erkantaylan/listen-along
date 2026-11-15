// Videos chosen in the web's pick dialog (features/picker): a list of YouTube
// ids that arrives on POST /api/jobs (core/jobs) and socket queue:add (core/queue),
// where the resolver turns each into a library song or a request.
import { library } from '../library/index.ts';

/** At most this many videos are offered from a playlist, and taken in one go. */
export const MAX_PICKS = 100;

/** A chosen-videos list from a client: distinct ids, or null when it is not one. */
export function cleanPicks(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PICKS) return null;
  if (!value.every(library.isYoutubeId)) return null;
  return [...new Set(value as string[])];
}
