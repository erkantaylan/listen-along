// Authentication, registration, and profile management
import { state, elements, socket, auth, STORAGE_KEYS, AVATAR_EMOJIS, storageSet } from './state.js';
import { showView, showToast, escapeHtml } from './ui.js';

export async function registerUser() {
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, username: state.username, emoji: state.emoji })
    });
    if (!res.ok) return 'approved';
    const data = await res.json();
    return data.status || 'approved';
  } catch { return 'approved'; }
}

export function setupPendingRetry() {
  if (elements.pendingRetryBtn) {
    elements.pendingRetryBtn.addEventListener('click', async () => {
      elements.pendingRetryBtn.disabled = true;
      elements.pendingRetryBtn.textContent = 'Checking...';
      const status = await registerUser();
      if (status === 'approved') { window.location.reload(); }
      else if (status === 'rejected') { showRejectedView(); }
      else {
        showToast('Still waiting for approval', 'info');
        elements.pendingRetryBtn.disabled = false;
        elements.pendingRetryBtn.textContent = 'Check Status';
      }
    });
  }
}

export async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    auth.checked = true;
    auth.authenticated = data.authenticated;
    auth.user = data.user || null;
    return data;
  } catch {
    auth.checked = true;
    auth.authenticated = false;
    return { authenticated: false };
  }
}

export async function setupLoginView() {
  try {
    const res = await fetch('/api/auth/providers');
    const providers = await res.json();
    const googleBtn = document.getElementById('google-login-btn');
    const githubBtn = document.getElementById('github-login-btn');
    const noProviders = document.getElementById('login-no-providers');
    if (providers.google && googleBtn) {
      googleBtn.hidden = false;
      googleBtn.addEventListener('click', () => { window.location.href = '/auth/google'; });
    }
    if (providers.github && githubBtn) {
      githubBtn.hidden = false;
      githubBtn.addEventListener('click', () => { window.location.href = '/auth/github'; });
    }
    if (!providers.google && !providers.github && noProviders) noProviders.hidden = false;
  } catch {
    const googleBtn = document.getElementById('google-login-btn');
    const githubBtn = document.getElementById('github-login-btn');
    if (googleBtn) { googleBtn.hidden = false; googleBtn.addEventListener('click', () => { window.location.href = '/auth/google'; }); }
    if (githubBtn) { githubBtn.hidden = false; githubBtn.addEventListener('click', () => { window.location.href = '/auth/github'; }); }
  }

  const logoutBtn = document.getElementById('login-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      auth.authenticated = false;
      auth.user = null;
      showLoginCard();
      showView('login');
    });
  }
}

export function showRejectedView() {
  showView('pending');
  if (elements.pendingIcon) elements.pendingIcon.textContent = '\u274C';
  if (elements.pendingTitle) elements.pendingTitle.textContent = 'Access Denied';
  if (elements.pendingMessage) elements.pendingMessage.textContent = 'Your account has been rejected by the admin. Contact the administrator for more information.';
  if (elements.pendingRetryBtn) elements.pendingRetryBtn.style.display = 'none';
}

export function showLoginCard() {
  const loginCard = document.querySelector('.login-card:not(.login-pending)');
  const pendingCard = document.getElementById('login-pending');
  if (loginCard) loginCard.hidden = false;
  if (pendingCard) pendingCard.hidden = true;
}

export function showPendingCard() {
  const loginCard = document.querySelector('.login-card:not(.login-pending)');
  const pendingCard = document.getElementById('login-pending');
  if (loginCard) loginCard.hidden = true;
  if (pendingCard) {
    pendingCard.hidden = false;
    const userInfo = document.getElementById('pending-user-info');
    if (userInfo && auth.user) {
      userInfo.textContent = '';
      if (auth.user.avatarUrl) {
        const img = document.createElement('img');
        img.src = auth.user.avatarUrl;
        img.alt = '';
        userInfo.appendChild(img);
      }
      const span = document.createElement('span');
      span.textContent = `${auth.user.name || auth.user.email || 'User'} (${auth.user.provider})`;
      userInfo.appendChild(span);
    }
  }
}

export function setupProfileEditor() {
  if (!elements.profileEmojiBtn || !elements.profileNameInput) return;
  elements.profileEmojiBtn.textContent = state.emoji;
  elements.profileNameInput.value = state.username;
  elements.emojiPicker.innerHTML = AVATAR_EMOJIS.map(e =>
    `<button class="emoji-option${e === state.emoji ? ' selected' : ''}" data-emoji="${e}">${e}</button>`
  ).join('');
  elements.profileEmojiBtn.addEventListener('click', () => {
    elements.emojiPicker.hidden = !elements.emojiPicker.hidden;
  });
  elements.emojiPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-option');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    state.emoji = emoji;
    storageSet(STORAGE_KEYS.EMOJI, emoji);
    elements.profileEmojiBtn.textContent = emoji;
    elements.emojiPicker.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    elements.emojiPicker.hidden = true;
  });
  elements.profileSaveBtn.addEventListener('click', saveProfile);
  elements.profileNameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveProfile(); });
}

export function saveProfile() {
  const newName = elements.profileNameInput.value.trim();
  if (!newName) return;
  state.username = newName;
  storageSet(STORAGE_KEYS.USERNAME, newName);
  storageSet(STORAGE_KEYS.EMOJI, state.emoji);
  if (state.lobbyId && socket) {
    socket.emit('user:update', { lobbyId: state.lobbyId, username: state.username, emoji: state.emoji });
  }
  if (auth.authenticated) {
    fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ displayName: newName, emoji: state.emoji })
    }).catch(() => {});
  }
  showToast('Profile updated', 'success');
}

export function setupProfilePage() {
  const backBtn = document.getElementById('profile-back-btn');
  const profileBtn = document.getElementById('landing-profile-btn');
  const logoutBtn = document.getElementById('profile-logout-btn');

  if (profileBtn) profileBtn.addEventListener('click', () => showView('profile'));
  if (backBtn) backBtn.addEventListener('click', () => showView('landing'));
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      auth.authenticated = false;
      auth.user = null;
      window.location.reload();
    });
  }

  const emojiBtn = document.getElementById('profile-page-emoji-btn');
  const emojiPicker = document.getElementById('profile-page-emoji-picker');
  if (emojiBtn && emojiPicker) {
    emojiBtn.textContent = state.emoji;
    emojiPicker.innerHTML = AVATAR_EMOJIS.map(e =>
      `<button class="emoji-option${e === state.emoji ? ' selected' : ''}" data-emoji="${e}">${e}</button>`
    ).join('');
    emojiBtn.addEventListener('click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
    emojiPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-option');
      if (!btn) return;
      const emoji = btn.dataset.emoji;
      state.emoji = emoji;
      storageSet(STORAGE_KEYS.EMOJI, emoji);
      emojiBtn.textContent = emoji;
      emojiPicker.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      emojiPicker.hidden = true;
      if (elements.profileEmojiBtn) elements.profileEmojiBtn.textContent = emoji;
    });
  }

  const nameInput = document.getElementById('profile-page-name-input');
  const saveBtn = document.getElementById('profile-page-save-btn');
  if (saveBtn && nameInput) {
    saveBtn.addEventListener('click', () => saveProfilePage());
    nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveProfilePage(); });
  }
}

async function saveProfilePage() {
  const nameInput = document.getElementById('profile-page-name-input');
  const newName = nameInput ? nameInput.value.trim() : '';
  if (!newName) return;
  state.username = newName;
  storageSet(STORAGE_KEYS.USERNAME, newName);
  storageSet(STORAGE_KEYS.EMOJI, state.emoji);
  if (elements.profileNameInput) elements.profileNameInput.value = newName;
  try {
    await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ displayName: newName, emoji: state.emoji })
    });
  } catch { /* ignore */ }
  if (state.lobbyId && socket) {
    socket.emit('user:update', { lobbyId: state.lobbyId, username: state.username, emoji: state.emoji });
  }
  showToast('Profile saved', 'success');
}

export async function loadProfilePage() {
  const nameInput = document.getElementById('profile-page-name-input');
  const emojiBtn = document.getElementById('profile-page-emoji-btn');
  const providersList = document.getElementById('profile-providers-list');
  if (nameInput) nameInput.value = state.username;
  if (emojiBtn) emojiBtn.textContent = state.emoji;
  try {
    const res = await fetch('/api/profile', { credentials: 'same-origin' });
    if (res.ok) {
      const profile = await res.json();
      if (profile.displayName && nameInput) {
        nameInput.value = profile.displayName;
        state.username = profile.displayName;
        storageSet(STORAGE_KEYS.USERNAME, profile.displayName);
      }
      if (profile.emoji) {
        state.emoji = profile.emoji;
        storageSet(STORAGE_KEYS.EMOJI, profile.emoji);
        if (emojiBtn) emojiBtn.textContent = profile.emoji;
        if (elements.profileEmojiBtn) elements.profileEmojiBtn.textContent = profile.emoji;
      }
      renderProvidersList(providersList, profile.providers || []);
    } else { renderProvidersList(providersList, []); }
  } catch { renderProvidersList(providersList, []); }
}

function renderProvidersList(container, providers) {
  if (!container) return;
  const providerConfigs = {
    google: {
      name: 'Google',
      icon: '<svg class="provider-icon" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>',
      linkUrl: '/auth/google/link'
    },
    github: {
      name: 'GitHub',
      icon: '<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>',
      linkUrl: '/auth/github/link'
    }
  };
  const linkedMap = {};
  providers.forEach(p => { linkedMap[p.provider] = p; });

  fetch('/api/auth/providers')
    .then(r => r.json())
    .then(available => {
      let html = '';
      for (const p of providers) {
        const config = providerConfigs[p.provider];
        if (!config) continue;
        html += `<li class="profile-provider-item connected"><div class="profile-provider-info">${config.icon}<div><span class="profile-provider-name">${config.name}</span><span class="profile-provider-email">${escapeHtml(p.email || p.name || 'Connected')}</span></div></div><button class="btn btn-small btn-secondary profile-unlink-btn" data-provider="${p.provider}">Disconnect</button></li>`;
      }
      for (const [key, config] of Object.entries(providerConfigs)) {
        if (linkedMap[key] || !available[key]) continue;
        html += `<li class="profile-provider-item"><div class="profile-provider-info">${config.icon}<div><span class="profile-provider-name">${config.name}</span><span class="profile-provider-email">Not connected</span></div></div><a href="${config.linkUrl}" class="btn btn-small btn-primary profile-link-btn">Connect</a></li>`;
      }
      if (!html) html = '<li class="profile-provider-empty">No providers configured</li>';
      container.innerHTML = html;

      container.querySelectorAll('.profile-unlink-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const provider = btn.dataset.provider;
          if (!confirm(`Disconnect ${providerConfigs[provider]?.name || provider}?`)) return;
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const res = await fetch(`/api/profile/providers/${provider}`, { method: 'DELETE', credentials: 'same-origin' });
            if (res.ok) { showToast('Account disconnected', 'success'); loadProfilePage(); }
            else { const data = await res.json(); showToast(data.error || 'Failed to disconnect', 'error'); btn.disabled = false; btn.textContent = 'Disconnect'; }
          } catch { showToast('Failed to disconnect', 'error'); btn.disabled = false; btn.textContent = 'Disconnect'; }
        });
      });
    })
    .catch(() => { container.innerHTML = '<li class="profile-provider-empty">Failed to load providers</li>'; });
}
