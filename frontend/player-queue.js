// Pure queue-navigation and lobby-membership rules for the player. No DOM,
// so they can be unit tested in Node (backend/src/player-queue.test.js).

// Previous restarts the current track instead when it has played this long.
export const RESTART_THRESHOLD = 3;

// Index of a track in a queue: by queue-entry id, then by url (a queue
// update may hand us fresh objects for the same songs).
export function findTrackIndex(queue, track) {
  if (!track || !Array.isArray(queue)) return -1;
  let i = track.id != null ? queue.findIndex(s => s && s.id === track.id) : -1;
  if (i < 0 && track.url) i = queue.findIndex(s => s && s.url === track.url);
  return i;
}

// The index to play after `current`, or -1 to stop.
//   auto: true when the track ended by itself (repeat-one only applies then;
//   a manual Next always moves on).
//   random: () => [0, 1), injectable for tests.
export function nextIndex({ length, current = -1, repeat = 'off', shuffle = false, auto = false, random = Math.random }) {
  if (!length) return -1;
  if (auto && repeat === 'one' && current >= 0 && current < length) return current;
  if (shuffle && length > 1) {
    let i;
    do { i = Math.floor(random() * length); } while (i === current);
    return i;
  }
  const next = current + 1;
  if (next < length) return next;
  return repeat === 'all' ? 0 : -1;
}

// The index to play before `current`, or -1 to restart the current track.
export function previousIndex({ length, current = -1, repeat = 'off' }) {
  if (!length) return -1;
  if (current < 0) return 0;
  if (current > 0) return current - 1;
  return repeat === 'all' ? length - 1 : -1;
}

// --- Lobby membership --------------------------------------------------------
// The server lists a socket in one lobby (member: listener list, now-playing,
// follow) and lets it watch one more (viewing: queue/chat updates, adding
// songs). The member lobby is the playback context while there is one, so the
// queue being played stays live; otherwise it is the lobby on screen. Any
// other lobby on screen is only viewed.

export function desiredMembership({ viewedLobbyId = null, contextLobbyId = null } = {}) {
  const member = contextLobbyId || viewedLobbyId || null;
  const viewing = viewedLobbyId && viewedLobbyId !== member ? viewedLobbyId : null;
  return { member, viewing };
}

// Socket events that move the server from `current` to `desired`
// ({ member, viewing } each). lobby:join leaves the old member lobby and turns
// a view of the same lobby into membership; lobby:view replaces the old view.
export function membershipActions(current, desired) {
  const actions = [];
  if (desired.member !== current.member) {
    if (desired.member) actions.push({ type: 'join', lobbyId: desired.member });
    else if (current.member) actions.push({ type: 'leave', lobbyId: current.member });
  }
  if (desired.viewing !== current.viewing) {
    if (desired.viewing) actions.push({ type: 'view', lobbyId: desired.viewing });
    else if (current.viewing && current.viewing !== desired.member) actions.push({ type: 'unview', lobbyId: current.viewing });
  }
  return actions;
}
