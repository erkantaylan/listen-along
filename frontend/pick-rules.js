// "Pick the video" dialog: the pure rules (no DOM), unit tested in
// backend/src/pick-rules.test.js. A video is what POST /api/jobs/picks returns:
// { youtube_id, title, channel, duration_sec, in_library }.

export const isVideoId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);

export const thumbUrl = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

// Where the selection goes for a key, or null when the key is not one of ours.
export function moveIndex(index, key, count, page = 5) {
  if (!(count > 0)) return null;
  const clamp = (n) => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case 'ArrowDown': return clamp(index + 1);
    case 'ArrowUp': return clamp(index - 1);
    case 'PageDown': return clamp(index + page);
    case 'PageUp': return clamp(index - page);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

// A playlist link: every video is a pick, all ticked. `original` is the
// playlist's own video, `video` the one that will be taken (after a swap).
export function playlistItems(results) {
  return (results || []).filter((v) => v && isVideoId(v.youtube_id))
    .map((video, key) => ({ key, original: video, video, checked: true }));
}

export function toggled(items, pos) {
  return items.map((it, i) => (i === pos ? { ...it, checked: !it.checked } : it));
}

export function allChecked(items, checked) {
  return items.map((it) => ({ ...it, checked }));
}

// Swapping also ticks the item: nobody swaps a video they do not want.
export function swapped(items, pos, video) {
  if (!video || !isVideoId(video.youtube_id)) return items;
  return items.map((it, i) => (i === pos ? { ...it, video, checked: true } : it));
}

export const isSwapped = (item) => item.video.youtube_id !== item.original.youtube_id;

// The ids to send: ticked items in order, each video once.
export function chosenIds(items) {
  return [...new Set(items.filter((it) => it.checked).map((it) => it.video.youtube_id))];
}

// ticked: rows with a tick (of total rows). chosen: what is sent, so a video
// that is on two ticked rows counts once, as in chosenIds.
export function counts(items) {
  const picked = new Map();
  let ticked = 0;
  for (const it of items) {
    if (!it.checked) continue;
    ticked++;
    if (!picked.has(it.video.youtube_id)) picked.set(it.video.youtube_id, it.video);
  }
  const inLibrary = [...picked.values()].filter((v) => v.in_library).length;
  return { total: items.length, ticked, chosen: picked.size, inLibrary, toDownload: picked.size - inLibrary };
}

// What to search for when swapping an item: its own title (the playlist's).
export function swapQuery(item) {
  return String((item.original && item.original.title) || '').replace(/\s+/g, ' ').trim();
}

// The choices of a swap: the playlist's own video first, then the search
// results, then the current pick if it is neither (it cannot be: kept safe).
// selected is the row of the video the item uses now.
export function swapChoices(item, results) {
  const videos = [];
  const add = (v) => { if (v && isVideoId(v.youtube_id) && !videos.some((x) => x.youtube_id === v.youtube_id)) videos.push(v); };
  add(item.original);
  (results || []).forEach(add);
  add(item.video);
  return { videos, selected: Math.max(0, videos.findIndex((v) => v.youtube_id === item.video.youtube_id)) };
}

// The Download box: POST /api/jobs.
export function jobPayload(ids, playlistId) {
  return playlistId ? { picks: ids, playlist_id: playlistId } : { picks: ids };
}

// A playlist's add-song box: socket queue:add.
export function queuePayload(lobbyId, ids) {
  return { lobbyId, picks: ids };
}

// What the lookup's answer means for the caller: show the dialog ('pick'),
// the library has the song ('library'), the lookup did not work ('error':
// rate limited, YouTube or the network failed; status 0 = no answer), or carry
// on as without a dialog ('passthrough': the old path says what is wrong with
// the input, or it is a server from before the dialog).
export function lookupOutcome(status, body) {
  if (status === 200 && body && body.kind === 'library' && body.song) return 'library';
  if (status === 200 && body && Array.isArray(body.results)) return 'pick';
  if (!status || status === 429 || status >= 500) return 'error';
  return 'passthrough';
}
