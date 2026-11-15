// "Your activity" card on the profile page (GET /api/profile/activity, which
// only ever answers for the signed-in user): songs I uploaded (also through
// my downloaders), songs I asked for (and whether / by whose downloader they
// were fulfilled), requests my downloaders fulfilled (and who asked), and my
// downloaders (`la worker`). Machine details of downloaders are admin-only
// and never come here.
import { auth } from '../../shared/state.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { ApiError, ProfileActivity } from '../../shared/types.ts';

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

function when(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

const PAGE_SIZE = 10;
type ActivityTab = 'uploaded' | 'asked' | 'fulfilled' | 'workers';
const act: { data: ProfileActivity | null; tab: ActivityTab; offsets: Record<ActivityTab, number>; seq: number } = { data: null, tab: 'uploaded', offsets: { uploaded: 0, asked: 0, fulfilled: 0, workers: 0 }, seq: 0 };

function tabTotal(): number {
  const d = act.data as ProfileActivity;
  const c: Partial<ProfileActivity['counts']> = d.counts || {};
  if (act.tab === 'uploaded') return c.uploaded || 0;
  if (act.tab === 'asked') return (c.asked || 0) + (c.downloads || 0);
  if (act.tab === 'fulfilled') return c.fulfilled_by_my_workers || 0;
  return d.workers.length;
}

function renderPager(): void {
  const pager = maybeById('profile-activity-pager');
  if (!pager) return;
  const total = tabTotal();
  const offset = act.offsets[act.tab];
  pager.hidden = total <= PAGE_SIZE;
  byId('profile-activity-range').textContent = `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`;
  byId<HTMLButtonElement>('profile-activity-prev').disabled = offset === 0;
  byId<HTMLButtonElement>('profile-activity-next').disabled = offset + PAGE_SIZE >= total;
}

function goToPage(delta: number): void {
  act.offsets[act.tab] = Math.max(act.offsets[act.tab] + delta * PAGE_SIZE, 0);
  loadProfileActivity();
}

function song(s: { title: string | null; artist: string | null }): string {
  return `${esc(s.title || 'Unknown')}${s.artist ? ` <span class="fg-3">— ${esc(s.artist)}</span>` : ''}`;
}

function row(main: string, sub: string, badge = ''): string {
  return `<li class="list-group-item d-flex align-items-center gap-3">
    <div class="min-w-0 flex-grow-1">
      <div class="text-truncate">${main}</div>
      <div class="fs-xs fg-3 text-break">${sub}</div>
    </div>${badge}
  </li>`;
}

const empty = (text: string) => `<li class="list-group-item app-empty">${esc(text)}</li>`;
const badge = (theme: string, text: string) => `<span class="badge badge-subtle ${theme}">${esc(text)}</span>`;

function render(): void {
  const list = maybeById('profile-activity-list');
  const d = act.data;
  if (!list || !d) return;
  document.querySelectorAll<HTMLElement>('[data-activity-tab]').forEach((b) => b.classList.toggle('active', b.dataset.activityTab === act.tab));
  if (act.tab === 'uploaded') {
    list.innerHTML = d.uploaded.length ? d.uploaded.map((s) => row(song(s),
      [s.worker ? `via your downloader ${esc(s.worker)}` : 'uploaded with the CLI', s.requested_by ? `asked by ${esc(s.requested_by)}` : '', when(s.created_at)].filter(Boolean).join(' · ')))
      .join('') : empty('Nothing yet. Songs you upload with the CLI, or your downloaders upload, show up here.');
  } else if (act.tab === 'asked') {
    const reqs = d.asked.map((r) => {
      const by = r.fulfilled_by ? `uploaded by ${r.fulfilled_by.worker ? `${esc(r.fulfilled_by.worker)} (${esc(r.fulfilled_by.name)})` : esc(r.fulfilled_by.name)}` : '';
      const theme = ({ pending: 'theme-warning', fulfilled: 'theme-success', dismissed: 'theme-secondary' } as Record<string, string>)[r.status] || 'theme-secondary';
      const label = ({ pending: 'waiting', fulfilled: 'fulfilled', dismissed: 'not found' } as Record<string, string>)[r.status] || r.status;
      return { at: r.created_at, html: row(r.song ? song(r.song) : song(r), ['requested in a playlist', by, when(r.created_at)].filter(Boolean).join(' · '), badge(theme, label)) };
    });
    const jobs = (d.downloads || []).map((j) => {
      const theme = ({ queued: 'theme-warning', assigned: 'theme-primary', done: 'theme-success', failed: 'theme-danger', cancelled: 'theme-secondary' } as Record<string, string>)[j.status] || 'theme-secondary';
      const by = j.worker ? `${j.status === 'assigned' ? 'downloading on' : 'by'} ${esc(j.worker.name)}${j.worker.owner ? ` (${esc(j.worker.owner)})` : ''}` : '';
      const what = j.song ? song(j.song) : esc(j.title || j.input);
      return { at: j.created_at, html: row(what, [j.replace ? 'Replace from a link' : 'Download box', by, j.error_code ? esc(j.error_code) : '', when(j.created_at)].filter(Boolean).join(' · '), badge(theme, j.status === 'assigned' ? 'downloading' : j.status)) };
    });
    const all = [...reqs, ...jobs].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    list.innerHTML = all.length ? all.map((x) => x.html).join('') : empty('Nothing yet. Songs you request in a playlist or download from the library show up here.');
  } else if (act.tab === 'fulfilled') {
    list.innerHTML = d.fulfilled_by_my_workers.length ? d.fulfilled_by_my_workers.map((s) => row(song(s),
      [`asked by ${esc(s.requested_by || 'someone')}`, s.worker ? `on ${esc(s.worker)}` : '', when(s.created_at)].filter(Boolean).join(' · '))).join('')
      : empty('Nothing yet. Run `la worker` to fetch songs people ask for.');
  } else {
    const offset = act.offsets.workers;
    list.innerHTML = d.workers.length ? d.workers.slice(offset, offset + PAGE_SIZE).map((w) => row(esc(w.name),
      [`${w.jobs_done} job${w.jobs_done === 1 ? '' : 's'} done`, w.jobs_failed ? `${w.jobs_failed} failed` : '', w.last_connected_at ? `last connected ${when(w.last_connected_at)}` : ''].filter(Boolean).join(' · '),
      w.online ? badge(w.busy ? 'theme-primary' : 'theme-success', w.busy ? 'busy' : 'online') : badge('theme-secondary', 'offline'))).join('')
      : empty('No downloaders yet. Create a CLI token above and run `la worker` on a computer at home.');
  }
  renderPager();
}

function renderCounts(): void {
  const d = act.data as ProfileActivity;
  const c: Partial<ProfileActivity['counts']> = d.counts || {};
  const set = (k: string, n: number | undefined) => { const el = document.querySelector(`[data-activity-count="${k}"]`); if (el) el.textContent = String(n || 0); };
  set('uploaded', c.uploaded);
  set('asked', (c.asked || 0) + (c.downloads || 0));
  set('fulfilled', c.fulfilled_by_my_workers);
  set('workers', d.workers.length);
  const summary = maybeById('profile-activity-summary');
  if (summary) {
    summary.textContent = `${c.uploaded || 0} song${c.uploaded === 1 ? '' : 's'} uploaded (${c.uploaded_by_workers || 0} by your downloaders) · `
      + `${c.asked || 0} requested, ${c.asked_fulfilled || 0} fulfilled · ${c.downloads || 0} downloads started · `
      + `${c.fulfilled_by_my_workers || 0} requests fulfilled by your downloaders`;
  }
}

export async function loadProfileActivity(): Promise<void> {
  const card = maybeById('profile-activity-card');
  if (!card) return;
  const approved = !!(auth.user && auth.user.status === 'approved');
  card.hidden = !approved;
  if (!approved) return;
  const seq = ++act.seq;
  try {
    // Downloaders are few and always come whole; the other tabs are paged here.
    const offset = act.tab === 'workers' ? 0 : act.offsets[act.tab];
    const res = await fetch(`/api/profile/activity?limit=${PAGE_SIZE}&offset=${offset}`, { credentials: 'same-origin' });
    const data = await res.json() as ProfileActivity & Partial<ApiError>;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (seq !== act.seq) return; // a newer tab or page was asked for meanwhile
    act.data = data;
    // The list shrank under the current page: step back to the last one.
    const total = tabTotal();
    if (act.offsets[act.tab] >= total && act.offsets[act.tab] > 0) {
      act.offsets[act.tab] = Math.max(Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE, 0);
      return loadProfileActivity();
    }
    renderCounts();
    render();
  } catch (err) {
    const list = maybeById('profile-activity-list');
    if (list) list.innerHTML = empty(`Could not load your activity: ${(err as Error).message}`);
  }
}

export function setupProfileActivity(): void {
  document.querySelectorAll<HTMLElement>('[data-activity-tab]').forEach((b) => b.addEventListener('click', () => {
    act.tab = b.dataset.activityTab as ActivityTab;
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    loadProfileActivity();
  }));
  maybeById('profile-activity-prev')?.addEventListener('click', () => goToPage(-1));
  maybeById('profile-activity-next')?.addEventListener('click', () => goToPage(1));
}
