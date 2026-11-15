// Download box + "Your downloads" (the library overlay's Download tab):
// queue a download job (POST /api/jobs) for a downloader — someone's
// `la worker` — and follow its status live (socket jobs:update /
// workers:update). Song requests made in a playlist are jobs too and show up
// in the same list.
import { state } from '../../shared/state.ts';
import { showToast, t } from '../../shared/ui.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import { pickSongs } from '../picker/pick-dialog.ts';
import { jobPayload } from '../picker/pick-rules.ts';
import type {
  ActivityRow, ApiError, DownloadJob, JobStatus, JobsListResponse, JobsUpdatePayload, LibrarySong, PlaylistListResponse, WorkerStats,
} from '../../shared/types.ts';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number> = {}): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

/** Downloader counts: the server's WorkerStats, or the start value without can_replace. */
export type WorkerCounts = Omit<WorkerStats, 'can_replace'> & Partial<Pick<WorkerStats, 'can_replace'>>;

/** What jobStatusText reads: a DownloadJob, or an activity row (activity.ts words error_message itself). */
export type StatusJob = Pick<ActivityRow, 'status' | 'replace' | 'worker' | 'progress' | 'summary' | 'song' | 'playlist_name' | 'error_code'>
  & { error_message?: string | null };

/** A change the song dialog follows: a job (jobs:update, an answer) and the downloader counts. */
export interface JobChange {
  job?: DownloadJob;
  workers: WorkerCounts;
}

// POST /api/jobs as the Download box reads it: CreatePickedJobsResponse (with
// picks) or CreateJobResponse (without); the fields of either.
interface CreateJobsAnswer {
  jobs?: DownloadJob[];
  job?: DownloadJob | null;
  existing?: LibrarySong | LibrarySong[];
  added_to_playlist?: number | boolean;
  workers?: WorkerStats;
  failed?: string[];
}

const dl: { jobs: DownloadJob[]; workers: WorkerCounts; loaded: boolean; visible: boolean } = {
  jobs: [],
  workers: { online: 0, idle: 0, busy: 0 },
  loaded: false,
  visible: false,
};

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'assigned']);

// Others that follow jobs live (the song dialog). A listener that returns true
// is showing this job's change itself, so no toast.
const changeListeners = new Set<(change: JobChange) => boolean | void>();
export function onJobChange(fn: (change: JobChange) => boolean | void): () => boolean {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function notifyChange(change: JobChange): boolean {
  let shown = false;
  changeListeners.forEach((fn) => { try { if (fn(change) === true) shown = true; } catch (err) { console.error(err); } });
  return shown;
}

function youtubeIdOf(text: string | null): string | null {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/.exec(text || '');
  return m ? m[1] : null;
}

export function thumbHtml(job: Pick<ActivityRow, 'kind' | 'input'>, cls = 'libpage-thumb'): string {
  const yt = job.kind === 'video' ? youtubeIdOf(job.input) : null;
  if (yt) return `<img class="app-thumb ${cls}" src="https://i.ytimg.com/vi/${encodeURIComponent(yt)}/default.jpg" alt="" loading="lazy">`;
  const icon = job.kind === 'playlist'
    ? '<path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>'
    : '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
  return `<div class="app-thumb ${cls}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon}</svg></div>`;
}

function workerLabel(w: DownloadJob['worker'] | undefined): string {
  if (!w) return 'a downloader';
  return w.owner ? `${w.name} (${w.owner})` : w.name;
}

/** One line saying where the job is. */
export function jobStatusText(job: StatusJob, workers: WorkerCounts = dl.workers): string {
  switch (job.status) {
    case 'queued':
      // An older downloader cannot run these: it may be online and still no help.
      if (job.replace && workers.online && !workers.can_replace) return 'Waiting for a downloader — the ones online are too old to replace songs (la 0.2.0 or newer)';
      if (!workers.online) return 'Waiting for a downloader — none is online right now';
      return workers.idle ? 'Queued' : 'Queued — every downloader is busy';
    case 'assigned':
      return `Downloading on ${workerLabel(job.worker)}${job.progress ? ` · ${job.progress}` : ''}`;
    case 'done': {
      if (job.replace) return `Replaced the audio${job.worker ? ` · by ${workerLabel(job.worker)}` : ''}`;
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

export const BADGES: Readonly<Record<JobStatus, readonly [string, string]>> = {
  queued: ['theme-warning', 'waiting'],
  assigned: ['theme-primary', 'downloading'],
  done: ['theme-success', 'done'],
  failed: ['theme-danger', 'failed'],
  cancelled: ['theme-secondary', 'cancelled'],
};

function jobHtml(job: DownloadJob): string {
  const [theme, label] = BADGES[job.status] || ['theme-secondary', job.status];
  const title = job.title || job.input;
  const origin = job.replace ? 'Replacing this song from a link' : job.source === 'request' ? 'Requested in a playlist' : ({ playlist: 'YouTube playlist', video: 'YouTube video', spotify: 'Spotify track', search: 'Search' }[job.kind] || job.kind);
  const target = job.playlist_name && job.status !== 'done' ? ` · for ${escapeHtml(job.playlist_name)}` : '';
  let action = '';
  if (job.status === 'queued' && (job.source === 'web' || job.source === 'replace')) action = `<button class="btn btn-sm dl-cancel" type="button" data-job="${escapeHtml(job.id)}">Cancel</button>`;
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
  const el = maybeById('dl-workers');
  if (!el) return;
  const w = dl.workers;
  const dot = `<span class="dl-dot${w.online ? ' online' : ''}" aria-hidden="true"></span>`;
  el.innerHTML = w.online
    ? `${dot}${w.online} downloader${w.online === 1 ? '' : 's'} online${w.busy ? ` (${w.busy} busy)` : ''}`
    : `${dot}No downloader online — jobs wait until someone runs <code>la worker</code>`;
}

function renderCount() {
  const el = maybeById('libpage-downloads-count');
  if (!el) return;
  const n = dl.jobs.filter((j) => ACTIVE.has(j.status)).length;
  el.textContent = n ? String(n) : '';
  el.hidden = !n;
}

function renderList() {
  renderCount();
  const list = maybeById('dl-list');
  if (!list) return;
  if (!dl.jobs.length) {
    list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${dl.loaded ? 'Nothing yet. Downloads you start here, and songs you request in a playlist, show up here.' : 'Loading…'}</li>`;
    return;
  }
  list.innerHTML = dl.jobs.map(jobHtml).join('');
}

// T: what the route answers when it succeeds.
async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const opts: RequestInit & { headers: Record<string, string> } = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = {} as T & Partial<ApiError>;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function loadDownloads(): Promise<void> {
  try {
    const data = await api<JobsListResponse>('GET', '/api/jobs');
    dl.jobs = data.jobs || [];
    if (data.workers) dl.workers = data.workers;
    dl.loaded = true;
  } catch (err) {
    dl.loaded = true;
    const list = maybeById('dl-list');
    if (list) list.innerHTML = `<li class="list-group-item app-empty libpage-empty">Could not load downloads: ${escapeHtml((err as Error).message)}</li>`;
    return;
  }
  renderWorkers();
  renderList();
}

async function loadPlaylists() {
  const select = maybeById<HTMLSelectElement>('dl-playlist');
  if (!select) return;
  const keep = select.value;
  try {
    const { playlists } = await api<PlaylistListResponse>('GET', '/api/playlists');
    const opts = ['<option value="">The library only</option>'].concat((playlists || []).map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}${p.visibility === 'private' ? ' (private)' : ''}</option>`));
    select.innerHTML = opts.join('');
    const want = keep || state.lobbyId || '';
    if ([...select.options].some((o) => o.value === want)) select.value = want;
  } catch { /* keep "library only" */ }
}

/** The Download tab became visible. */
export function showDownloads(): void {
  dl.visible = true;
  loadPlaylists();
  loadDownloads();
}

export function hideDownloads(): void {
  dl.visible = false;
}

/** socket jobs:update { job, workers } — one of my jobs changed. */
export function handleJobUpdate(payload: Partial<JobsUpdatePayload> | null | undefined): void {
  const job = payload && payload.job;
  if (!job) return;
  if (payload.workers) dl.workers = payload.workers;
  const i = dl.jobs.findIndex((j) => j.id === job.id);
  const before = i >= 0 ? dl.jobs[i].status : null;
  if (i >= 0) dl.jobs[i] = job; else dl.jobs.unshift(job);
  renderWorkers();
  // A running job reports progress every second: touch only its status line,
  // so the other rows' buttons keep focus and thumbs don't reload.
  const statusLine = before === 'assigned' && job.status === 'assigned'
    ? maybeById('dl-list')?.querySelector(`.dl-item[data-job="${CSS.escape(job.id)}"] .dl-status`)
    : null;
  if (statusLine) statusLine.textContent = jobStatusText(job);
  else renderList();
  const shown = notifyChange({ job, workers: dl.workers });
  if (before !== job.status && !dl.visible && !shown) {
    const name = job.title || job.input;
    if (job.status === 'done' && job.replace) showToast(`Replaced the audio of “${job.replace.title || name}”`, 'success');
    else if (job.status === 'failed' && job.replace) showToast(`Could not replace “${job.replace.title || name}”: ${job.error_message || job.error_code || 'failed'}`, 'error');
    else if (job.status === 'done' && job.source === 'web') showToast(`Downloaded “${name}”${job.playlist_name ? ` — added to ${job.playlist_name}` : ''}`, 'success');
    else if (job.status === 'failed') showToast(`Could not download “${name}”: ${job.error_message || job.error_code || 'failed'}`, 'error');
  }
}

/** socket workers:update { online, idle, busy } */
export function handleWorkersUpdate(stats: WorkerStats | null | undefined): void {
  if (!stats) return;
  dl.workers = stats;
  notifyChange({ workers: stats });
  renderWorkers();
  if (dl.jobs.some((j) => j.status === 'queued')) renderList();
}

export function setupDownloads(): void {
  const form = maybeById<HTMLFormElement>('dl-form');
  if (!form) return;
  const err = byId('dl-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const input = byId<HTMLInputElement>('dl-input');
    const text = input.value.trim();
    if (!text) { err.textContent = 'Paste a YouTube or Spotify link, or type a song to search for.'; err.hidden = false; input.focus(); return; }
    const btn = byId<HTMLButtonElement>('dl-submit');
    btn.disabled = true;
    try {
      // Which video? Asked first (pick-dialog.ts); the playlist is read after,
      // so it can still be changed while the dialog is open.
      const picked = await pickSongs({ input: text, returnFocus: input });
      if (!picked) return;
      const playlistId = byId<HTMLSelectElement>('dl-playlist').value || undefined;
      const data = await api<CreateJobsAnswer>('POST', '/api/jobs', picked.picks ? jobPayload(picked.picks, playlistId) : { input: text, playlist_id: playlistId });
      if (input.value.trim() === text) input.value = '';
      // Part of a selection failed: the rest is queued, so the same text must not be sent again.
      if (data.failed && data.failed.length) {
        err.textContent = tf('pick.someFailed', '{failed} of {total} could not be queued. The others are in your downloads; add the missing ones again one by one.', { failed: data.failed.length, total: (picked.picks as string[]).length });
        err.hidden = false;
      }
      const created = data.jobs || (data.job ? [data.job] : []);
      const existing = Array.isArray(data.existing) ? data.existing : (data.existing ? [data.existing] : []);
      if (created.length) {
        if (data.workers) dl.workers = data.workers;
        const ids = new Set(created.map((j) => j.id));
        dl.jobs = [...created, ...dl.jobs.filter((j) => !ids.has(j.id))];
        renderWorkers();
        renderList();
        const waiting = !dl.workers.online;
        if (created.length === 1) showToast(waiting ? 'Queued — it starts when a downloader comes online' : 'Download queued', 'info');
        else if (waiting) showToast(tf('pick.queuedManyWaiting', '{count} downloads queued. They start when a downloader comes online', { count: created.length }), 'info');
        else showToast(tf('pick.queuedMany', '{count} downloads queued', { count: created.length }), 'info');
      } else if (existing.length === 1) {
        showToast(`“${existing[0].title}” is already in the library${data.added_to_playlist ? ' — added to the playlist' : ''}`, 'info');
      } else if (existing.length) {
        showToast(tf('pick.allInLibrary', 'All {count} are already in the library', { count: existing.length }) + (data.added_to_playlist ? ` — ${tf('pick.addedToPlaylist', '{count} added to the playlist', { count: data.added_to_playlist as number })}` : ''), 'info');
      }
    } catch (ex) {
      err.textContent = (ex as Error).message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  byId('dl-list').addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.dl-cancel, .dl-retry');
    if (!btn) return;
    btn.disabled = true;
    try {
      const { job } = await api<{ job: DownloadJob }>('POST', `/api/jobs/${encodeURIComponent(btn.dataset.job as string)}/${btn.classList.contains('dl-cancel') ? 'cancel' : 'retry'}`);
      handleJobUpdate({ job });
    } catch (ex) {
      showToast((ex as Error).message, 'error');
      btn.disabled = false;
    }
  });
}
