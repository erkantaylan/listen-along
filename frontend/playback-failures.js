// Songs that fail to play. The <audio> error lands here: the song is greyed in
// the lists, playback goes on to the next one, and a song that is itself broken
// is reported as "needs replacement" (an automatic report, song-reports.js).
// This module is the glue to the page: it asks the questions (the url probed
// past the cache, the file fetched whole and played from memory) and shows the
// outcome. The state and the order of things are playback-failure-flow.js, the
// decisions playback-failure-rules.js; both are tested without a browser.
//
// - Greyed is local and for this page load only (keys `library:<id>` and the
//   queue url). It clears when the song plays (a click on the row tries again),
//   when its audio is replaced, or when it reaches the library.
//   player.next / previous go past greyed songs (player.setSkip).
// - STREAK_LIMIT failures in a row stop playback with one message.
// - A report is held until another song has played, checked again then, and
//   dropped when the streak stops playback: one broken song among good ones is
//   the song; several failures and nothing playing is the network, the browser
//   or the server.
// - Listening along: the leader decides what plays and hears the same file, so
//   a follower greys the song and nothing else (listen-along.js shows its own
//   notice and waits for the next song).
import { state, elements, auth } from './state.js';
import { player } from './player.js';
import { showToast, t } from './ui.js';
import { reportsFor, resolveSongId, sendReport, unmarkBroken } from './song-reports.js';
import { STREAK_LIMIT, MEDIA_ERR_ABORTED, MEDIA_ERR_DECODE, codecQuery, trackKeys } from './playback-failure-rules.js';
import { createFailureFlow } from './playback-failure-flow.js';

const PROBE_TIMEOUT_MS = 8000;
// Checking that a file does not decode means fetching all of it: not for huge
// files, and not for ever. A song over the limit is greyed, never reported.
const CONFIRM_MAX_BYTES = 64 * 1024 * 1024;
const CONFIRM_FETCH_MS = 60000;
const CONFIRM_PLAY_MS = 15000;

const listeners = new Set();

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars = {}) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

const flow = createFailureFlow({
  online: () => navigator.onLine !== false,
  probe,
  canPlay: (mime) => {
    const query = codecQuery(mime);
    return !!query && document.createElement('audio').canPlayType(query) === 'probably';
  },
  confirm,
  // What the element really holds: after a replace that is the song's file url
  // (player.reloadReplaced), not the queue entry's stream url.
  current: () => {
    const audio = elements.audioPlayer;
    return player.track ? { keys: trackKeys(player.track), src: audio.currentSrc || audio.src } : null;
  },
  user: () => (auth.authenticated && auth.user && auth.user.id) || null,
  hasReport: (track) => reportsFor({ songId: track.libraryId, url: track.url }).length > 0,
  report: fileReport,
  changed: () => {
    for (const fn of listeners) { try { fn(); } catch (err) { console.error('playback-failures listener failed:', err); } }
  },
});

/** Lists re-render their greyed rows on this. */
export function onFailuresChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Did this song (a queue entry or a library track) fail to play here? */
export function isUnplayable(track) {
  return flow.isFailed(track);
}

/** The row badge of a greyed song ('' otherwise). The row stays the play target: a click tries again. */
export function unplayableBadgeHtml(track) {
  if (!isUnplayable(track)) return '';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<span class="badge badge-subtle theme-secondary queue-item-badge" title="${esc(t('playFail.badgeTitle', 'It could not be played here and is skipped. Click the song to try again.'))}">${esc(t('playFail.badge', 'could not play'))}</span>`;
}

/** library:updated { replaced }: the file changed, so the song is worth playing again. */
export function clearReplacedFailure(replaced) {
  if (!replaced || !replaced.id) return;
  flow.clear([`library:${replaced.id}`, ...(replaced.oldUrls || []), replaced.url].filter(Boolean), { forget: true });
}

/** download:status ready: a queue entry reached the library. */
export function clearFailureFor(url) {
  if (url) flow.clear([url]);
}

// The song's url asked again, past the browser cache: did the server answer, and with what?
// `version` names the file served (ETag, else Last-Modified + length).
async function probe(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(src, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
    const out = { status: res.status, mime: res.headers.get('Content-Type') };
    if (res.ok) {
      const modified = res.headers.get('Last-Modified');
      const length = res.headers.get('Content-Length');
      out.version = res.headers.get('ETag') || (modified && length ? `${modified}|${length}` : null);
      if (res.body) res.body.cancel().catch(() => {}); // the headers were the answer
    } else {
      const body = await res.json().catch(() => null);
      out.code = body && body.code;
    }
    return out;
  } catch {
    return { failed: true };
  } finally {
    clearTimeout(timer);
  }
}

// Every byte of the file, or null: a plain 200 whose body is exactly as long as
// the server said. Anything short of that proves nothing about the song.
async function fetchWhole(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIRM_FETCH_MS);
  try {
    const res = await fetch(src, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
    const header = res.headers.get('Content-Length');
    const length = header === null || header === '' ? NaN : Number(header);
    if (res.status !== 200 || res.headers.get('Content-Encoding') || !Number.isInteger(length) || length > CONFIRM_MAX_BYTES) {
      ctrl.abort();
      return null;
    }
    const bytes = await res.arrayBuffer();
    return bytes.byteLength === length ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Play the bytes from memory in an element of their own (muted): no request can
// fail here, so an error is the file. A file that would not open
// (MEDIA_ERR_SRC_NOT_SUPPORTED) is settled by its metadata; a decode error is
// looked for by playing over the place where it happened.
function playsFromMemory(bytes, mime, errorCode, position) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: String(mime || '').split(';')[0].trim() }));
    const el = new Audio();
    el.muted = true;
    el.preload = 'auto';
    let timer = null;
    const done = (value) => {
      clearTimeout(timer);
      el.onerror = el.onloadedmetadata = el.ontimeupdate = el.onended = null;
      el.pause();
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    // No verdict in time is no proof against the song.
    timer = setTimeout(() => done('decodes'), CONFIRM_PLAY_MS);
    const until = (Number(position) || 0) + 3;
    el.onerror = () => done(el.error && el.error.code >= MEDIA_ERR_DECODE ? 'undecodable' : 'decodes');
    el.onloadedmetadata = () => {
      if (errorCode !== MEDIA_ERR_DECODE) { done('decodes'); return; }
      try { el.currentTime = Math.max(0, (Number(position) || 0) - 2); } catch { /* plays from the start */ }
      el.play().catch(() => {});
    };
    el.ontimeupdate = () => { if (el.currentTime >= until) done('decodes'); };
    el.onended = () => done('decodes');
    el.src = url;
  });
}

async function confirm({ src, mime, errorCode, position }) {
  const bytes = await fetchWhole(src);
  if (!bytes) return 'incomplete';
  return playsFromMemory(bytes, mime, errorCode, position);
}

function failureMessage(cause, title, skipping) {
  let text;
  if (cause === 'not-in-library') text = tf('playFail.notInLibrary', '“{title}” is not in the library yet.', { title });
  else if (cause === 'unsupported') text = tf('playFail.unsupported', 'This browser cannot play “{title}”.', { title });
  else text = tf('playFail.failed', 'Could not play “{title}”.', { title });
  return skipping ? `${text} ${t('playFail.skipping', 'Skipping it.')}` : text;
}

// -> true when the server stored the report. It checks the song itself and may
// answer { reported: false, code: 'NOT_CONFIRMED' }: then nothing is said and
// the song simply stays greyed.
async function fileReport(track) {
  const songId = await resolveSongId({ songId: track.libraryId, url: track.url });
  // Not a library song (any more), or already on the list: nothing to add.
  if (!songId || reportsFor({ songId }).length) return false;
  const data = await sendReport(songId, undefined, { auto: true });
  if (!data.report || !data.report.auto) return false; // refused, or the user's own earlier report was kept
  showToast(
    tf('playFail.reported', '“{title}” could not be played and was marked as needing replacement.', { title: track.title || '' }),
    'info',
    { duration: 8000, action: { label: t('playFail.undo', 'Undo'), onClick: () => unmarkBroken(songId) } },
  );
  return true;
}

/** Logout: what was collected belongs to the account that just left. */
export function resetPlaybackFailures() {
  flow.reset();
}

// A song is sounding: it is fine. Whether everything a failed song depends on
// is fine too is asked from the server (flow.played).
function onPlaying() {
  const track = player.track;
  if (!track) return;
  const audio = elements.audioPlayer;
  flow.played({ track, src: audio.currentSrc || audio.src }).catch((err) => console.warn('Automatic report failed:', err));
}

async function onError() {
  const audio = elements.audioPlayer;
  if (!audio.getAttribute('src') || audio.src === window.location.href) return;
  const track = player.track;
  const error = audio.error;
  if (!track || !error || error.code === MEDIA_ERR_ABORTED) return;
  console.error('Audio error:', error.code, error.message);
  const driven = !!player.driver;
  const wanted = !!state.playRequested; // a song loaded paused (not asked to play) is not skipped

  const result = await flow.failure({ track, src: audio.currentSrc || audio.src, errorCode: error.code, position: audio.currentTime || 0, driven });
  if (result.stale) return; // it played, or its audio was replaced, meanwhile
  const { cause, action } = result;
  console.warn(`Playback failed (${cause}):`, track.title);
  if (driven) return;
  if (action.stop) {
    showToast(result.onlyNotInLibrary
      ? tf('playFail.stoppedNotInLibrary', 'Playback stopped: {count} songs in a row are not in the library yet.', { count: STREAK_LIMIT })
      : tf('playFail.stopped', 'Playback stopped: {count} songs in a row could not be played. Check your connection and try again.', { count: STREAK_LIMIT }), 'error', { duration: 8000 });
    return;
  }
  // Still the song on the player? (The listener may have picked another meanwhile.)
  if (player.track === track && !!audio.error && wanted && action.skip) player.next({ auto: true });
  // "Skipping it" only when something else came up (not at the end of the list).
  showToast(failureMessage(cause, track.title || '', player.track !== track), 'error');
}

/** Call once at start-up, after the player is wired. */
export function setupPlaybackFailures() {
  const audio = elements.audioPlayer;
  audio.addEventListener('error', onError);
  audio.addEventListener('playing', onPlaying);
  player.setSkip(isUnplayable);
}
