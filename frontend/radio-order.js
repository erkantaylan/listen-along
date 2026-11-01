// The order of Radio songs. Pure functions (no DOM), unit tested in Node
// (backend/src/radio-order.test.js). The order lives in the browser: every
// listener and every opening gets their own shuffle, and the server stays out.
//
// Items are player tracks; `libraryId` is what identifies a song.

// Fisher-Yates. random: () => [0, 1), injectable for tests.
export function shuffled(items, random = Math.random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The next round when the list ran out: a new shuffle that does not start with
// the song that just ended, so no song plays twice in a row.
export function nextRound(items, lastId, random = Math.random) {
  const out = shuffled(items, random);
  if (out.length > 1 && out[0].libraryId === lastId) {
    const j = 1 + Math.floor(random() * (out.length - 1));
    [out[0], out[j]] = [out[j], out[0]];
  }
  return out;
}

// "Reshuffle" while a song is playing: that song stays on top, the rest moves.
export function reshuffledAround(items, currentId, random = Math.random) {
  const current = items.find((s) => s.libraryId === currentId);
  const rest = shuffled(items.filter((s) => s !== current), random);
  return current ? [current, ...rest] : rest;
}

// Bring an order in line with what the station holds now, keeping the order the
// listener sees. A song that left goes away (the one playing stays until the
// player moves on: it marks the place in the list). A song that came back or is
// new lands at a random place after the current one, so it is heard this round
// and nothing already played comes again.
export function reconcile(order, fresh, currentId = null, random = Math.random) {
  const freshById = new Map(fresh.map((s) => [s.libraryId, s]));
  const kept = [];
  for (const s of order) {
    if (freshById.has(s.libraryId)) kept.push(freshById.get(s.libraryId));
    else if (s.libraryId === currentId) kept.push(s);
  }
  const known = new Set(order.map((s) => s.libraryId));
  const firstFree = kept.findIndex((s) => s.libraryId === currentId) + 1;
  for (const s of fresh) {
    if (known.has(s.libraryId)) continue;
    const at = firstFree + Math.floor(random() * (kept.length - firstFree + 1));
    kept.splice(at, 0, s);
  }
  return kept;
}
