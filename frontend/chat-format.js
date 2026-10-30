// Pure helpers for the global chat and people panel (social.js). No DOM, so
// they are unit tested in Node (backend/src/social.test.js).

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeText(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// http(s) links only; trailing punctuation is not part of the link.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_RE = /[.,;:!?)\]}]+$/;

// A chat message as safe HTML: everything escaped, http(s) URLs turned into
// links that open in a new tab without a referrer or opener, newlines kept by
// CSS (white-space: pre-wrap), not by <br>.
export function formatMessageHtml(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(TRAILING_RE);
    if (trail) url = url.slice(0, -trail[0].length);
    if (!url) continue;
    let href;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      href = u.href;
    } catch { continue; }
    out += escapeText(s.slice(last, m.index));
    out += `<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeText(s.slice(last));
}

// "just now", "5m ago", "3h ago", "2d ago", then a date.
export function formatLastSeen(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Time of a chat message: "14:05" today, else "3 Mar 14:05".
export function formatMessageTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

// Online people first (playing before idle, then by name), offline people by
// most recently seen. Returns { online: [], offline: [] }.
export function groupPeople(people) {
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  const online = people.filter(p => p.online).sort((a, b) => (!!b.nowPlaying - !!a.nowPlaying) || byName(a, b));
  const offline = people.filter(p => !p.online).sort((a, b) => ((b.lastSeen || 0) - (a.lastSeen || 0)) || byName(a, b));
  return { online, offline };
}

// Merge a server list update into a list of messages (ascending ids, unique).
export function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
