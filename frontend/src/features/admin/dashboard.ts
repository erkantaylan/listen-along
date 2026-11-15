// Admin dashboard: overview, public playlists, users, plus the sections in
// dashboard-admin.ts. Behind its own login (POST /api/admin/login, the la_admin
// cookie); the page holds no data until that succeeds.
import { state, elements, viewActivators, setDashboardInterval } from '../../shared/state.ts';
import { showView, showToast, escapeHtml, formatUptime, formatAge, formatDuration, formatFileSize, toLower, t, notifyViewChange } from '../../shared/ui.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { AccountStatus, AdminSettings, AdminStatus, ApiError, DashboardLobby, DashboardStats, DashboardUser, DashboardUserStatusResponse, DashboardUsersResponse } from '../../shared/types.ts';
import { startAdminSections, stopAdminSections } from './dashboard-admin.ts';

let dashboardUsers: DashboardUser[] = [];
let statsTimer: ReturnType<typeof setInterval> | null = null;
let onAdminReady: () => void = () => {};

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string>) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

function initSidebarNav(): void {
  const sidebar = byId('dashboard-sidebar');
  const overlay = byId('sidebar-overlay');
  const hamburger = maybeById('sidebar-hamburger');
  const closeBtn = maybeById('sidebar-close');
  const titleEl = maybeById('dashboard-section-title');

  const openSidebar = () => { sidebar.classList.add('open'); overlay.classList.add('open'); };
  const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };

  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  const select = (link: HTMLElement) => {
    document.querySelectorAll('.sidebar-link').forEach(l => { l.classList.remove('active'); l.removeAttribute('aria-current'); });
    link.classList.add('active');
    link.setAttribute('aria-current', 'page');
    document.querySelectorAll('.dashboard-section').forEach(s => s.classList.remove('active'));
    const section = document.querySelector(`.dashboard-section[data-section="${link.dataset.section}"]`);
    if (section) section.classList.add('active');
    if (titleEl) titleEl.textContent = link.textContent.trim();
  };

  document.querySelectorAll<HTMLElement>('.sidebar-link[data-section]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      select(link);
      history.replaceState(history.state, '', `#${link.dataset.section}`);
      closeSidebar();
    });
  });
  // #section survives a reload and can be linked to.
  const fromHash = document.querySelector<HTMLElement>(`.sidebar-link[data-section="${CSS.escape(window.location.hash.slice(1))}"]`);
  if (fromHash) select(fromHash);
}

// ---------------------------------------------------------------- login gate
function setLocked(locked: boolean): void {
  byId('adm-gate').hidden = !locked;
  byId('dashboard-layout').hidden = locked;
  byId('sidebar-hamburger').hidden = locked;
  byId('dashboard-section-title').textContent = locked ? t('dashboard.title', 'Dashboard') : (document.querySelector('.sidebar-link.active')?.textContent.trim() || '');
  notifyViewChange();
}

function showLogin(): void {
  clearInterval(statsTimer ?? undefined);
  statsTimer = null;
  setDashboardInterval(null);
  stopAdminSections();
  setLocked(true);
  byId('adm-disabled').hidden = true;
  byId('adm-login').hidden = false;
  byId('adm-username').focus();
}

function showDashboard(): void {
  setLocked(false);
  fetchDashboardStats();
  clearInterval(statsTimer ?? undefined);
  statsTimer = setInterval(fetchDashboardStats, 2000);
  setDashboardInterval(statsTimer);
  fetchDashboardUsers();
  loadRegistrationsSwitch();
  startAdminSections({ unauthorized: showLogin });
  onAdminReady();
}

function setupLogin(): void {
  byId<HTMLFormElement>('adm-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = byId('adm-login-error');
    errEl.hidden = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: byId<HTMLInputElement>('adm-username').value, password: byId<HTMLInputElement>('adm-password').value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Partial<ApiError>;
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      byId<HTMLInputElement>('adm-password').value = '';
      showDashboard();
    } catch (err) {
      errEl.textContent = (err as Error).message;
      errEl.hidden = false;
    }
  });
  byId('adm-logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    showLogin();
  });
}

// Register view activator
viewActivators.dashboard = async () => {
  initSidebarNav();
  setupLogin();
  if (elements.usersSearch) elements.usersSearch.addEventListener('input', renderDashboardUserList);
  if (elements.usersFilter) elements.usersFilter.addEventListener('change', renderDashboardUserList);
  setLocked(true);
  try {
    const res = await fetch('/api/admin/status', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json() as AdminStatus;
    if (!status.enabled) throw new Error('Admin is disabled (ADMIN_PASSWORD not set)');
    if (status.authenticated) showDashboard(); else showLogin();
  } catch (err) {
    byId('adm-disabled').textContent = `Could not open the dashboard: ${(err as Error).message}`;
    byId('adm-disabled').hidden = false;
  }
};

// onReady runs each time the admin login is confirmed.
export function checkUrlForDashboard(onReady?: () => void): boolean {
  if (/^\/dashboard\/?$/.test(window.location.pathname)) {
    if (onReady) onAdminReady = onReady;
    showView('dashboard');
    return true;
  }
  return false;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function setMeta(el: HTMLElement | null, text: string): void {
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

export function fetchDashboardStats(): void {
  fetch('/api/dashboard/stats', { credentials: 'include' })
    .then(res => {
      // Admin session expired or logged out.
      if (res.status === 401) { showLogin(); throw new Error('Admin login required'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<DashboardStats>;
    })
    .then(data => {
      const n = (value: number) => Number(value).toLocaleString();
      if (elements.statLobbies) elements.statLobbies.textContent = n(data.totalLobbies);
      setMeta(maybeById('stat-lobbies-private'), data.privateLobbies ? tf('dashboard.privateCount', '{count} private', { count: n(data.privateLobbies) }) : '');
      if (elements.statUsers) elements.statUsers.textContent = n(data.totalUsers);
      if (elements.statMemory) elements.statMemory.textContent = n(Math.round(data.memoryUsage.heapUsed / 1024 / 1024));
      if (elements.statDisk) {
        elements.statDisk.textContent = formatBytes(data.diskUsage.bytes);
        setMeta(maybeById('stat-disk-files'), tf('dashboard.files', '{count} files', { count: n(data.diskUsage.fileCount) }));
        setMeta(maybeById('stat-disk-unregistered'), data.diskUsage.unregisteredFiles > 0
          ? tf('dashboard.unregistered', '{count} unregistered ({size})', { count: n(data.diskUsage.unregisteredFiles), size: formatBytes(data.diskUsage.unregisteredBytes) })
          : '');
      }
      if (elements.dashboardUptime) elements.dashboardUptime.textContent = `Uptime: ${formatUptime(data.uptime)}`;
      if (elements.dashboardLobbyList) updateDashboardLobbies(data.lobbies);
    })
    .catch((err: Error) => { if (err.message !== 'Admin login required') console.error('Failed to fetch dashboard stats:', err); });
}

function updateDashboardLobbies(lobbies: DashboardLobby[]): void {
  if (!lobbies || lobbies.length === 0) {
    elements.dashboardLobbyList.innerHTML = '<li class="list-group-item app-empty dashboard-empty">No public playlists</li>';
    return;
  }
  elements.dashboardLobbyList.innerHTML = lobbies.map(lobby => {
    const age = formatAge(lobby.createdAt);
    return `<li class="list-group-item dashboard-lobby-item">
      <div class="fw-medium text-truncate dashboard-lobby-id">${lobby.name ? escapeHtml(lobby.name) : escapeHtml(lobby.id)}</div>
      <div class="d-flex flex-wrap column-gap-4 fs-sm fg-3 dashboard-lobby-info">
        <span class="dashboard-lobby-users">${lobby.userCount} user${lobby.userCount !== 1 ? 's' : ''}</span>
        <span class="dashboard-lobby-queue">${lobby.queueLength} in queue</span>
      </div>
      <div class="d-flex gap-2 dashboard-lobby-actions">
        <button class="btn btn-sm" type="button" onclick="window.dashboardJoinLobby(${escapeHtml(JSON.stringify(lobby.id))})">Open</button>
        <button class="btn-outline theme-danger btn-sm" type="button" onclick="window.dashboardRemoveLobby(${escapeHtml(JSON.stringify(lobby.id))})">Delete</button>
      </div>
      <div class="fs-xs fg-3 dashboard-lobby-age">${age}</div>
    </li>`;
  }).join('');
}

export function fetchDashboardUsers(): void {
  fetch('/api/dashboard/users', { credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<DashboardUsersResponse>; })
    .then(data => { dashboardUsers = data.users || []; updateUserStats(); renderDashboardUserList(); })
    .catch(err => console.error('Failed to fetch users:', err));
}

// "Allow new accounts" (registrations_open): who signs in through the central
// login without an account here gets one, or is turned away. Stored on the
// server; takes effect at the next sign-in.
let registrationsWired = false;
// Never saved: the value is REGISTRATIONS_DEFAULT from the server's environment.
function showRegistrationsSource(source: string): void {
  const el = maybeById('registrations-source');
  if (el) el.hidden = source !== 'default';
}
async function loadRegistrationsSwitch(): Promise<void> {
  const card = maybeById('dashboard-registrations');
  const input = maybeById<HTMLInputElement>('registrations-open');
  if (!card || !input) return;
  try {
    const res = await fetch('/api/admin/settings', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as AdminSettings;
    input.checked = data.registrations_open !== false;
    showRegistrationsSource(data.source);
    card.hidden = false;
  } catch (err) {
    console.error('Failed to load sign-in settings:', err);
    return;
  }
  if (registrationsWired) return;
  registrationsWired = true;
  input.addEventListener('change', async () => {
    const want = input.checked;
    input.disabled = true;
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrations_open: want }),
      });
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as AdminSettings;
      input.checked = data.registrations_open !== false;
      showRegistrationsSource(data.source);
      showToast(input.checked ? t('dashboard.registrationsOpened', 'New accounts are allowed') : t('dashboard.registrationsClosed', 'New accounts are turned away'), 'success');
    } catch (err) {
      console.error('Failed to save sign-in settings:', err);
      input.checked = !want;
      showToast(t('dashboard.registrationsFailed', 'Could not change the setting'), 'error');
    } finally {
      input.disabled = false;
    }
  });
}

// Denied and rejected are both "blocked" (no access, signed out everywhere).
const statusGroup = (s: AccountStatus | null) => (s === 'denied' ? 'rejected' : s);

function updateUserStats(): void {
  const counts: Record<string, number> = { approved: 0, pending: 0, rejected: 0 };
  for (const u of dashboardUsers) { const g = statusGroup(u.status); if (counts[g as string] !== undefined) counts[g as string]++; }
  if (elements.usersApproved) elements.usersApproved.textContent = String(counts.approved);
  if (elements.usersPending) elements.usersPending.textContent = String(counts.pending);
  if (elements.usersRejected) elements.usersRejected.textContent = String(counts.rejected);
}

export function renderDashboardUserList(): void {
  if (!elements.dashboardUserList) return;
  const searchTerm = (elements.usersSearch ? elements.usersSearch.value : '').toLocaleLowerCase('tr');
  const filterStatus = elements.usersFilter ? elements.usersFilter.value : 'all';
  let filtered = dashboardUsers;
  if (filterStatus !== 'all') filtered = filtered.filter(u => statusGroup(u.status) === filterStatus);
  if (searchTerm) filtered = filtered.filter(u => (u.username || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.name || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.email || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.user_id || '').toLocaleLowerCase('tr').includes(searchTerm));
  if (filtered.length === 0) { elements.dashboardUserList.innerHTML = '<li class="list-group-item app-empty dashboard-empty">No users found</li>'; return; }
  elements.dashboardUserList.innerHTML = filtered.map(user => {
    const date = new Date(parseInt(user.created_at)).toLocaleDateString();
    const showApprove = user.status !== 'approved';
    const showReject = user.status !== 'rejected' && user.status !== 'denied';
    const avatarHtml = user.avatar_url
      ? `<img class="app-thumb rounded-pill dashboard-user-avatar-img" src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy">`
      : `<div class="app-thumb rounded-pill dashboard-user-avatar">${escapeHtml(user.emoji || '\uD83C\uDFB5')}</div>`;
    const displayName = user.name || user.username;
    const subName = user.name && user.username && user.name !== user.username ? `<span class="fs-sm fg-3 fw-normal ms-1 dashboard-user-handle">@${escapeHtml(user.username)}</span>` : '';
    return `<li class="list-group-item dashboard-user-item" data-user-id="${escapeHtml(user.id)}">
      ${avatarHtml}
      <div class="min-w-0 flex-grow-1 dashboard-user-info">
        <div class="fw-medium text-truncate dashboard-user-name">${escapeHtml(displayName)}${subName}</div>
        <div class="fs-xs fg-3 text-truncate dashboard-user-meta">${escapeHtml(user.email || user.user_id || '')} &middot; ${escapeHtml(user.provider || 'local')}${user.central ? ' &middot; central login' : ''} &middot; ${date}</div>
      </div>
      <span class="badge badge-subtle ${({ approved: 'theme-success', pending: 'theme-warning', rejected: 'theme-danger', denied: 'theme-danger' } as Record<string, string>)[user.status as string] || 'theme-secondary'} dashboard-user-status status-${user.status}">${user.status}</span>
      <div class="d-flex gap-2 dashboard-user-actions">
        ${showApprove ? `<button class="btn-subtle theme-success btn-sm btn-approve" type="button" onclick="window.dashboardApproveUser(${escapeHtml(JSON.stringify(user.id))})">Approve</button>` : ''}
        ${showReject ? `<button class="btn-subtle theme-danger btn-sm btn-reject" type="button" onclick="window.dashboardRejectUser(${escapeHtml(JSON.stringify(user.id))})">Reject</button>` : ''}
      </div>
    </li>`;
  }).join('');
}

export function dashboardJoinLobby(lobbyId: string): void { window.location.href = `/playlist/${encodeURIComponent(lobbyId)}`; }

export function dashboardRemoveLobby(lobbyId: string): void {
  if (!confirm(`Delete playlist ${lobbyId}? Everyone who has it open loses it.`)) return;
  fetch(`/api/dashboard/lobbies/${encodeURIComponent(lobbyId)}`, { method: 'DELETE' })
    .then(res => { if (res.ok) fetchDashboardStats(); else alert('Failed to delete playlist'); })
    .catch(() => alert('Failed to delete playlist'));
}

export function dashboardApproveUser(userId: string): void {
  fetch(`/api/dashboard/users/${encodeURIComponent(userId)}/approve`, { method: 'PUT', credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<DashboardUserStatusResponse>; })
    .then(() => fetchDashboardUsers())
    .catch(err => { console.error('Failed to approve user:', err); showToast('Failed to approve user', 'error'); });
}

export function dashboardRejectUser(userId: string): void {
  fetch(`/api/dashboard/users/${encodeURIComponent(userId)}/reject`, { method: 'PUT', credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<DashboardUserStatusResponse>; })
    .then(() => fetchDashboardUsers())
    .catch(err => { console.error('Failed to reject user:', err); showToast('Failed to reject user', 'error'); });
}
