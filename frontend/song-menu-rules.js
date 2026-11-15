// The song menu's pure decisions (no DOM), unit tested in
// backend/src/song-menu-rules.test.js. song-reports.js builds the items.

/** Where a song came from: { url, host }, only ever a real http(s) link, or null. */
export function songSourceLink({ youtubeId, sourceUrl, url } = {}) {
  if (youtubeId && /^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return { url: `https://www.youtube.com/watch?v=${youtubeId}`, host: 'YouTube' };
  for (const candidate of [sourceUrl, url]) {
    try {
      const parsed = new URL(candidate);
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
export function sourceSubmenu(link) {
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
export function canRemoveFromPlaylist(row, page) {
  if (!row || row.context !== 'playlist' || !row.entryId) return false;
  if (!page || !page.canEdit || !page.lobbyId) return false;
  return page.queueLobbyId === page.lobbyId;
}
