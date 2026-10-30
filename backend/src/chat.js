/**
 * The one global chat. Every signed-in user (approved or still pending) can
 * read and write; messages are kept forever and read newest-first in pages
 * with keyset pagination on the message id (never OFFSET).
 *
 * Two stores with the same async interface: Postgres (global_chat_messages,
 * see db.js) and an in-memory fallback used when there is no database, like
 * the other modules. Message text is stored as plain text; clients render it
 * escaped (frontend/chat-format.js), so nothing here produces HTML.
 *
 *   store.add({ userId, author: { name, emoji, avatarUrl }, text, createdAt }) -> message
 *   store.page({ before, limit }) -> { messages (oldest first), hasMore }
 *   store.remove(id) -> boolean
 *
 * A message: { id (number), userId, authorName, authorEmoji, authorAvatar, text, createdAt (ms) }.
 * With Postgres the author's name/avatar come from the users table at read
 * time (so renames show up); author_name is a snapshot kept as a fallback.
 */

const MAX_LENGTH = 1000;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// Control characters (except tab/newline) and bidi overrides, which could be
// used to make a message look like something else.
const STRIP_RE = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g;

/**
 * Clean up a message from a client. Returns { text } or { error }.
 */
function normalizeText(raw) {
  if (typeof raw !== 'string') return { error: 'Message must be text' };
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(STRIP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return { error: 'Message is empty' };
  if (text.length > MAX_LENGTH) return { error: `Message is too long (max ${MAX_LENGTH} characters)` };
  return { text };
}

function clampLimit(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

// A keyset cursor: the id of the oldest message the client already has.
function parseCursor(before) {
  if (before === undefined || before === null || before === '') return null;
  const n = Number(before);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Sliding-window limiter keyed by user: at most `limit` hits per `windowMs`.
 * Keyed per user (not per socket) so several tabs share one budget.
 */
function createRateLimiter({ limit = 5, windowMs = 10_000, now = Date.now } = {}) {
  const hits = new Map(); // key -> timestamps (ascending)
  return {
    hit(key) {
      const t = now();
      const list = (hits.get(key) || []).filter(ts => t - ts < windowMs);
      if (list.length >= limit) { hits.set(key, list); return false; }
      list.push(t);
      hits.set(key, list);
      return true;
    },
    reset(key) { hits.delete(key); },
  };
}

function createMemoryStore() {
  const messages = []; // ascending by id
  let nextId = 1;
  return {
    kind: 'memory',
    async add({ userId, author = {}, text, createdAt = Date.now() }) {
      const msg = {
        id: nextId++,
        userId,
        authorName: author.name || 'User',
        authorEmoji: author.emoji || null,
        authorAvatar: author.avatarUrl || null,
        text,
        createdAt,
      };
      messages.push(msg);
      return { ...msg };
    },
    async page({ before, limit } = {}) {
      const n = clampLimit(limit);
      const cursor = parseCursor(before);
      let end = messages.length;
      if (cursor !== null) {
        // messages are sorted by id: find the first index with id >= cursor
        let lo = 0; let hi = messages.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (messages[mid].id < cursor) lo = mid + 1; else hi = mid; }
        end = lo;
      }
      const start = Math.max(0, end - n);
      return { messages: messages.slice(start, end).map(m => ({ ...m })), hasMore: start > 0 };
    },
    async remove(id) {
      const n = Number(id);
      const i = messages.findIndex(m => m.id === n);
      if (i < 0) return false;
      messages.splice(i, 1);
      return true;
    },
  };
}

function rowToMessage(r) {
  return {
    id: Number(r.id),
    userId: r.user_id || null,
    authorName: r.current_name || r.author_name || 'User',
    authorEmoji: r.emoji || null,
    authorAvatar: r.avatar_url || null,
    text: r.body,
    createdAt: Number(r.created_at),
  };
}

const SELECT_MESSAGES = `
  SELECT m.id, m.user_id, m.author_name, m.body, m.created_at,
         COALESCE(u.display_name, u.name, u.username) AS current_name, u.emoji, u.avatar_url
  FROM global_chat_messages m
  LEFT JOIN users u ON u.id = m.user_id`;

function createPgStore(db) {
  return {
    kind: 'postgres',
    async add({ userId, author = {}, text, createdAt = Date.now() }) {
      const ins = await db.query(
        `INSERT INTO global_chat_messages (user_id, author_name, body, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, author.name || null, text, createdAt]
      );
      const r = await db.query(`${SELECT_MESSAGES} WHERE m.id = $1`, [ins.rows[0].id]);
      return rowToMessage(r.rows[0]);
    },
    async page({ before, limit } = {}) {
      const n = clampLimit(limit);
      const cursor = parseCursor(before);
      const params = [n + 1];
      let where = '';
      if (cursor !== null) { params.push(cursor); where = 'WHERE m.id < $2'; }
      const r = await db.query(`${SELECT_MESSAGES} ${where} ORDER BY m.id DESC LIMIT $1`, params);
      const hasMore = r.rows.length > n;
      const rows = r.rows.slice(0, n).reverse();
      return { messages: rows.map(rowToMessage), hasMore };
    },
    async remove(id) {
      const n = parseCursor(id);
      if (n === null) return false;
      const r = await db.query('DELETE FROM global_chat_messages WHERE id = $1', [n]);
      return r.rowCount > 0;
    },
  };
}

module.exports = {
  MAX_LENGTH,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizeText,
  parseCursor,
  createRateLimiter,
  createMemoryStore,
  createPgStore,
};
