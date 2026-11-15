// "CLI tokens" card on the profile page: the logged-in user's own tokens for
// the `la` CLI (GET/POST/DELETE /api/tokens). Approved accounts only; the
// full token is shown once, right after it is created.
import { auth } from '../../shared/state.ts';
import { showToast, escapeHtml } from '../../shared/ui.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { ApiError, ApiToken, TokenCreatedResponse, TokenListResponse } from '../../shared/types.ts';

function when(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** The JSON answer, typed by the caller (T); an error status throws. */
async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const opts: RequestInit & { headers: Record<string, string> } = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data: unknown = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data as Partial<ApiError>).error || `HTTP ${res.status}`);
  return data as T;
}

function renderList(tokens: ApiToken[]): void {
  const list = maybeById('profile-tokens-list');
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

async function loadTokens(): Promise<void> {
  const list = maybeById('profile-tokens-list');
  try {
    const { tokens } = await api<TokenListResponse>('GET', '/api/tokens');
    renderList(tokens);
  } catch (err) {
    if (list) list.innerHTML = `<li class="list-group-item app-empty">${escapeHtml((err as Error).message)}</li>`;
  }
}

function showNewToken(token: string, record: ApiToken): void {
  byId('profile-new-token-label').textContent = `"${record.label}"`;
  byId<HTMLInputElement>('profile-new-token-value').value = token;
  byId('profile-token-usage').textContent =
    `la config set server ${window.location.origin}\nla config set token ${token}\nla whoami\nla worker      # optional: be a downloader for everyone's requests`;
  byId('profile-new-token').hidden = false;
  byId<HTMLInputElement>('profile-new-token-value').focus();
  byId<HTMLInputElement>('profile-new-token-value').select();
}

function hideNewToken(): void {
  const box = maybeById('profile-new-token');
  if (!box) return;
  box.hidden = true;
  byId<HTMLInputElement>('profile-new-token-value').value = '';
  byId('profile-token-usage').textContent = '';
}

export function setupProfileTokens(): void {
  const form = maybeById<HTMLFormElement>('profile-token-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = byId<HTMLInputElement>('profile-token-label');
    const label = input.value.trim();
    if (!label) { input.focus(); return; }
    const btn = byId<HTMLButtonElement>('profile-token-create-btn');
    btn.disabled = true;
    try {
      const { token, record } = await api<TokenCreatedResponse>('POST', '/api/tokens', { label });
      input.value = '';
      showNewToken(token, record);
      loadTokens();
    } catch (err) {
      showToast(`Could not create token: ${(err as Error).message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  byId('profile-copy-token-btn').addEventListener('click', async () => {
    const btn = byId('profile-copy-token-btn');
    const value = byId<HTMLInputElement>('profile-new-token-value').value;
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch {
      byId<HTMLInputElement>('profile-new-token-value').select();
      showToast('Select the token and copy it', 'info');
    }
  });

  byId('profile-new-token-done-btn').addEventListener('click', hideNewToken);

  byId('profile-tokens-list').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-token-revoke]');
    if (!btn) return;
    if (!confirm(`Revoke the token "${btn.dataset.tokenLabel}"? The CLI using it stops working.`)) return;
    btn.disabled = true;
    try {
      await api('DELETE', `/api/tokens/${encodeURIComponent(btn.dataset.tokenRevoke as string)}`);
      showToast('Token revoked', 'success');
    } catch (err) {
      showToast(`Could not revoke: ${(err as Error).message}`, 'error');
    }
    loadTokens();
  });
}

// Called whenever the profile view opens.
export function loadProfileTokens(): void {
  const card = maybeById('profile-tokens-card');
  if (!card) return;
  const approved = !!(auth.user && auth.user.status === 'approved');
  card.hidden = !approved;
  hideNewToken();
  if (approved) loadTokens();
  // /profile#tokens, the link from the /app page.
  if (approved && window.location.hash === '#tokens') {
    card.scrollIntoView({ block: 'start' });
    const label = maybeById('profile-token-label');
    if (label) label.focus({ preventScroll: true });
  }
}
