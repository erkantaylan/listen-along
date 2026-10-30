// Admin page: CLI tokens, song requests, library management.
// Auth is the ADMIN_USER / ADMIN_PASSWORD cookie set by POST /api/admin/login,
// which also unlocks /dashboard.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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
    if (res.status === 401 && url !== '/api/admin/login') { showLogin(); }
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  function showLogin() {
    $('adm-main').hidden = true;
    $('adm-logout').hidden = true;
    $('adm-dashboard-link').hidden = true;
    $('adm-login').hidden = false;
    $('adm-username').focus();
  }

  // /dashboard sends logged-out visitors here with ?next=/dashboard.
  function goToNext() {
    if (new URLSearchParams(location.search).get('next') !== '/dashboard') return false;
    location.replace('/dashboard');
    return true;
  }

  function showMain() {
    if (goToNext()) return;
    $('adm-dashboard-link').hidden = false;
    $('adm-login').hidden = true;
    $('adm-main').hidden = false;
    $('adm-logout').hidden = false;
    loadTokens();
    loadRequests();
    loadLibrary();
  }

  // --- tokens ---------------------------------------------------------------
  async function loadTokens() {
    const list = $('adm-tokens');
    try {
      const { tokens } = await api('GET', '/api/admin/tokens');
      if (!tokens.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">No tokens yet.</li>'; return; }
      list.innerHTML = tokens.map((t) => `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item${t.active ? '' : ' revoked fg-3'}">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${esc(t.name)}</div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${esc(t.prefix)}… · created ${esc(when(t.created_at))}${t.last_used_at ? ' · last used ' + esc(when(t.last_used_at)) : ' · never used'}${t.revoked_at ? ' · revoked ' + esc(when(t.revoked_at)) : ''}</div>
          </div>
          ${t.active ? `<button class="btn-outline theme-danger btn-sm" data-revoke="${esc(t.id)}" data-name="${esc(t.name)}">Revoke</button>` : ''}
        </li>`).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('adm-token-name').value.trim();
    if (!name) return;
    try {
      const { token, record } = await api('POST', '/api/admin/tokens', { name });
      $('adm-new-token-name').textContent = record.name;
      $('adm-new-token-value').textContent = token;
      $('adm-new-token').hidden = false;
      $('adm-token-name').value = '';
      loadTokens();
    } catch (err) {
      alert(`Could not create token: ${err.message}`);
    }
  });

  $('adm-copy-token').addEventListener('click', async () => {
    const value = $('adm-new-token-value').textContent;
    try { await navigator.clipboard.writeText(value); $('adm-copy-token').textContent = 'Copied'; }
    catch { window.prompt('Copy the token:', value); }
    setTimeout(() => { $('adm-copy-token').textContent = 'Copy'; }, 2000);
  });

  $('adm-tokens').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    if (!confirm(`Revoke the token for "${btn.dataset.name}"? Their CLI will stop working.`)) return;
    try { await api('POST', `/api/admin/tokens/${encodeURIComponent(btn.dataset.revoke)}/revoke`); }
    catch (err) { alert(`Could not revoke: ${err.message}`); }
    loadTokens();
  });

  // --- requests -------------------------------------------------------------
  async function loadRequests() {
    const list = $('adm-requests');
    const status = $('adm-request-status').value;
    try {
      const { requests } = await api('GET', `/api/requests?status=${encodeURIComponent(status)}`);
      if (!requests.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">Nothing here.</li>'; return; }
      list.innerHTML = requests.map((r) => {
        const title = r.title || r.youtube_id || r.url || 'Unknown';
        const link = r.youtube_id ? `https://www.youtube.com/watch?v=${encodeURIComponent(r.youtube_id)}` : (r.url && /^https?:\/\//.test(r.url) ? r.url : null);
        return `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : esc(title)}</div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${r.artist ? esc(r.artist) + ' · ' : ''}by ${esc(r.requested_by)}${r.lobby_id ? ' in playlist ' + esc(r.lobby_id) : ''} · ${esc(when(r.created_at))} · ${esc(r.status)}</div>
          </div>
          ${r.status === 'pending' ? `<button class="btn btn-sm" data-dismiss="${esc(r.id)}">Dismiss</button>` : ''}
        </li>`;
      }).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-request-status').addEventListener('change', loadRequests);
  $('adm-requests').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-dismiss]');
    if (!btn) return;
    btn.disabled = true;
    try { await api('POST', `/api/requests/${encodeURIComponent(btn.dataset.dismiss)}/dismiss`); }
    catch (err) { alert(`Could not dismiss: ${err.message}`); }
    loadRequests();
  });

  // --- library --------------------------------------------------------------
  let searchTimer = null;

  // In-page preview: one shared <audio>, toggled by each song's Play button.
  const previewAudio = new Audio();
  previewAudio.preload = 'none';
  let previewId = null;

  function updatePlayButtons() {
    document.querySelectorAll('[data-play]').forEach((btn) => {
      btn.textContent = btn.dataset.play === previewId && !previewAudio.paused ? 'Pause' : 'Play';
    });
  }
  ['play', 'pause', 'ended'].forEach((ev) => previewAudio.addEventListener(ev, updatePlayButtons));

  function togglePreview(id) {
    if (previewId === id) {
      if (previewAudio.paused) previewAudio.play().catch(() => {});
      else previewAudio.pause();
      return;
    }
    previewId = id;
    previewAudio.src = `/api/library/${encodeURIComponent(id)}/file`;
    previewAudio.play().catch((err) => alert(`Could not play: ${err.message}`));
    updatePlayButtons();
  }

  async function loadLibrary() {
    const list = $('adm-library');
    const q = $('adm-library-search').value.trim();
    try {
      const { songs, total } = await api('GET', `/api/library?limit=500&q=${encodeURIComponent(q)}`);
      $('adm-library-total').textContent = `(${total})`;
      if (!songs.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">No songs.</li>'; return; }
      list.innerHTML = songs.map((s) => `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${esc(s.title)} <span class="fg-3 fw-normal">— ${esc(s.artist)}</span></div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${s.album ? esc(s.album) + ' · ' : ''}${s.youtube_id ? 'YouTube ' + esc(s.youtube_id) + ' · ' : ''}uploaded by ${esc(s.uploaded_by)} · ${esc(when(s.created_at))}</div>
          </div>
          <button class="btn btn-sm" data-play="${esc(s.id)}" type="button">${previewId === s.id && !previewAudio.paused ? 'Pause' : 'Play'}</button>
          <button class="btn-outline theme-danger btn-sm" data-delete="${esc(s.id)}" data-title="${esc(s.title)}">Delete</button>
        </li>`).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-library-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadLibrary, 250);
  });
  $('adm-library').addEventListener('click', async (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { togglePreview(play.dataset.play); return; }
    const btn = e.target.closest('[data-delete]');
    if (!btn) return;
    if (!confirm(`Delete "${btn.dataset.title}" from the library? The file is removed from the server.`)) return;
    try { await api('DELETE', `/api/admin/library/${encodeURIComponent(btn.dataset.delete)}`); }
    catch (err) { alert(`Could not delete: ${err.message}`); }
    loadLibrary();
  });

  // --- auth -----------------------------------------------------------------
  $('adm-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('adm-login-error');
    err.hidden = true;
    try {
      await api('POST', '/api/admin/login', { username: $('adm-username').value, password: $('adm-password').value });
      $('adm-password').value = '';
      showMain();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('adm-logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout').catch(() => {});
    showLogin();
  });

  (async function init() {
    try {
      const status = await api('GET', '/api/admin/status');
      if (!status.enabled) { $('adm-disabled').hidden = false; return; }
      if (status.authenticated) showMain(); else showLogin();
    } catch (err) {
      $('adm-disabled').textContent = `Could not reach the server: ${err.message}`;
      $('adm-disabled').hidden = false;
    }
  })();
})();
