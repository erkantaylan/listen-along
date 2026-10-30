// Download box + "Your downloads" (the library overlay's Download tab):
// queue a download job (POST /api/jobs) for a downloader — someone's
// `la worker` — and follow its status live (socket jobs:update /
// workers:update). Song requests made in a playlist are jobs too and show up
// in the same list.
import { state } from './state.js';
import { showToast } from './ui.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const dl = {
  jobs: [],
  workers: { online: 0, idle: 0, busy: 0 },
  loaded: false,
  visible: false,
};

const ACTIVE = new Set(['queued', 'assigned']);

function youtubeIdOf(text) {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/.exec(text || '');
  return m ? m[1] : null;
}

function thumbHtml(job) {
  const yt = job.kind === 'video' ? youtubeIdOf(job.input) : null;
  if (yt) return `<img class="app-thumb libpage-thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(yt)}/default.jpg" alt="" loading="lazy">`;
  const icon = job.kind === 'playlist'
    ? '<path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>'
    : '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
  return `<div class="app-thumb libpage-thumb"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon}</svg></div>`;
}

function workerLabel(w) {
  if (!w) return 'a downloader';
  return w.owner ? `${w.name} (${w.owner})` : w.name;
}

/** One line saying where the job is. */
export function jobStatusText(job, workers = dl.workers) {
  switch (job.status) {
    case 'queued':
      if (!workers.online) return 'Waiting for a downloader — none is online right now';
      return workers.idle ? 'Queued' : 'Queued — every downloader is busy';
    case 'assigned':
      return `Downloading on ${workerLabel(job.worker)}${job.progress ? ` · ${job.progress}` : ''}`;
    case 'done': {
      const s = job.summary;
      let what = 'Done';
      if (s && s.total > 1) what = `Done: ${s.uploaded} uploaded, ${s.skipped} already in the library${s.failed ? `, ${s.failed} failed` : ''}`;
      else if (job.song) what = `In the library: ${job.song.title || ''}${job.song.artist ? ` — ${job.song.artist}` : ''}`;
      else if (job.progress) what = `Done · ${job.progress}`;
      const by = job.worker ? ` · by ${workerLabel(job.worker)}` : '';
      return `${what}${by}${job.playlist_name ? ` · added to ${job.playlist_name}` : ''}`;
    }
    case 'failed':
      return `Failed: ${job.error_message || 'could not download'}${job.error_code ? ` (${job.error_code})` : ''}`;
    case 'cancelled':
      return job.progress ? `Cancelled · ${job.progress}` : 'Cancelled';
    default:
      return job.status;
  }
}

const BADGES = {
  queued: ['theme-warning', 'waiting'],
  assigned: ['theme-primary', 'downloading'],
  done: ['theme-success', 'done'],
  failed: ['theme-danger', 'failed'],
  cancelled: ['theme-secondary', 'cancelled'],
};

function jobHtml(job) {
  const [theme, label] = BADGES[job.status] || ['theme-secondary', job.status];
  const title = job.title || job.input;
  const origin = job.source === 'request' ? 'Requested in a playlist' : ({ playlist: 'YouTube playlist', video: 'YouTube video', spotify: 'Spotify track', search: 'Search' }[job.kind] || job.kind);
  const target = job.playlist_name && job.status !== 'done' ? ` · for ${escapeHtml(job.playlist_name)}` : '';
  let action = '';
  if (job.status === 'queued' && job.source === 'web') action = `<button class="btn btn-sm dl-cancel" type="button" data-job="${escapeHtml(job.id)}">Cancel</button>`;
  else if (job.status === 'failed' || job.status === 'cancelled') action = `<button class="btn btn-sm dl-retry" type="button" data-job="${escapeHtml(job.id)}">Retry</button>`;
  return `<li class="list-group-item libpage-item dl-item" data-job="${escapeHtml(job.id)}">
    ${thumbHtml(job)}
    <div class="libpage-info min-w-0">
      <div class="fw-medium text-truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="fs-sm fg-2 libpage-meta dl-status">${escapeHtml(jobStatusText(job))}</div>
      <div class="fs-xs fg-3 libpage-meta">${escapeHtml(origin)}${target} · ${escapeHtml(new Date(job.created_at).toLocaleString())}</div>
    </div>
    <span class="badge badge-subtle ${theme} libpage-badge">${escapeHtml(label)}</span>
    ${action}
  </li>`;
}

function renderWorkers() {
  const el = $('dl-workers');
  if (!el) return;
  const w = dl.workers;
  const dot = `<span class="dl-dot${w.online ? ' online' : ''}" aria-hidden="true"></span>`;
  el.innerHTML = w.online
    ? `${dot}${w.online} downloader${w.online === 1 ? '' : 's'} online${w.busy ? ` (${w.busy} busy)` : ''}`
    : `${dot}No downloader online — jobs wait until someone runs <code>la worker</code>`;
}

function renderCount() {
  const el = $('libpage-downloads-count');
  if (!el) return;
  const n = dl.jobs.filter((j) => ACTIVE.has(j.status)).length;
  el.textContent = n ? String(n) : '';
  el.hidden = !n;
}

function renderList() {
  renderCount();
  const list = $('dl-list');
  if (!list) return;
  if (!dl.jobs.length) {
    list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${dl.loaded ? 'Nothing yet. Downloads you start here, and songs you request in a playlist, show up here.' : 'Loading…'}</li>`;
    return;
  }
  list.innerHTML = dl.jobs.map(jobHtml).join('');
}

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function loadDownloads() {
  try {
    const data = await api('GET', '/api/jobs');
    dl.jobs = data.jobs || [];
    if (data.workers) dl.workers = data.workers;
    dl.loaded = true;
  } catch (err) {
    dl.loaded = true;
    const list = $('dl-list');
    if (list) list.innerHTML = `<li class="list-group-item app-empty libpage-empty">Could not load downloads: ${escapeHtml(err.message)}</li>`;
    return;
  }
  renderWorkers();
  renderList();
}

async function loadPlaylists() {
  const select = $('dl-playlist');
  if (!select) return;
  const keep = select.value;
  try {
    const { playlists } = await api('GET', '/api/playlists');
    const opts = ['<option value="">The library only</option>'].concat((playlists || []).map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}${p.visibility === 'private' ? ' (private)' : ''}</option>`));
    select.innerHTML = opts.join('');
    const want = keep || state.lobbyId || '';
    if ([...select.options].some((o) => o.value === want)) select.value = want;
  } catch { /* keep "library only" */ }
}

/** The Download tab became visible. */
export function showDownloads() {
  dl.visible = true;
  loadPlaylists();
  loadDownloads();
}

export function hideDownloads() {
  dl.visible = false;
}

/** socket jobs:update { job, workers } — one of my jobs changed. */
export function handleJobUpdate(payload) {
  const job = payload && payload.job;
  if (!job) return;
  if (payload.workers) dl.workers = payload.workers;
  const i = dl.jobs.findIndex((j) => j.id === job.id);
  const before = i >= 0 ? dl.jobs[i].status : null;
  if (i >= 0) dl.jobs[i] = job; else dl.jobs.unshift(job);
  renderWorkers();
  renderList();
  if (before !== job.status && !dl.visible) {
    const name = job.title || job.input;
    if (job.status === 'done' && job.source === 'web') showToast(`Downloaded “${name}”${job.playlist_name ? ` — added to ${job.playlist_name}` : ''}`, 'success');
    else if (job.status === 'failed') showToast(`Could not download “${name}”: ${job.error_message || job.error_code || 'failed'}`, 'error');
  }
}

/** socket workers:update { online, idle, busy } */
export function handleWorkersUpdate(stats) {
  if (!stats) return;
  dl.workers = stats;
  renderWorkers();
  if (dl.jobs.some((j) => j.status === 'queued')) renderList();
}

export function setupDownloads() {
  const form = $('dl-form');
  if (!form) return;
  const err = $('dl-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const input = $('dl-input');
    const text = input.value.trim();
    if (!text) { err.textContent = 'Paste a YouTube or Spotify link, or type a song to search for.'; err.hidden = false; input.focus(); return; }
    const btn = $('dl-submit');
    btn.disabled = true;
    try {
      const playlistId = $('dl-playlist').value || undefined;
      const data = await api('POST', '/api/jobs', { input: text, playlist_id: playlistId });
      input.value = '';
      if (data.job) {
        if (data.workers) dl.workers = data.workers;
        dl.jobs = [data.job, ...dl.jobs.filter((j) => j.id !== data.job.id)];
        renderWorkers();
        renderList();
        showToast(dl.workers.online ? 'Download queued' : 'Queued — it starts when a downloader comes online', 'info');
      } else if (data.existing) {
        showToast(`“${data.existing.title}” is already in the library${data.added_to_playlist ? ' — added to the playlist' : ''}`, 'info');
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  $('dl-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.dl-cancel, .dl-retry');
    if (!btn) return;
    btn.disabled = true;
    try {
      const { job } = await api('POST', `/api/jobs/${encodeURIComponent(btn.dataset.job)}/${btn.classList.contains('dl-cancel') ? 'cancel' : 'retry'}`);
      handleJobUpdate({ job });
    } catch (ex) {
      showToast(ex.message, 'error');
      btn.disabled = false;
    }
  });
}
