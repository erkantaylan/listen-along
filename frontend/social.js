// The global chat and the people panel (markup: #social-panel in index.html;
// server: backend/src/social.js). One panel, two layouts:
//   desktop (>= 1024px): a right-hand sidebar on every signed-in page,
//     collapsible (remembered per browser);
//   phones / narrow: a full-screen "Social" view at /social (router.js),
//     opened from the chat button in the player bar (or on the pending card).
// The player bar's chat button carries the unread badge.
//
// This module also reports what this browser plays (player.js events) as
// presence:now-playing; the server keeps one entry per user.
import { formatMessageHtml, formatLastSeen, formatMessageTime, groupPeople, mergeMessages, escapeText } from './chat-format.js';
import { player } from './player.js';
import { storageGet, storageSet } from './state.js';
import { navigateTo, showToast, t } from './ui.js';

const DESKTOP = '(min-width: 1024px)';
const COLLAPSED_KEY = 'listen-socialCollapsed';
const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 80;

const S = {
  socket: null,
  me: null,
  isAdmin: false,
  people: new Map(),
  messages: [],
  hasMore: false,
  loadingOlder: false,
  historyLoaded: false,
  tab: 'chat',
  route: false,
  unread: 0,
  cameFromApp: false,
  hooks: { listenAlong: null, isListeningWith: () => false, stopListening: null },
};

const $ = (id) => document.getElementById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const isDesktop = () => window.matchMedia(DESKTOP).matches;
const collapsed = () => document.body.classList.contains('social-collapsed');

// ------------------------------------------------------------- visibility

function panelVisible() {
  if (!document.body.classList.contains('has-social')) return false;
  return isDesktop() ? !collapsed() : S.route;
}

function chatVisible() {
  return panelVisible() && S.tab === 'chat' && document.visibilityState === 'visible';
}

function setUnread(n) {
  S.unread = n;
  const label = n > 99 ? '99+' : String(n);
  for (const el of document.querySelectorAll('[data-social-unread]')) {
    el.textContent = label;
    el.hidden = n === 0;
  }
  const toggle = $('social-toggle');
  if (toggle) {
    const base = t('social.open', 'Chat and people');
    toggle.setAttribute('aria-label', n ? `${base} (${n} unread)` : base);
  }
}

function refreshVisibility() {
  const toggle = $('social-toggle');
  if (toggle) toggle.classList.toggle('active', panelVisible());
  if (chatVisible()) {
    if (S.unread) setUnread(0);
    if (S.tab === 'chat') scrollChatToBottom(false);
  }
}

function setCollapsed(value) {
  document.body.classList.toggle('social-collapsed', value);
  storageSet(COLLAPSED_KEY, value ? '1' : '0');
  const btn = $('social-collapse');
  if (btn) btn.setAttribute('aria-expanded', String(!value));
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

function selectTab(tab) {
  S.tab = tab === 'people' ? 'people' : 'chat';
  for (const b of document.querySelectorAll('[data-social-tab]')) {
    const on = b.dataset.socialTab === S.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('social-chat').hidden = S.tab !== 'chat';
  $('social-people').hidden = S.tab !== 'people';
  refreshVisibility();
  if (S.tab === 'chat') scrollChatToBottom(false);
}

// The /social route (router.js). On phones it is the full-screen Social
// view; on desktop it just makes sure the sidebar is open.
export function applySocialRoute(active, { fromApp = false } = {}) {
  S.route = !!active;
  if (active && fromApp) S.cameFromApp = true;
  document.body.classList.toggle('social-route', S.route);
  if (S.route && isDesktop() && collapsed()) setCollapsed(false);
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

function leaveRoute() {
  if (S.cameFromApp && window.history.length > 1) { S.cameFromApp = false; window.history.back(); }
  else navigateTo('/');
}

// Chat button (player bar / pending card): sidebar on desktop, view on phones.
export function toggleSocial() {
  if (isDesktop()) { setCollapsed(!collapsed()); return; }
  if (S.route) leaveRoute();
  else { S.cameFromApp = true; navigateTo('/social'); }
}

// ------------------------------------------------------------------ chat

function chatScroller() { return $('chat-scroll'); }

function nearBottom() {
  const el = chatScroller();
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

function scrollChatToBottom(smooth = false) {
  const el = chatScroller();
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function avatarHtml(p, cls) {
  const name = p.name || p.authorName || '?';
  const url = p.avatarUrl || p.authorAvatar;
  const emoji = p.emoji || p.authorEmoji;
  if (url && /^https:\/\//i.test(url)) {
    return `<span class="social-avatar ${cls}"><img src="${escapeText(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  if (emoji) return `<span class="social-avatar ${cls} is-emoji" aria-hidden="true">${escapeText(emoji)}</span>`;
  const initials = name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
  return `<span class="social-avatar ${cls}" aria-hidden="true">${escapeText(initials)}</span>`;
}

const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function messageHtml(m, prev) {
  const grouped = prev && prev.userId === m.userId && m.userId && m.createdAt - prev.createdAt < GROUP_GAP_MS;
  const del = S.isAdmin
    ? `<button class="btn-text theme-danger btn-icon btn-xs chat-delete" type="button" data-delete-id="${m.id}" aria-label="${escapeText(t('chat.delete', 'Delete message'))}" title="${escapeText(t('chat.delete', 'Delete message'))}">${TRASH_SVG}</button>`
    : '';
  const time = new Date(m.createdAt);
  const timeHtml = `<time class="fs-xs fg-4 chat-time" datetime="${time.toISOString()}" title="${escapeText(time.toLocaleString())}">${escapeText(formatMessageTime(m.createdAt))}</time>`;
  const head = grouped ? '' : `<div class="d-flex align-items-baseline gap-2 min-w-0"><span class="fw-semibold text-truncate chat-author">${escapeText(m.authorName || 'User')}</span>${timeHtml}</div>`;
  return `<li class="chat-message${grouped ? ' is-grouped' : ''}${m.userId === S.me ? ' is-own' : ''}" data-id="${m.id}">`
    + (grouped ? '<span class="chat-avatar-spacer" aria-hidden="true"></span>' : avatarHtml(m, 'chat-avatar'))
    + `<div class="chat-body min-w-0">${head}<div class="chat-text">${formatMessageHtml(m.text)}</div></div>${del}</li>`;
}

function renderMessages({ keepScroll = false, stickToBottom = false } = {}) {
  const list = $('chat-list');
  const el = chatScroller();
  if (!list || !el) return;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  if (!S.messages.length) {
    list.innerHTML = `<li class="app-empty chat-empty">${escapeText(S.historyLoaded ? t('chat.empty', 'No messages yet. Say hi!') : t('chat.loading', 'Loading…'))}</li>`;
  } else {
    list.innerHTML = S.messages.map((m, i) => messageHtml(m, S.messages[i - 1])).join('');
  }
  const older = $('chat-older');
  if (older) {
    older.hidden = !S.hasMore && !S.loadingOlder;
    older.textContent = S.loadingOlder ? t('chat.loadingOlder', 'Loading older messages…') : t('chat.olderHint', 'Scroll up for older messages');
  }
  if (keepScroll) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
  else if (stickToBottom) scrollChatToBottom(false);
}

async function loadHistory() {
  const res = await ask('chat:history', {});
  if (!res || res.error) { if (res && res.error) showToast(res.error, 'error'); return; }
  S.messages = mergeMessages([], res.messages || []);
  S.hasMore = !!res.hasMore;
  S.historyLoaded = true;
  renderMessages({ stickToBottom: true });
}

async function loadOlder() {
  if (S.loadingOlder || !S.hasMore || !S.messages.length) return;
  S.loadingOlder = true;
  renderMessages({ keepScroll: true });
  const res = await ask('chat:history', { before: S.messages[0].id });
  S.loadingOlder = false;
  if (res && !res.error) {
    S.messages = mergeMessages(S.messages, res.messages || []);
    S.hasMore = !!res.hasMore;
  }
  renderMessages({ keepScroll: true });
}

function onMessage(m) {
  const stick = nearBottom() || m.userId === S.me;
  S.messages = mergeMessages(S.messages, [m]);
  renderMessages({ keepScroll: !stick, stickToBottom: stick });
  if (m.userId !== S.me && !chatVisible()) setUnread(S.unread + 1);
}

function onDeleted({ id }) {
  const before = S.messages.length;
  S.messages = S.messages.filter(m => m.id !== id);
  if (S.messages.length !== before) renderMessages({ keepScroll: true });
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const btn = $('chat-send');
  btn.disabled = true;
  const res = await ask('chat:send', { text });
  btn.disabled = false;
  if (!res || res.error) { showToast((res && res.error) || t('chat.sendFailed', 'Could not send the message'), 'error'); return; }
  input.value = '';
  input.focus();
}

async function deleteMessage(id) {
  if (!window.confirm(t('chat.confirmDelete', 'Delete this message for everyone?'))) return;
  const res = await ask('chat:delete', { id });
  if (!res || res.error) showToast((res && res.error) || 'Could not delete', 'error');
}

// ---------------------------------------------------------------- people

const LISTEN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg>';

function contextLabel(np) {
  const c = np && np.context;
  if (!c) return '';
  if (c.type === 'library') return t('player.fromLibrary', 'Music Library');
  return c.name || t('social.aPlaylist', 'a playlist');
}

function personHtml(p) {
  const np = p.online ? p.nowPlaying : null;
  const isMe = p.id === S.me;
  let line = '';
  if (np) {
    const song = [np.track.title, np.track.artist].filter(Boolean).join(' — ');
    const where = contextLabel(np);
    line = `<span class="d-block fs-xs text-truncate person-playing${np.playing ? '' : ' is-paused'}" title="${escapeText(song + (where ? ` · ${where}` : ''))}">`
      + `<svg class="icon-sm" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${np.playing ? '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>' : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'}</svg> `
      + `${escapeText(song)}${where ? `<span class="fg-4"> · ${escapeText(where)}</span>` : ''}</span>`;
  } else if (!p.online) {
    const seen = formatLastSeen(p.lastSeen);
    line = `<span class="d-block fs-xs fg-4 text-truncate">${escapeText(seen ? tf('social.lastSeen', 'Last seen {when}', { when: seen }) : t('social.offline', 'Offline'))}</span>`;
  }
  // Listen along with anyone online who is playing something (whatever it
  // is played from; a private playlist stays hidden, only the song shows).
  let listen = '';
  if (!isMe && np && S.hooks.listenAlong) {
    const on = S.hooks.isListeningWith(p);
    const label = on ? t('listen.stop', 'Stop listening along') : t('listen.listenAlong', 'Listen along');
    listen = `<button class="btn-text theme-secondary btn-icon btn-sm person-listen${on ? ' active' : ''}" type="button" data-listen-id="${escapeText(p.id)}" aria-pressed="${on}" aria-label="${escapeText(on ? label : tf('listen.listenAlongWith', 'Listen along with {name}', { name: p.name || 'User' }))}" title="${escapeText(label)}">${LISTEN_SVG}</button>`;
  }
  const badges = (isMe ? `<span class="badge badge-subtle theme-secondary">${escapeText(t('social.you', 'you'))}</span>` : '')
    + (p.pending ? `<span class="badge badge-subtle theme-warning">${escapeText(t('social.pending', 'pending'))}</span>` : '');
  return `<li class="list-group-item person${p.online ? ' is-online' : ''}" data-person-id="${escapeText(p.id)}">`
    + `<span class="person-avatar-wrap">${avatarHtml(p, 'person-avatar')}<span class="person-dot" aria-hidden="true"></span></span>`
    + `<span class="min-w-0 flex-grow-1"><span class="d-flex align-items-center gap-1 min-w-0"><span class="text-truncate fw-medium person-name">${escapeText(p.name || 'User')}</span>${badges}</span>${line}</span>`
    + `${listen}</li>`;
}

function renderPeople() {
  const { online, offline } = groupPeople([...S.people.values()]);
  const on = $('people-online');
  const off = $('people-offline');
  if (!on || !off) return;
  on.innerHTML = online.length ? online.map(personHtml).join('') : `<li class="list-group-item app-empty">${escapeText(t('social.nobodyOnline', 'Nobody is online'))}</li>`;
  off.innerHTML = offline.length ? offline.map(personHtml).join('') : `<li class="list-group-item app-empty">${escapeText(t('social.nobodyOffline', 'Everyone is online'))}</li>`;
  $('people-online-count').textContent = String(online.length);
  $('people-offline-count').textContent = String(offline.length);
  for (const el of document.querySelectorAll('[data-online-count]')) el.textContent = String(online.length);
}

// Re-render (e.g. the listen-along state changed).
export function refreshPeople() { renderPeople(); }

function upsertPerson(user) {
  if (!user || !user.id) return;
  const prev = S.people.get(user.id) || {};
  const next = { ...prev, ...user };
  if (user.nowPlaying === undefined) next.nowPlaying = prev.nowPlaying || null;
  if (!next.online) next.nowPlaying = null;
  S.people.set(user.id, next);
  renderPeople();
}

async function loadPeople() {
  const res = await ask('people:list');
  if (!res || res.error) return;
  S.me = res.me;
  const wasAdmin = S.isAdmin;
  S.isAdmin = !!res.isAdmin;
  S.people = new Map(res.people.map(p => [p.id, p]));
  renderPeople();
  if (wasAdmin !== S.isAdmin) renderMessages({ keepScroll: true });
}

// ---------------------------------------------------------- now playing

let reportTimer = null;
// Also the listen-along heartbeat (listen-along.js) while someone listens along.
export function reportNowPlaying() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    if (!S.socket || !S.socket.connected) return;
    const tr = player.track;
    const ctx = player.context;
    S.socket.emit('presence:now-playing', tr ? {
      track: { id: tr.id || null, title: tr.title, artist: tr.artist || null, thumbnail: tr.thumbnail || null, url: tr.url || null },
      context: ctx ? (ctx.type === 'library' ? { type: 'library' } : { type: 'lobby', lobbyId: ctx.lobbyId }) : null,
      playing: player.isPlaying,
      position: player.currentTime,
      duration: player.duration,
    } : { track: null });
  }, 250);
}

// ----------------------------------------------------------------- setup

function ask(event, arg) {
  return new Promise((resolve) => {
    if (!S.socket) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 10000);
    S.socket.emit(event, arg, (res) => { clearTimeout(timer); resolve(res); });
  });
}

// Profile shown to others when the server has no database (it then has no
// users table to read names from).
export function announceProfile(name, emoji) {
  if (S.socket && name) S.socket.emit('social:hello', { name, emoji });
}

/**
 * Start the chat + people panel on a connected-or-connecting socket.
 * opts: { name, emoji, reportPlayback, listenAlong(person), isListeningWith(person), stopListening() }
 */
export function setupSocial(socket, opts = {}) {
  S.socket = socket;
  S.hooks.listenAlong = opts.listenAlong || null;
  if (opts.isListeningWith) S.hooks.isListeningWith = opts.isListeningWith;
  S.hooks.stopListening = opts.stopListening || null;
  document.body.classList.add('has-social');
  const toggle = $('social-toggle');
  if (toggle) toggle.hidden = false;
  if (storageGet(COLLAPSED_KEY) === '1') document.body.classList.add('social-collapsed');
  $('social-collapse')?.setAttribute('aria-expanded', String(!collapsed()));

  const start = () => {
    announceProfile(opts.name, opts.emoji);
    loadPeople();
    loadHistory();
    if (opts.reportPlayback) reportNowPlaying();
  };
  socket.on('connect', start);
  if (socket.connected) start();

  socket.on('chat:message', onMessage);
  socket.on('chat:deleted', onDeleted);
  socket.on('people:presence', ({ user }) => upsertPerson(user));
  socket.on('people:user', ({ user }) => upsertPerson(user));
  socket.on('people:removed', ({ userId }) => { S.people.delete(userId); renderPeople(); });
  socket.on('people:now-playing', ({ userId, nowPlaying }) => {
    const p = S.people.get(userId);
    if (!p) return;
    S.people.set(userId, { ...p, nowPlaying: nowPlaying || null });
    renderPeople();
  });

  if (opts.reportPlayback) {
    player.on('track', reportNowPlaying);
    player.on('state', reportNowPlaying);
    player.on('context', reportNowPlaying);
    // Seeks move the position anchor listen-along followers sync to.
    player.on('seeked', reportNowPlaying);
  }

  // DOM wiring
  for (const b of document.querySelectorAll('[data-social-tab]')) b.addEventListener('click', () => selectTab(b.dataset.socialTab));
  $('social-collapse')?.addEventListener('click', () => setCollapsed(true));
  $('social-back')?.addEventListener('click', leaveRoute);
  $('social-toggle')?.addEventListener('click', toggleSocial);
  $('chat-form').addEventListener('submit', sendMessage);
  $('chat-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-id]');
    if (btn) deleteMessage(Number(btn.dataset.deleteId));
  });
  $('social-people').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-listen-id]');
    if (!btn) return;
    const p = S.people.get(btn.dataset.listenId);
    if (!p) return;
    if (S.hooks.isListeningWith(p)) { if (S.hooks.stopListening) S.hooks.stopListening(); }
    else if (S.hooks.listenAlong) S.hooks.listenAlong(p);
  });
  const scroller = chatScroller();
  scroller.addEventListener('scroll', () => { if (scroller.scrollTop < 120) loadOlder(); }, { passive: true });
  window.matchMedia(DESKTOP).addEventListener('change', () => { refreshVisibility(); document.dispatchEvent(new CustomEvent('app:viewchange')); });
  document.addEventListener('visibilitychange', refreshVisibility);
  // Relative "last seen" times age.
  setInterval(() => { if (S.tab === 'people' && panelVisible()) renderPeople(); }, 60_000);

  selectTab('chat');
  renderMessages();
  renderPeople();
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}
