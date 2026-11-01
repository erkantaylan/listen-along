// What a playlist row shows (pure, no DOM; queue.js renders it).

// Queue titles are "Title - Artist" for library songs (the CLI and the app read
// that). With the artist known, the row shows them on two lines; without it (a
// request, an old entry) the title stays whole rather than guessing at " - ".
export function songParts({ title, artistName } = {}) {
  const full = title || '';
  const artist = artistName || '';
  const suffix = ` - ${artist}`;
  if (artist && full.endsWith(suffix) && full.length > suffix.length) return { title: full.slice(0, -suffix.length), artist };
  return { title: full, artist };
}

// "anonymous" is the placeholder old entries carry, not somebody's name.
export function addedByLabel(addedBy) {
  const name = String(addedBy || '').trim();
  return /^anonymous$/i.test(name) ? '' : name;
}

export function addedDateLabel(addedAt, locale) {
  const when = Number(addedAt);
  if (!Number.isFinite(when) || when <= 0) return '';
  return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(when);
}
