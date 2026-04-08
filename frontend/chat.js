// Chat panel, ticker, and song mentions
import { state, elements, socket } from './state.js';
import { showToast, escapeHtml, getInitials, getCoverUrl, sanitizeUrl } from './ui.js';

let tickerMessages = [];
const MAX_TICKER_MESSAGES = 4;
let pendingSongMention = null;

export function toggleSongMention() {
  if (pendingSongMention) { clearSongMention(); return; }
  const song = state.currentTrack;
  if (!song) return;
  pendingSongMention = { id: song.id, title: song.title, thumbnail: song.thumbnail || null };
  if (elements.chatSongPreview) elements.chatSongPreview.hidden = false;
  if (elements.chatSongPreviewTitle) elements.chatSongPreviewTitle.textContent = song.title;
  if (elements.chatMentionSongBtn) elements.chatMentionSongBtn.classList.add('active');
  if (elements.chatInput) elements.chatInput.focus();
}

export function clearSongMention() {
  pendingSongMention = null;
  if (elements.chatSongPreview) elements.chatSongPreview.hidden = true;
  if (elements.chatMentionSongBtn) elements.chatMentionSongBtn.classList.remove('active');
}

export function sendChatMessage() {
  if (!elements.chatInput || !socket || !state.lobbyId) return;
  const content = elements.chatInput.value.trim();
  if (!content) return;
  const payload = { lobbyId: state.lobbyId, userId: state.userId, username: state.username, emoji: state.emoji, content };
  if (pendingSongMention) payload.songMention = pendingSongMention;
  socket.emit('chat:send', payload);
  elements.chatInput.value = '';
  clearSongMention();
}

export function handleChatMessage(msg) {
  appendChatMessage(msg);
  updateTicker(msg);
}

export function handleChatHistory(data) {
  if (!elements.chatMessages) return;
  if (!data.messages || data.messages.length === 0) {
    elements.chatMessages.innerHTML = '<div class="chat-empty"><p>No messages yet</p><p class="hint">Be the first to say something!</p></div>';
    return;
  }
  elements.chatMessages.innerHTML = '';
  data.messages.forEach(msg => appendChatMessage(msg));
  tickerMessages = data.messages.slice(-MAX_TICKER_MESSAGES);
  renderTicker();
}

function appendChatMessage(msg) {
  if (!elements.chatMessages) return;
  const empty = elements.chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(msg.timestamp);
  const timeStr = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');

  let songMentionHtml = '';
  if (msg.songMention && msg.songMention.title) {
    const thumbUrl = msg.songMention.id ? getCoverUrl(msg.songMention.id, msg.songMention.thumbnail) : sanitizeUrl(msg.songMention.thumbnail);
    songMentionHtml = `
      <div class="chat-song-mention">
        ${thumbUrl ? `<img class="chat-song-mention-thumb" src="${thumbUrl}" alt="">` : '<div class="chat-song-mention-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>'}
        <span class="chat-song-mention-title">${escapeHtml(msg.songMention.title)}</span>
      </div>`;
  }

  div.innerHTML = `
    <div class="chat-msg-avatar">${msg.emoji || getInitials(msg.username)}</div>
    <div class="chat-msg-body">
      <div class="chat-msg-header">
        <span class="chat-msg-user">${escapeHtml(msg.username)}</span>
        <span class="chat-msg-time">${timeStr}</span>
      </div>
      <div class="chat-msg-text">${escapeHtml(msg.content)}</div>
      ${songMentionHtml}
    </div>
  `;
  elements.chatMessages.appendChild(div);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function updateTicker(msg) {
  tickerMessages.push(msg);
  if (tickerMessages.length > MAX_TICKER_MESSAGES) tickerMessages.shift();
  renderTicker();
}

function renderTicker() {
  if (!elements.chatTicker || !elements.chatTickerContent) return;
  if (tickerMessages.length === 0) { elements.chatTicker.hidden = true; return; }
  elements.chatTicker.hidden = false;
  elements.chatTickerContent.innerHTML = tickerMessages.map(msg => {
    const songBadge = msg.songMention ? ' <span class="ticker-song-badge">' + escapeHtml(msg.songMention.title) + '</span>' : '';
    return `<span class="ticker-msg"><span class="ticker-user">${escapeHtml(msg.username)}</span>: ${escapeHtml(msg.content)}${songBadge}</span>`;
  }).join('');
  const contentWidth = elements.chatTickerContent.scrollWidth;
  const speed = 50;
  const duration = contentWidth / speed;
  elements.chatTickerContent.style.animationDuration = duration + 's';
}

export function requestChatHistory() {
  if (socket && state.lobbyId) socket.emit('chat:history', { lobbyId: state.lobbyId });
}

export function resetChat() {
  tickerMessages = [];
  clearSongMention();
  if (elements.chatMessages) {
    elements.chatMessages.innerHTML = '<div class="chat-empty"><p>No messages yet</p><p class="hint">Be the first to say something!</p></div>';
  }
  if (elements.chatTicker) elements.chatTicker.hidden = true;
  if (elements.chatTickerContent) elements.chatTickerContent.innerHTML = '';
}
