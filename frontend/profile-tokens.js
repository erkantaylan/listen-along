// "CLI tokens" card on the profile page: the logged-in user's own tokens for
// the `la` CLI (GET/POST/DELETE /api/tokens). Approved accounts only; the
// full token is shown once, right after it is created.
import { auth } from './state.js';
import { showToast, escapeHtml } from './ui.js';

const $ = (id) => document.getElementById(id);

function when(value) {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleString();
}

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderList(tokens) {
  const list = $('profile-tokens-list');
  if (!list) return;
  if (!tokens.length) {
    list.innerHTML = '<li class="list-group-item app-empty">No tokens yet.</li>';
    return;
  }
  list.innerHTML = tokens.map((t) => `
    <li class="list-group-item d-flex align-items-center gap-3 profile-token-item">
      <div class="min-w-0 flex-grow-1">
        <div class="fw-medium text-truncate">${escapeHtml(t.label)}</div>
        <div class="fs-xs fg-3 text-break"><span class="font-monospace">${escapeHtml(t.prefix)}…</span> · created ${escapeHtml(when(t.created_at))} · ${t.last_used_at ? 'last used ' + escapeHtml(when(t.last_used_at)) : 'never used'}</div>
      </div>
      <button class="btn-outline theme-danger btn-sm" type="button" data-token-revoke="${escapeHtml(t.id)}" data-token-label="${escapeHtml(t.label)}">Revoke</button>
    </li>`).join('');
}

async function loadTokens() {
  const list = $('profile-tokens-list');
  try {
    const { tokens } = await api('GET', '/api/tokens');
    renderList(tokens);
  } catch (err) {
    if (list) list.innerHTML = `<li class="list-group-item app-empty">${escapeHtml(err.message)}</li>`;
  }
}

function showNewToken(token, record) {
  $('profile-new-token-label').textContent = `"${record.label}"`;
  $('profile-new-token-value').value = token;
  $('profile-token-usage').textContent =
    `la config set server ${window.location.origin}\nla config set token ${token}\nla whoami\nla worker      # optional: be a downloader for everyone's requests`;
  $('profile-new-token').hidden = false;
  $('profile-new-token-value').focus();
  $('profile-new-token-value').select();
}

function hideNewToken() {
  const box = $('profile-new-token');
  if (!box) return;
  box.hidden = true;
  $('profile-new-token-value').value = '';
  $('profile-token-usage').textContent = '';
}

export function setupProfileTokens() {
  const form = $('profile-token-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('profile-token-label');
    const label = input.value.trim();
    if (!label) { input.focus(); return; }
    const btn = $('profile-token-create-btn');
    btn.disabled = true;
    try {
      const { token, record } = await api('POST', '/api/tokens', { label });
      input.value = '';
      showNewToken(token, record);
      loadTokens();
    } catch (err) {
      showToast(`Could not create token: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('profile-copy-token-btn').addEventListener('click', async () => {
    const btn = $('profile-copy-token-btn');
    const value = $('profile-new-token-value').value;
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch {
      $('profile-new-token-value').select();
      showToast('Select the token and copy it', 'info');
    }
  });

  $('profile-new-token-done-btn').addEventListener('click', hideNewToken);

  $('profile-tokens-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-token-revoke]');
    if (!btn) return;
    if (!confirm(`Revoke the token "${btn.dataset.tokenLabel}"? The CLI using it stops working.`)) return;
    btn.disabled = true;
    try {
      await api('DELETE', `/api/tokens/${encodeURIComponent(btn.dataset.tokenRevoke)}`);
      showToast('Token revoked', 'success');
    } catch (err) {
      showToast(`Could not revoke: ${err.message}`, 'error');
    }
    loadTokens();
  });
}

// Called whenever the profile view opens.
export function loadProfileTokens() {
  const card = $('profile-tokens-card');
  if (!card) return;
  const approved = !!(auth.user && auth.user.status === 'approved');
  card.hidden = !approved;
  hideNewToken();
  if (approved) loadTokens();
}
