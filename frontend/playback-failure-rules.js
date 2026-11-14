// What to do when a song fails to play: pure rules, no DOM (tested in
// backend/src/playback-failure-rules.test.js). playback-failures.js gathers the
// facts (the <audio> error, a probe of the song's url, what this browser can
// decode) and acts on the answer; playback-failure-flow.js keeps the state.
//
// A failed song is greyed in the lists and skipped; that is local and lasts
// until it plays, its audio is replaced or the page is reloaded. Filing a
// "needs replacement" report takes the song out of Radio and the artist pages
// for everyone, so that happens only when the song itself is at fault.

// This many failures in a row stop playback instead of skipping on.
export const STREAK_LIMIT = 3;

// MediaError.code
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// What the url is asked with canPlayType for each stored format (the library
// holds AAC in m4a and Opus in Ogg; Safari may not decode the second).
const CODECS = {
  'audio/mp4': 'audio/mp4; codecs="mp4a.40.2"',
  'audio/ogg': 'audio/ogg; codecs="opus"',
};

/** The canPlayType question for a Content-Type header, or null for a type the library does not hold. */
export function codecQuery(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  return CODECS[mime] || null;
}

/**
 * Why a song failed.
 *   online:    navigator.onLine
 *   errorCode: MediaError.code of the <audio> error
 *   probe:     the same url asked again, past the browser cache:
 *              null / { failed: true } (no answer), or { status, code?, mime?, version? }
 *              (`code` from the server's JSON error body)
 *   canPlay:   canPlayType(codecQuery(probe.mime)) === 'probably'
 *   bytes:     a media error alone never blames the song: browsers raise
 *              MEDIA_ERR_SRC_NOT_SUPPORTED for a failed request and
 *              MEDIA_ERR_DECODE for a lost output device or a file that changed
 *              under the url. So the whole file is fetched again and played
 *              from memory, with no network in between:
 *              'undecodable' (every byte arrived, and they do not decode),
 *              'decodes' (they play: the failure was something else),
 *              'incomplete' / null (the bytes could not be fetched whole, or
 *              the file is too big to check)
 * @returns {'offline'|'network'|'session'|'server'|'not-in-library'|'gone'|'missing'|'unsupported'|'undecodable'|'unknown'}
 */
export function failureCause({ online = true, errorCode = 0, probe = null, canPlay = false, bytes = null } = {}) {
  if (online === false) return 'offline';
  if (!probe || probe.failed || !probe.status) return 'network';
  const { status, code } = probe;
  if (status === 401 || status === 403) return 'session';
  if (status >= 500 || status === 429 || status === 408) return 'server';
  if (status === 404 || status === 410) {
    if (code === 'STORAGE_UNAVAILABLE') return 'server';  // the server's storage is not there: not its songs
    if (code === 'FILE_MISSING') return 'missing';        // the song exists, its file does not
    if (code === 'NOT_IN_LIBRARY') return 'not-in-library'; // a request nobody uploaded yet
    if (code === 'NOT_FOUND' || status === 410) return 'gone'; // the song was deleted
    return 'unknown';                                     // a 404 that is not this server's
  }
  if (status < 200 || status >= 300) return 'unknown';
  // The file is there and was served.
  if (errorCode === MEDIA_ERR_NETWORK) return 'network';
  if (errorCode !== MEDIA_ERR_DECODE && errorCode !== MEDIA_ERR_SRC_NOT_SUPPORTED) return 'unknown';
  if (!canPlay) return 'unsupported';
  if (bytes === 'undecodable') return 'undecodable';
  return bytes === 'decodes' ? 'unknown' : 'network';
}

/**
 * Does a held report still stand, asked again just before it is sent?
 *   missing:     the server still says the file is missing
 *   undecodable: the same file is still served (`version`: its ETag, or
 *                Last-Modified + length; unknown on either side = no)
 */
export function sameFault(cause, version, probe) {
  if (!probe || probe.failed || !probe.status) return false;
  if (cause === 'missing') return probe.status === 404 && probe.code === 'FILE_MISSING';
  if (cause === 'undecodable') return probe.status >= 200 && probe.status < 300 && !!version && probe.version === version;
  return false;
}

/** A song's file answered from the server right now (the control before a report is sent). */
export function isServed(probe) {
  return !!probe && !probe.failed && probe.status >= 200 && probe.status < 300;
}

/** Causes where the song itself needs replacing. */
export function isSongFault(cause) {
  return cause === 'missing' || cause === 'undecodable';
}

/**
 * What follows from a failure.
 *   streak:   failures in a row, this one included (a song that plays resets it)
 *   driven:   a driver steers playback (listening along): the leader decides
 *             what plays, and hears the same file, so nothing is skipped or
 *             reported from here
 *   tried:    this song was already put up for a report in this session
 *   reported: the song has an open report already (anyone's)
 * @returns {{ grey: boolean, skip: boolean, stop: boolean, report: boolean }}
 *   report: put the song up for an automatic report. It is HELD until another
 *   song plays (see settleReports) and is then checked once more
 *   (playback-failure-flow.js): only that shows this browser, the network and
 *   the server's storage are fine.
 */
export function failureAction({ cause, streak = 1, driven = false, tried = false, reported = false } = {}) {
  const stop = !driven && streak >= STREAK_LIMIT;
  return {
    grey: true,
    skip: !driven && !stop,
    stop,
    report: isSongFault(cause) && !driven && !stop && !tried && !reported,
  };
}

/**
 * Held reports ({ keys } each, see trackKeys) once the outcome is known.
 *   event 'played': a song played, so the held ones are sent, except that song
 *   itself (it plays after all).
 *   event 'stopped': the streak limit was reached; so many failures at once
 *   point at the network, the browser or the server, not at the songs: drop all.
 * @returns {{ send: object[], held: object[] }}
 */
export function settleReports(held, event, playedKeys = []) {
  if (event === 'stopped') return { send: [], held: [] };
  if (event !== 'played') return { send: [], held: [...held] };
  const played = new Set(playedKeys);
  return { send: held.filter((item) => !item.keys.some((key) => played.has(key))), held: [] };
}

/** The keys a track can be greyed under: its library id and its queue url. */
export function trackKeys(track) {
  if (!track) return [];
  const keys = [];
  if (track.libraryId) keys.push(`library:${track.libraryId}`);
  if (track.url && !keys.includes(track.url)) keys.push(track.url);
  return keys;
}
