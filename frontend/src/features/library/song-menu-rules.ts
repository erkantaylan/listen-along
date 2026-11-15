// The song menu's pure decisions (no DOM), unit tested in
// song-menu-rules.test.ts. song-reports.ts builds the items.

/** Where a song's link can come from (a player track, a library row mapped to one). */
export interface SongSourceFields {
  youtubeId?: string | null;
  sourceUrl?: string | null;
  url?: string | null;
}

/** A song's source: a real http(s) link and the host to name it by. */
export interface SourceLink {
  url: string;
  host: string;
}

export interface SourceSubmenu {
  openUrl: string;
  copyUrl: string;
  copyKey: 'songMenu.copyYoutubeLink' | 'songMenu.copyLink';
  copyFallback: string;
}

/** Where a song menu was opened. */
export type SongMenuContext = 'playlist' | 'library' | 'radio' | 'artist' | 'player';

export interface SongMenuRow {
  context: SongMenuContext;
  entryId?: string | null;
}

export interface SongMenuPage {
  lobbyId: string | null;
  queueLobbyId: string | null;
  canEdit: boolean;
}

/** Where a song came from: { url, host }, only ever a real http(s) link, or null. */
export function songSourceLink({ youtubeId, sourceUrl, url }: SongSourceFields = {}): SourceLink | null {
  if (youtubeId && /^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return { url: `https://www.youtube.com/watch?v=${youtubeId}`, host: 'YouTube' };
  for (const candidate of [sourceUrl, url]) {
    try {
      const parsed = new URL(candidate as string); // a missing one throws, as a bad one does
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      const host = parsed.hostname.replace(/^(www|m|music)\./, '');
      return { url: parsed.href, host: host === 'youtube.com' || host === 'youtu.be' ? 'YouTube' : host };
    } catch {}
  }
  return null;
}

/**
 * The "Source ▸" submenu: what it opens and copies, or null when the song has no
 * source link (then there is no Source item at all, never an empty submenu).
 * copyKey: "Copy YouTube link" for YouTube, the plain "Copy link" otherwise.
 */
export function sourceSubmenu(link: Partial<SourceLink> | null | undefined): SourceSubmenu | null {
  if (!link || !link.url) return null;
  const youtube = link.host === 'YouTube';
  return {
    openUrl: link.url,
    copyUrl: link.url,
    copyKey: youtube ? 'songMenu.copyYoutubeLink' : 'songMenu.copyLink',
    copyFallback: youtube ? 'Copy YouTube link' : 'Copy link',
  };
}

/**
 * "Remove from playlist" appears only on a row of the playlist on screen, for
 * someone who may edit it. The server checks again (queue:remove).
 * row: { context: 'playlist' | 'library' | 'radio' | 'artist' | 'player', entryId }
 * page: { lobbyId, queueLobbyId, canEdit }
 */
export function canRemoveFromPlaylist(row: SongMenuRow | null | undefined, page: SongMenuPage | null | undefined): boolean {
  if (!row || row.context !== 'playlist' || !row.entryId) return false;
  if (!page || !page.canEdit || !page.lobbyId) return false;
  return page.queueLobbyId === page.lobbyId;
}
