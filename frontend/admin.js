// Admin page: downloaders (workers) and download jobs, songs marked as
// needing replacement, CLI tokens, song requests, library management.
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
    loadWorkers();
    loadJobs();
    loadReports();
    loadTokens();
    loadRequests();
    loadLibrary();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden && !$('adm-main').hidden) { loadWorkers(); loadJobs(); loadReports(); } }, 10000);
  }
  let refreshTimer = null;

  // --- downloaders + jobs ---------------------------------------------------
  function ago(value) {
    if (!value) return 'never';
    const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  async function loadWorkers() {
    const list = $('adm-workers');
    try {
      const { workers, online, busy } = await api('GET', '/api/admin/workers');
      $('adm-workers-summary').textContent = `(${online} online${busy ? `, ${busy} busy` : ''})`;
      if (!workers.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">No downloader has connected yet.</li>'; return; }
      list.innerHTML = workers.map((w) => {
        const state = w.online ? (w.busy ? '<span class="badge badge-subtle theme-primary">busy</span>' : '<span class="badge badge-subtle theme-success">online</span>') : '<span class="badge badge-subtle theme-secondary">offline</span>';
        const owner = w.owner ? esc(w.owner) : '<span class="badge badge-subtle theme-warning">legacy token</span>';
        const machine = [w.hostname, [w.platform, w.arch].filter(Boolean).join('/'), w.os_release].filter(Boolean).map(esc).join(' · ');
        const versions = [`la ${w.cli_version || '?'}`, `yt-dlp ${w.ytdlp_version || '?'}`, `node ${w.node_version || '?'}`].map(esc).join(' · ');
        return `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item adm-worker">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${esc(w.name)} <span class="fs-sm fw-normal fg-2">· ${owner}</span></div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${machine}</div>
            <div class="fs-xs fg-3 text-break adm-item-sub">IP <span class="font-monospace">${esc(w.last_ip || '?')}</span> · ${versions}</div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${w.online ? `connected ${esc(ago(w.connected_since))}` : `last seen ${esc(ago(w.last_seen_at))}`} · ${w.jobs_done} done · ${w.jobs_failed} failed</div>
          </div>
          ${state}
        </li>`;
      }).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  const JOB_THEMES = { queued: 'theme-warning', assigned: 'theme-primary', done: 'theme-success', failed: 'theme-danger', cancelled: 'theme-secondary' };

  async function loadJobs() {
    const list = $('adm-jobs');
    const status = $('adm-job-status').value;
    try {
      const { jobs, counts } = await api('GET', `/api/admin/jobs?status=${encodeURIComponent(status)}`);
      $('adm-jobs-counts').textContent = `${counts.queued} waiting · ${counts.assigned} running · ${counts.done} done · ${counts.failed} failed`;
      if (!jobs.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">Nothing here.</li>'; return; }
      list.innerHTML = jobs.map((j) => {
        const where = j.worker ? `${j.status === 'assigned' ? 'on' : 'by'} ${esc(j.worker.name)}${j.worker.owner ? ` (${esc(j.worker.owner)})` : ''}` : '';
        const detail = j.status === 'failed' ? `${esc(j.error_code || '')} ${esc(j.error_message || '')}` : esc(j.progress || '');
        const action = j.status === 'queued' ? `<button class="btn btn-sm" data-job-cancel="${esc(j.id)}" type="button">Cancel</button>`
          : (j.status === 'failed' || j.status === 'cancelled') ? `<button class="btn btn-sm" data-job-retry="${esc(j.id)}" type="button">Retry</button>` : '';
        return `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item adm-job">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${esc(j.title || j.input)}</div>
            <div class="fs-xs fg-3 text-break adm-item-sub">${esc(j.source === 'request' ? 'song request' : j.kind)} · asked by ${esc(j.requested_by || '?')}${j.playlist_name ? ` · for ${esc(j.playlist_name)}` : ''} · ${esc(when(j.created_at))}${j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}</div>
            ${where || detail ? `<div class="fs-xs fg-3 text-break adm-item-sub">${[where, detail].filter(Boolean).join(' · ')}</div>` : ''}
          </div>
          <span class="badge badge-subtle ${JOB_THEMES[j.status] || 'theme-secondary'}">${esc(j.status === 'assigned' ? 'running' : j.status)}</span>
          ${action}
        </li>`;
      }).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-workers-refresh').addEventListener('click', () => { loadWorkers(); loadJobs(); });
  $('adm-job-status').addEventListener('change', loadJobs);
  $('adm-jobs').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-job-cancel], [data-job-retry]');
    if (!btn) return;
    btn.disabled = true;
    const id = btn.dataset.jobCancel || btn.dataset.jobRetry;
    try { await api('POST', `/api/admin/jobs/${encodeURIComponent(id)}/${btn.dataset.jobCancel ? 'cancel' : 'retry'}`); }
    catch (err) { alert(err.message); }
    loadJobs();
  });

  // --- tokens ---------------------------------------------------------------
  // All tokens, with their owner. Created by users on their profile page;
  // the admin can only revoke.
  function ownerLabel(t) {
    if (!t.owner) return '<span class="badge badge-subtle theme-warning">legacy, no owner</span>';
    return `<span class="fg-2">${esc(t.owner.name || t.owner.id)}</span>`;
  }

  async function loadTokens() {
    const list = $('adm-tokens');
    try {
      const { tokens } = await api('GET', '/api/admin/tokens');
      if (!tokens.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">No tokens yet.</li>'; return; }
      list.innerHTML = tokens.map((t) => `
        <li class="list-group-item d-flex align-items-center gap-3 adm-item adm-token${t.active ? '' : ' revoked fg-3'}">
          <div class="min-w-0 flex-grow-1 adm-item-main">
            <div class="fw-medium text-break adm-item-title">${esc(t.label)} <span class="fs-sm fw-normal">· ${ownerLabel(t)}</span></div>
            <div class="fs-xs fg-3 text-break adm-item-sub"><span class="font-monospace">${esc(t.prefix)}…</span> · created ${esc(when(t.created_at))}${t.last_used_at ? ' · last used ' + esc(when(t.last_used_at)) : ' · never used'}${t.revoked_at ? ' · revoked ' + esc(when(t.revoked_at)) : ''}</div>
          </div>
          ${t.active ? `<button class="btn-outline theme-danger btn-sm" type="button" data-revoke="${esc(t.id)}" data-name="${esc(t.label)}" data-owner="${esc(t.owner ? t.owner.name || '' : '')}">Revoke</button>` : ''}
        </li>`).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-tokens').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    const whose = btn.dataset.owner ? ` (${btn.dataset.owner})` : '';
    if (!confirm(`Revoke the token "${btn.dataset.name}"${whose}? The CLI using it stops working.`)) return;
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

  // --- needs replacement (songs marked broken) -------------------------------
  async function loadReports() {
    const list = $('adm-reports');
    try {
      const { songs, total } = await api('GET', '/api/library?reported=1&limit=500');
      const reports = songs.reduce((n, s) => n + (s.report_count || 0), 0);
      $('adm-reports-summary').textContent = total ? `(${total} song${total === 1 ? '' : 's'}, ${reports} report${reports === 1 ? '' : 's'})` : '';
      if (!songs.length) { list.innerHTML = '<li class="list-group-item app-empty adm-empty">Nothing is marked as broken.</li>'; return; }
      list.innerHTML = songs.map((s) => `
        <li class="list-group-item vstack gap-2 adm-item">
          <div class="d-flex align-items-start gap-3">
            <div class="min-w-0 flex-grow-1 adm-item-main">
              <div class="fw-medium text-break adm-item-title">${esc(s.title)} <span class="fg-3 fw-normal">— ${esc(s.artist)}</span>
                <span class="badge badge-subtle theme-warning">Broken${s.report_count > 1 ? ` · ${s.report_count}` : ''}</span></div>
              <div class="fs-xs fg-3 text-break adm-item-sub">${s.youtube_id ? 'YouTube ' + esc(s.youtube_id) + ' · ' : ''}id ${esc(s.id)}</div>
            </div>
            <button class="btn btn-sm" data-play="${esc(s.id)}" type="button">${previewId === s.id && !previewAudio.paused ? 'Pause' : 'Play'}</button>
            <button class="btn-outline theme-secondary btn-sm" data-dismiss-song="${esc(s.id)}" type="button">Dismiss all</button>
          </div>
          <ul class="list-unstyled vstack gap-1 mb-0 fs-sm">
            ${(s.reports || []).map((r) => `
            <li class="d-flex align-items-center gap-2">
              <span class="min-w-0 flex-grow-1 text-break"><span class="fg-2">${r.reason ? `“${esc(r.reason)}”` : '<span class="fg-3">No reason given</span>'}</span>
                <span class="fs-xs fg-3">— ${esc(r.reported_by)}, ${esc(when(r.updated_at || r.created_at))}</span></span>
              <button class="btn-text theme-secondary btn-xs" data-dismiss-report="${esc(r.id)}" type="button">Dismiss</button>
            </li>`).join('')}
          </ul>
        </li>`).join('');
    } catch (err) {
      list.innerHTML = `<li class="list-group-item app-empty adm-empty">${esc(err.message)}</li>`;
    }
  }

  $('adm-reports-refresh').addEventListener('click', loadReports);
  $('adm-reports').addEventListener('click', async (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { togglePreview(play.dataset.play); return; }
    const one = e.target.closest('[data-dismiss-report]');
    const all = e.target.closest('[data-dismiss-song]');
    if (!one && !all) return;
    (one || all).disabled = true;
    try {
      if (one) await api('POST', `/api/admin/library/reports/${encodeURIComponent(one.dataset.dismissReport)}/dismiss`);
      else await api('POST', `/api/admin/library/${encodeURIComponent(all.dataset.dismissSong)}/reports/dismiss`);
    } catch (err) { alert(`Could not dismiss: ${err.message}`); }
    loadReports();
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
            <div class="fs-xs fg-3 text-break adm-item-sub">${s.album ? esc(s.album) + ' · ' : ''}${s.youtube_id ? 'YouTube ' + esc(s.youtube_id) + ' · ' : ''}uploaded by ${s.uploaded_by_worker ? `${esc(s.uploaded_by_worker)} (${esc(s.uploaded_by)})` : esc(s.uploaded_by)}${s.requested_by ? ` · asked by ${esc(s.requested_by)}` : ''} · ${esc(when(s.created_at))}</div>
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
