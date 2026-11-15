// The global chat and the people panel (markup: #social-panel in index.html;
// server: backend/src/social.js). One panel, two layouts:
//   desktop (>= 1010px): a right-hand column on every signed-in page,
//     collapsible (remembered per browser);
//   narrower (phones, tablets, small windows): a full-screen "Social" view at
//     /social (router.ts), never beside the page, which would squeeze it;
//     opened from the chat button in the player bar (or on the pending card).
// Inside, three stacked cards, all on screen together: People, Chat and (for
// approved accounts) Activity. #social-rail, from 1010px while the column is
// not on screen, is the labelled way back: Chat, People and Activity, each
// opening the panel at that card. The player bar's chat button toggles the
// panel too. Both carry the unread badge.
//
// This module also reports what this browser plays (player.ts events) as
// presence:now-playing; the server keeps one entry per user.
import { formatMessageHtml, formatLastSeen, formatMessageTime, groupPeople, mergeMessages, escapeText } from './chat-format.ts';
import { DOCK_MIN } from '../../shared/layout-rules.ts';
import { setupPanelWidths } from '../../shared/panel-widths.ts';
import { player } from '../../player/player.ts';
import { storageGet, storageSet } from '../../shared/state.ts';
import { navigateTo, showToast, t } from '../../shared/ui.ts';
import { openContextMenu, closeContextMenu, updateContextMenu } from '../../shared/context-menu.ts';
import { setupActivity, setActivityVisible } from './activity.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { PlayerContext } from '../../player/player.ts';
import type { MenuItem } from '../../shared/context-menu.ts';
import type {
  ChatHistoryAck, ChatDeleteAck, ChatMessage, ChatSendAck, NowPlayingView, PeopleListAck,
  PresenceContextReport, PresenceEntry, PresenceUpdate,
} from '../../shared/types.ts';

/** The panel's cards (the rail opens one). */
export type SocialCard = 'chat' | 'people' | 'activity';

/** setupSocial opts. */
export interface SocialOptions {
  /** Profile announced without a database (social:hello). */
  name?: string | null;
  emoji?: string | null;
  /** Report this browser's playback as presence:now-playing. */
  reportPlayback?: boolean;
  /** The Activity card (downloads): approved accounts only. */
  activity?: boolean;
  listenAlong?: ((person: PresenceEntry) => void) | null;
  isListeningWith?: ((person: PresenceEntry) => boolean) | null;
  stopListening?: (() => void) | null;
  /** Why the card's Listen along is off when listenAlong is not given. */
  noListenHint?: string | null;
}

interface SocialHooks {
  listenAlong: ((person: PresenceEntry) => void) | null;
  isListeningWith: (person: PresenceEntry) => boolean;
  stopListening: (() => void) | null;
  noListenHint?: string | null;
}

const DESKTOP = `(min-width: ${DOCK_MIN}px)`;
const COLLAPSED_KEY = 'listen-socialCollapsed';
const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 80;

const S: {
  socket: AppSocket | null;
  me: string | null;
  isAdmin: boolean;
  people: Map<string, PresenceEntry>;
  messages: ChatMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  historyLoaded: boolean;
  card: SocialCard;
  activity: boolean;
  route: boolean;
  unread: number;
  cameFromApp: boolean;
  cardId: string | null;
  hooks: SocialHooks;
} = {
  socket: null,
  me: null,
  isAdmin: false,
  people: new Map(),
  messages: [],
  hasMore: false,
  loadingOlder: false,
  historyLoaded: false,
  card: 'chat', // the card the rail opened last (focus returns to its rail button)
  activity: false, // the Activity card (downloads): approved accounts only
  route: false,
  unread: 0,
  cameFromApp: false,
  cardId: null, // person whose card is open
  hooks: { listenAlong: null, isListeningWith: () => false, stopListening: null },
};

const $ = (id: string): HTMLElement | null => maybeById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const isDesktop = () => window.matchMedia(DESKTOP).matches;
const collapsed = () => document.body.classList.contains('social-collapsed');

// ------------------------------------------------------------- visibility

function panelVisible(): boolean {
  if (!document.body.classList.contains('has-social')) return false;
  return isDesktop() ? !collapsed() : S.route;
}

function chatVisible(): boolean {
  return panelVisible() && document.visibilityState === 'visible';
}

function setUnread(n: number): void {
  S.unread = n;
  const label = n > 99 ? '99+' : String(n);
  for (const el of document.querySelectorAll<HTMLElement>('[data-social-unread]')) {
    el.textContent = label;
    el.hidden = n === 0;
  }
  const toggle = $('social-toggle');
  if (toggle) {
    const base = t('social.open', 'Chat and people');
    toggle.setAttribute('aria-label', n ? `${base} (${n} unread)` : base);
  }
}

function refreshVisibility(): void {
  const toggle = $('social-toggle');
  if (toggle) toggle.classList.toggle('active', panelVisible());
  setActivityVisible(S.activity && panelVisible() && document.visibilityState === 'visible');
  if (chatVisible()) {
    if (S.unread) setUnread(0);
    scrollChatToBottom(false);
  }
}

function setCollapsed(value: boolean): void {
  document.body.classList.toggle('social-collapsed', value);
  storageSet(COLLAPSED_KEY, value ? '1' : '0');
  const btn = $('social-collapse');
  if (btn) btn.setAttribute('aria-expanded', String(!value));
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

const CARD_IDS: Record<SocialCard, string> = { chat: 'social-chat', people: 'social-people', activity: 'social-activity' };

// The card the rail asked for: scrolled into view in the column and focused.
function showCard(card: string | undefined): void {
  S.card = card === 'people' || (card === 'activity' && S.activity) ? card : 'chat';
  const el = $(CARD_IDS[S.card]);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

// The /social route (router.ts). Below 1010px it is the full-screen Social
// view; from 1010px it just makes sure the column is open.
export function applySocialRoute(active: boolean, { fromApp = false }: { fromApp?: boolean } = {}): void {
  S.route = !!active;
  if (active && fromApp) S.cameFromApp = true;
  document.body.classList.toggle('social-route', S.route);
  if (S.route && isDesktop() && collapsed()) setCollapsed(false);
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}

function leaveRoute(): void {
  if (S.cameFromApp && window.history.length > 1) { S.cameFromApp = false; window.history.back(); }
  else navigateTo('/');
}

// Chat button (player bar / pending card): the column from 1010px, else the view.
export function toggleSocial(): void {
  if (isDesktop()) { setCollapsed(!collapsed()); return; }
  if (S.route) leaveRoute();
  else { S.cameFromApp = true; navigateTo('/social'); }
}

// The rail: open the panel at a given card, wherever the panel lives at this width.
function openSocial(card: string | undefined): void {
  if (isDesktop()) setCollapsed(false);
  else if (!S.route) { S.cameFromApp = true; navigateTo('/social'); }
  showCard(card);
}

// ------------------------------------------------------------------ chat

function chatScroller(): HTMLElement | null { return $('chat-scroll'); }

function nearBottom(): boolean {
  const el = chatScroller();
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

function scrollChatToBottom(smooth = false): void {
  const el = chatScroller();
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

// A person (PresenceEntry) or a chat message's author (ChatMessage).
interface AvatarSource {
  name?: string | null;
  avatarUrl?: string | null;
  emoji?: string | null;
  authorName?: string | null;
  authorAvatar?: string | null;
  authorEmoji?: string | null;
}

function avatarHtml(p: AvatarSource, cls: string): string {
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

function messageHtml(m: ChatMessage, prev: ChatMessage | undefined): string {
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

function renderMessages({ keepScroll = false, stickToBottom = false }: { keepScroll?: boolean; stickToBottom?: boolean } = {}): void {
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

async function loadHistory(): Promise<void> {
  const res = await ask('chat:history', {});
  if (!res || res.error) { if (res && res.error) showToast(res.error, 'error'); return; }
  S.messages = mergeMessages([], res.messages || []);
  S.hasMore = !!res.hasMore;
  S.historyLoaded = true;
  renderMessages({ stickToBottom: true });
}

async function loadOlder(): Promise<void> {
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

function onMessage(m: ChatMessage): void {
  const stick = nearBottom() || m.userId === S.me;
  S.messages = mergeMessages(S.messages, [m]);
  renderMessages({ keepScroll: !stick, stickToBottom: stick });
  if (m.userId !== S.me && !chatVisible()) setUnread(S.unread + 1);
}

function onDeleted({ id }: { id: number }): void {
  const before = S.messages.length;
  S.messages = S.messages.filter(m => m.id !== id);
  if (S.messages.length !== before) renderMessages({ keepScroll: true });
}

async function sendMessage(e: Event): Promise<void> {
  e.preventDefault();
  const input = byId<HTMLInputElement>('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const btn = byId<HTMLButtonElement>('chat-send');
  btn.disabled = true;
  const res = await ask('chat:send', { text });
  btn.disabled = false;
  if (!res || res.error) { showToast((res && res.error) || t('chat.sendFailed', 'Could not send the message'), 'error'); return; }
  input.value = '';
  input.focus();
}

async function deleteMessage(id: number): Promise<void> {
  if (!window.confirm(t('chat.confirmDelete', 'Delete this message for everyone?'))) return;
  const res = await ask('chat:delete', { id });
  if (!res || res.error) showToast((res && res.error) || 'Could not delete', 'error');
}

// ---------------------------------------------------------------- people
//
// Rows are Discord-like: avatar + presence dot, name, and one activity line
// (an animated equaliser + "Title — Artist" while playing, muted "Paused ·
// Title" when paused, "Last seen …" offline). Clicking a row (or Enter /
// Space on it) opens the person's card, a context-menu.ts popover anchored
// to the row (a bottom sheet on phones): avatar, presence, the current song
// with its cover, "N listening along", and the Listen along / Stop button.
// The card re-renders live while open. A private playlist never shows: the
// server sends no context for it, so only the song is shown.

const MUSIC_PATH = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
const PAUSE_PATH = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
const HEADPHONES_PATH = '<path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>';
const svg = (path: string, cls = 'icon-sm'): string => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${path}</svg>`;
const EQ_HTML = '<span class="person-eq" aria-hidden="true"><i></i><i></i><i></i></span>';
const CARD_CLASS = 'person-card-pop';

function songText(np: NowPlayingView): string {
  return [np.track.title, np.track.artist].filter(Boolean).join(' — ');
}

function contextLabel(np: NowPlayingView | null): string {
  const c = np && np.context;
  if (!c) return '';
  if (c.type === 'library') return t('player.fromLibrary', 'Music Library');
  if (c.type === 'radio') return t('radio.title', 'Radio');
  if (c.type === 'artist') return c.name || t('artists.anArtist', 'an artist');
  return c.name || t('social.aPlaylist', 'a playlist');
}

function presenceText(p: PresenceEntry): string {
  if (p.online) return t('social.online', 'Online');
  const seen = formatLastSeen(p.lastSeen);
  return seen ? tf('social.lastSeen', 'Last seen {when}', { when: seen }) : t('social.offline', 'Offline');
}

function badgesHtml(p: PresenceEntry): string {
  return (p.id === S.me ? `<span class="badge badge-subtle theme-secondary">${escapeText(t('social.you', 'you'))}</span>` : '')
    + (p.pending ? `<span class="badge badge-subtle theme-warning">${escapeText(t('social.pending', 'pending'))}</span>` : '');
}

function activityHtml(p: PresenceEntry): string {
  const np = p.online ? p.nowPlaying : null;
  if (np) {
    const song = songText(np);
    if (np.playing) {
      return `<span class="d-flex align-items-center gap-1 fs-xs min-w-0 person-activity" title="${escapeText(song)}">${EQ_HTML}`
        + `<span class="visually-hidden">${escapeText(t('social.listeningTo', 'Listening to'))} </span><span class="text-truncate">${escapeText(song)}</span></span>`;
    }
    return `<span class="d-flex align-items-center gap-1 fs-xs fg-3 min-w-0 person-activity is-paused" title="${escapeText(song)}">${svg(PAUSE_PATH)}`
      + `<span class="text-truncate">${escapeText(t('social.paused', 'Paused'))} · ${escapeText(song)}</span></span>`;
  }
  if (!p.online) return `<span class="d-block fs-xs fg-4 text-truncate">${escapeText(presenceText(p))}</span>`;
  return '';
}

function personHtml(p: PresenceEntry): string {
  const name = p.name || 'User';
  return `<li class="list-group-item list-group-item-action person${p.online ? ' is-online' : ''}" data-person-id="${escapeText(p.id)}" tabindex="0" role="button" aria-haspopup="dialog" aria-expanded="${S.cardId === p.id ? 'true' : 'false'}" aria-label="${escapeText(name)}">`
    + `<span class="person-avatar-wrap">${avatarHtml(p, 'person-avatar')}<span class="person-dot" aria-hidden="true"></span></span>`
    + `<span class="min-w-0 flex-grow-1"><span class="d-flex align-items-center gap-1 min-w-0"><span class="text-truncate fw-medium person-name">${escapeText(name)}</span>${badgesHtml(p)}</span>${activityHtml(p)}</span></li>`;
}

function coverHtml(np: NowPlayingView | null): string {
  const url = np && np.track && np.track.thumbnail;
  if (url && (/^https:\/\//i.test(url) || /^\/[^/]/.test(url))) {
    return `<span class="person-card-cover"><img src="${escapeText(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  return `<span class="person-card-cover is-empty">${svg(MUSIC_PATH, '')}</span>`;
}

// The card's markup (escaped here; context-menu.ts inserts it as is).
function cardHtml(p: PresenceEntry): string {
  const name = p.name || 'User';
  const isMe = p.id === S.me;
  const np = p.online ? p.nowPlaying : null;
  const following = !isMe && S.hooks.isListeningWith(p);
  let html = `<div class="person-card" aria-live="polite">`
    + `<div class="d-flex align-items-center gap-3 min-w-0">`
    + `<span class="person-avatar-wrap${p.online ? ' is-online' : ''}">${avatarHtml(p, 'person-card-avatar')}<span class="person-dot" aria-hidden="true"></span></span>`
    + `<span class="min-w-0"><span class="d-flex align-items-center gap-1 min-w-0"><span class="fw-semibold text-truncate person-card-name">${escapeText(name)}</span>${badgesHtml(p)}</span>`
    + `<span class="d-block fs-xs ${p.online ? 'person-card-online' : 'fg-3'}">${escapeText(presenceText(p))}</span></span></div>`;
  if (np) {
    const where = contextLabel(np);
    html += `<div class="d-flex align-items-center gap-3 min-w-0 person-card-song">${coverHtml(np)}<span class="min-w-0">`
      + `<span class="d-flex align-items-center gap-1 fs-xs ${np.playing ? 'person-card-label' : 'fg-3'}">${np.playing ? EQ_HTML : svg(PAUSE_PATH)}${escapeText(np.playing ? t('social.listeningTo', 'Listening to') : t('social.paused', 'Paused'))}</span>`
      + `<span class="d-block fw-medium text-truncate" title="${escapeText(np.track.title)}">${escapeText(np.track.title)}</span>`
      + (np.track.artist ? `<span class="d-block fs-sm fg-3 text-truncate">${escapeText(np.track.artist)}</span>` : '')
      + (where ? `<span class="d-block fs-xs fg-3 text-truncate">${escapeText(tf('social.from', 'from {where}', { where }))}</span>` : '')
      + `</span></div>`;
  }
  const count = Number(p.listeners) || 0;
  if (count > 0) {
    html += `<div class="d-flex align-items-center gap-2 fs-sm fg-3 person-card-listeners">${svg(HEADPHONES_PATH)}${escapeText(count === 1 ? t('social.oneListening', '1 listening along') : tf('social.nListening', '{count} listening along', { count }))}</div>`;
  }
  // The action: Listen along / Stop listening along, or why it is off.
  let hint = '';
  if (isMe) hint = t('social.cardSelf', 'This is you.');
  else if (!S.hooks.listenAlong) hint = S.hooks.noListenHint || t('social.cardNeedsApproval', 'Listening along needs an approved account.');
  else if (!p.online) hint = t('social.cardOffline', 'They are offline.');
  else if (!np && !following) hint = t('social.cardIdle', 'They are not playing anything right now.');
  const label = following ? t('listen.stop', 'Stop listening along') : t('listen.listenAlong', 'Listen along');
  const cls = following ? 'btn' : 'btn-solid theme-primary';
  html += `<button type="button" class="${cls} w-100 person-card-action" data-ctx-action="${following ? 'stop' : 'listen'}"${hint ? ' disabled aria-describedby="person-card-hint"' : ''}>${svg(HEADPHONES_PATH, '')}${escapeText(label)}</button>`;
  if (hint) html += `<p id="person-card-hint" class="fs-xs fg-3 mb-0 text-center">${escapeText(hint)}</p>`;
  return `${html}</div>`;
}

function cardItems(p: PresenceEntry): MenuItem[] {
  return [{
    html: cardHtml(p),
    onAction: (action: string | undefined) => {
      const cur = S.people.get(p.id) || p;
      if (action === 'stop') { if (S.hooks.stopListening) S.hooks.stopListening(); }
      else if (action === 'listen' && S.hooks.listenAlong) S.hooks.listenAlong(cur);
    },
  }];
}

const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`#social-people [data-person-id="${CSS.escape(id)}"]`);
const cardOpen = (): boolean => !!document.querySelector(`.${CARD_CLASS}`);

function openCard(id: string, { fromKeyboard = false }: { fromKeyboard?: boolean } = {}): void {
  const p = S.people.get(id);
  const row = rowOf(id);
  if (!p || !row) return;
  if (S.cardId === id && cardOpen()) { closeContextMenu({ restoreFocus: true }); return; }
  S.cardId = id;
  openContextMenu({ anchor: row, alignLeft: true }, cardItems(p), {
    kind: 'popover',
    sheet: true,
    className: CARD_CLASS,
    label: p.name || 'User',
    trigger: row,
    returnFocus: () => rowOf(id),
    focusFirst: fromKeyboard,
  });
}

// Keep the open card in step with the data.
function refreshCard(): void {
  if (!S.cardId) return;
  if (!cardOpen()) { S.cardId = null; return; }
  const p = S.people.get(S.cardId);
  if (p) updateContextMenu(cardItems(p));
}

function renderPeople(): void {
  const { online, offline } = groupPeople([...S.people.values()]);
  const on = $('people-online');
  const off = $('people-offline');
  if (!on || !off) return;
  if (S.cardId && !cardOpen()) S.cardId = null;
  // Rows are re-rendered: keep keyboard focus on the same person.
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest<HTMLElement>('#social-people [data-person-id]');
  const focusId = focused ? focused.dataset.personId : null;
  on.innerHTML = online.length ? online.map(personHtml).join('') : `<li class="list-group-item app-empty">${escapeText(t('social.nobodyOnline', 'Nobody is online'))}</li>`;
  off.innerHTML = offline.length ? offline.map(personHtml).join('') : `<li class="list-group-item app-empty">${escapeText(t('social.nobodyOffline', 'Everyone is online'))}</li>`;
  byId('people-online-count').textContent = String(online.length);
  byId('people-offline-count').textContent = String(offline.length);
  for (const el of document.querySelectorAll('[data-online-count]')) el.textContent = String(online.length);
  if (focusId) rowOf(focusId)?.focus({ preventScroll: true });
  refreshCard();
}

// Re-render (e.g. the listen-along state changed).
export function refreshPeople(): void { renderPeople(); }

// people:presence / people:user send no nowPlaying (social.js sets it undefined);
// one that came with it would keep it.
function upsertPerson(user: PresenceUpdate & { nowPlaying?: NowPlayingView | null }): void {
  if (!user || !user.id) return;
  const prev: Partial<PresenceEntry> = S.people.get(user.id) || {};
  // nowPlaying is filled in on the next lines.
  const next = { ...prev, ...user } as PresenceEntry;
  if (user.nowPlaying === undefined) next.nowPlaying = prev.nowPlaying || null;
  if (!next.online) next.nowPlaying = null;
  S.people.set(user.id, next);
  renderPeople();
}

async function loadPeople(): Promise<void> {
  const answer = await ask('people:list');
  if (!answer || answer.error) return;
  // No error: the list (an error is never an empty string, so the check above
  // does not narrow the union by itself).
  const res = answer as Extract<PeopleListAck, { people: unknown }>;
  S.me = res.me;
  const wasAdmin = S.isAdmin;
  S.isAdmin = !!res.isAdmin;
  S.people = new Map(res.people.map(p => [p.id, p]));
  renderPeople();
  if (wasAdmin !== S.isAdmin) renderMessages({ keepScroll: true });
}

// ---------------------------------------------------------- now playing

let reportTimer: ReturnType<typeof setTimeout> | null = null;

// What the server may tell others about where the song comes from (presence.js checks it again).
function presenceContext(ctx: PlayerContext | null): PresenceContextReport | null {
  if (!ctx) return null;
  if (ctx.type === 'library' || ctx.type === 'radio') return { type: ctx.type };
  if (ctx.type === 'artist') return { type: 'artist', key: ctx.key, name: ctx.name || null };
  if (ctx.type === 'lobby') return { type: 'lobby', lobbyId: ctx.lobbyId };
  return null;
}
// Also the listen-along heartbeat (listen-along.ts) while someone listens along.
export function reportNowPlaying(): void {
  clearTimeout(reportTimer ?? undefined);
  reportTimer = setTimeout(() => {
    if (!S.socket || !S.socket.connected) return;
    const tr = player.track;
    const ctx = player.context;
    S.socket.emit('presence:now-playing', tr ? {
      track: { id: tr.id || null, title: tr.title, artist: tr.artist || null, thumbnail: tr.thumbnail || null, url: tr.url || null },
      context: presenceContext(ctx),
      playing: player.isPlaying,
      position: player.currentTime,
      duration: player.duration,
      rate: player.playbackRate,
    } : { track: null });
  }, 250);
}

// ----------------------------------------------------------------- setup

// An ack as this module reads it: a field of any member is readable on the
// union (undefined where that member has none), so `res.error` / `res.messages`
// read as in the plain JS.
type KeysOf<T> = T extends unknown ? keyof T : never;
type Readable<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOf<All>, keyof T>]?: undefined } : never;

// Emit with an ack; null on no socket or a 10s timeout.
function ask(event: 'people:list', arg?: unknown): Promise<Readable<PeopleListAck> | null>;
function ask(event: 'chat:history', arg: { before?: number; limit?: number }): Promise<Readable<ChatHistoryAck> | null>;
function ask(event: 'chat:send', arg: { text: string }): Promise<Readable<ChatSendAck> | null>;
function ask(event: 'chat:delete', arg: { id: number }): Promise<Readable<ChatDeleteAck> | null>;
function ask(event: 'people:list' | 'chat:history' | 'chat:send' | 'chat:delete', arg?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (!S.socket) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 10000);
    // The overloads above pair each event with its payload and ack (types.ts
    // ClientToServerEvents); one emit call for all four cannot.
    const sock = S.socket as unknown as { emit(ev: string, arg: unknown, ack: (res: unknown) => void): void };
    sock.emit(event, arg, (res) => { clearTimeout(timer); resolve(res); });
  });
}

// Profile shown to others when the server has no database (it then has no
// users table to read names from).
export function announceProfile(name: string | null | undefined, emoji: string | null | undefined): void {
  if (S.socket && name) S.socket.emit('social:hello', { name, emoji });
}

/**
 * Start the chat + people panel on a connected-or-connecting socket.
 * opts: { name, emoji, reportPlayback, listenAlong(person), isListeningWith(person), stopListening(),
 *         activity: the Activity tab too (an approved account) }
 */
export function setupSocial(socket: AppSocket, opts: SocialOptions = {}): void {
  S.socket = socket;
  S.hooks.listenAlong = opts.listenAlong || null;
  if (opts.isListeningWith) S.hooks.isListeningWith = opts.isListeningWith;
  S.hooks.stopListening = opts.stopListening || null;
  S.hooks.noListenHint = opts.noListenHint || null;
  setupPanelWidths();
  document.body.classList.add('has-social');
  // The downloads log (activity.ts): its card and rail button stay hidden without it.
  S.activity = !!opts.activity;
  for (const el of document.querySelectorAll<HTMLElement>('#social-activity, [data-social-open="activity"]')) el.hidden = !S.activity;
  if (S.activity) setupActivity(socket);
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
  socket.on('people:listeners', ({ userId, count }) => {
    const p = S.people.get(userId);
    if (!p) return;
    S.people.set(userId, { ...p, listeners: Number(count) || 0 });
    renderPeople();
  });

  if (opts.reportPlayback) {
    player.on('track', reportNowPlaying);
    player.on('state', reportNowPlaying);
    player.on('context', reportNowPlaying);
    // Seeks move the position anchor listen-along followers sync to.
    player.on('seeked', reportNowPlaying);
    // So does the speed: followers place the leader with it (speed-rules.ts).
    player.on('rate', reportNowPlaying);
  }

  // DOM wiring
  $('social-collapse')?.addEventListener('click', () => {
    setCollapsed(true);
    document.querySelector<HTMLElement>(`[data-social-open="${S.card}"]`)?.focus();
  });
  for (const b of document.querySelectorAll<HTMLElement>('[data-social-open]')) b.addEventListener('click', () => openSocial(b.dataset.socialOpen));
  $('social-back')?.addEventListener('click', leaveRoute);
  $('social-toggle')?.addEventListener('click', toggleSocial);
  byId('chat-form').addEventListener('submit', sendMessage);
  byId('chat-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-delete-id]');
    if (btn) deleteMessage(Number(btn.dataset.deleteId));
  });
  // A row opens the person's card (click, or Enter / Space on the row).
  byId('social-people').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-person-id]');
    if (row) openCard(row.dataset.personId as string, { fromKeyboard: e.detail === 0 });
  });
  byId('social-people').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-person-id]');
    if (!row || e.target !== row) return;
    e.preventDefault();
    openCard(row.dataset.personId as string, { fromKeyboard: true });
  });
  const scroller = chatScroller() as HTMLElement;
  scroller.addEventListener('scroll', () => { if (scroller.scrollTop < 120) loadOlder(); }, { passive: true });
  window.matchMedia(DESKTOP).addEventListener('change', () => {
    // Opened full-screen, then the window grew: keep it open as the column.
    if (S.route && isDesktop() && collapsed()) setCollapsed(false);
    refreshVisibility(); document.dispatchEvent(new CustomEvent('app:viewchange'));
  });
  document.addEventListener('visibilitychange', refreshVisibility);
  // Relative "last seen" times age.
  setInterval(() => { if (panelVisible()) renderPeople(); }, 60_000);

  renderMessages();
  renderPeople();
  refreshVisibility();
  document.dispatchEvent(new CustomEvent('app:viewchange'));
}
