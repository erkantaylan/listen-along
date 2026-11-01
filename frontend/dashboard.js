// Admin dashboard: overview, public playlists, users, plus the sections in
// dashboard-admin.js. Behind its own login (POST /api/admin/login, the la_admin
// cookie); the page holds no data until that succeeds.
import { state, elements, viewActivators, setDashboardInterval } from './state.js';
import { showView, showToast, escapeHtml, formatUptime, formatAge, formatDuration, formatFileSize, toLower, t, notifyViewChange } from './ui.js';
import { startAdminSections, stopAdminSections } from './dashboard-admin.js';

let dashboardUsers = [];
let statsTimer = null;
let onAdminReady = () => {};

const $ = (id) => document.getElementById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function initSidebarNav() {
  const sidebar = $('dashboard-sidebar');
  const overlay = $('sidebar-overlay');
  const hamburger = $('sidebar-hamburger');
  const closeBtn = $('sidebar-close');
  const titleEl = $('dashboard-section-title');

  const openSidebar = () => { sidebar.classList.add('open'); overlay.classList.add('open'); };
  const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };

  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  const select = (link) => {
    document.querySelectorAll('.sidebar-link').forEach(l => { l.classList.remove('active'); l.removeAttribute('aria-current'); });
    link.classList.add('active');
    link.setAttribute('aria-current', 'page');
    document.querySelectorAll('.dashboard-section').forEach(s => s.classList.remove('active'));
    const section = document.querySelector(`.dashboard-section[data-section="${link.dataset.section}"]`);
    if (section) section.classList.add('active');
    if (titleEl) titleEl.textContent = link.textContent.trim();
  };

  document.querySelectorAll('.sidebar-link[data-section]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      select(link);
      history.replaceState(history.state, '', `#${link.dataset.section}`);
      closeSidebar();
    });
  });
  // #section survives a reload and can be linked to.
  const fromHash = document.querySelector(`.sidebar-link[data-section="${CSS.escape(window.location.hash.slice(1))}"]`);
  if (fromHash) select(fromHash);
}

// ---------------------------------------------------------------- login gate
function setLocked(locked) {
  $('adm-gate').hidden = !locked;
  $('dashboard-layout').hidden = locked;
  $('sidebar-hamburger').hidden = locked;
  $('dashboard-section-title').textContent = locked ? t('dashboard.title', 'Dashboard') : (document.querySelector('.sidebar-link.active')?.textContent.trim() || '');
  notifyViewChange();
}

function showLogin() {
  clearInterval(statsTimer);
  statsTimer = null;
  setDashboardInterval(null);
  stopAdminSections();
  setLocked(true);
  $('adm-disabled').hidden = true;
  $('adm-login').hidden = false;
  $('adm-username').focus();
}

function showDashboard() {
  setLocked(false);
  fetchDashboardStats();
  clearInterval(statsTimer);
  statsTimer = setInterval(fetchDashboardStats, 2000);
  setDashboardInterval(statsTimer);
  fetchDashboardUsers();
  startAdminSections({ unauthorized: showLogin });
  onAdminReady();
}

function setupLogin() {
  $('adm-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('adm-login-error');
    errEl.hidden = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('adm-username').value, password: $('adm-password').value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      $('adm-password').value = '';
      showDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
  $('adm-logout').addEventListener('click', async () => {
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
    const status = await res.json();
    if (!status.enabled) throw new Error('Admin is disabled (ADMIN_PASSWORD not set)');
    if (status.authenticated) showDashboard(); else showLogin();
  } catch (err) {
    $('adm-disabled').textContent = `Could not open the dashboard: ${err.message}`;
    $('adm-disabled').hidden = false;
  }
};

// onReady runs each time the admin login is confirmed.
export function checkUrlForDashboard(onReady) {
  if (/^\/dashboard\/?$/.test(window.location.pathname)) {
    if (onReady) onAdminReady = onReady;
    showView('dashboard');
    return true;
  }
  return false;
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function setMeta(el, text) {
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

export function fetchDashboardStats() {
  fetch('/api/dashboard/stats', { credentials: 'include' })
    .then(res => {
      // Admin session expired or logged out.
      if (res.status === 401) { showLogin(); throw new Error('Admin login required'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      const n = (value) => Number(value).toLocaleString();
      if (elements.statLobbies) elements.statLobbies.textContent = n(data.totalLobbies);
      setMeta($('stat-lobbies-private'), data.privateLobbies ? tf('dashboard.privateCount', '{count} private', { count: n(data.privateLobbies) }) : '');
      if (elements.statUsers) elements.statUsers.textContent = n(data.totalUsers);
      if (elements.statMemory) elements.statMemory.textContent = n(Math.round(data.memoryUsage.heapUsed / 1024 / 1024));
      if (elements.statDisk) {
        elements.statDisk.textContent = formatBytes(data.diskUsage.bytes);
        setMeta($('stat-disk-files'), tf('dashboard.files', '{count} files', { count: n(data.diskUsage.fileCount) }));
        setMeta($('stat-disk-unregistered'), data.diskUsage.unregisteredFiles > 0
          ? tf('dashboard.unregistered', '{count} unregistered ({size})', { count: n(data.diskUsage.unregisteredFiles), size: formatBytes(data.diskUsage.unregisteredBytes) })
          : '');
      }
      if (elements.dashboardUptime) elements.dashboardUptime.textContent = `Uptime: ${formatUptime(data.uptime)}`;
      if (elements.dashboardLobbyList) updateDashboardLobbies(data.lobbies);
    })
    .catch(err => { if (err.message !== 'Admin login required') console.error('Failed to fetch dashboard stats:', err); });
}

function updateDashboardLobbies(lobbies) {
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

export function fetchDashboardUsers() {
  fetch('/api/dashboard/users', { credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then(data => { dashboardUsers = data.users || []; updateUserStats(); renderDashboardUserList(); })
    .catch(err => console.error('Failed to fetch users:', err));
}

function updateUserStats() {
  const counts = { approved: 0, pending: 0, rejected: 0 };
  for (const u of dashboardUsers) { if (counts[u.status] !== undefined) counts[u.status]++; }
  if (elements.usersApproved) elements.usersApproved.textContent = counts.approved;
  if (elements.usersPending) elements.usersPending.textContent = counts.pending;
  if (elements.usersRejected) elements.usersRejected.textContent = counts.rejected;
}

export function renderDashboardUserList() {
  if (!elements.dashboardUserList) return;
  const searchTerm = (elements.usersSearch ? elements.usersSearch.value : '').toLocaleLowerCase('tr');
  const filterStatus = elements.usersFilter ? elements.usersFilter.value : 'all';
  let filtered = dashboardUsers;
  if (filterStatus !== 'all') filtered = filtered.filter(u => u.status === filterStatus);
  if (searchTerm) filtered = filtered.filter(u => (u.username || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.name || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.email || '').toLocaleLowerCase('tr').includes(searchTerm) || (u.user_id || '').toLocaleLowerCase('tr').includes(searchTerm));
  if (filtered.length === 0) { elements.dashboardUserList.innerHTML = '<li class="list-group-item app-empty dashboard-empty">No users found</li>'; return; }
  elements.dashboardUserList.innerHTML = filtered.map(user => {
    const date = new Date(parseInt(user.created_at)).toLocaleDateString();
    const showApprove = user.status !== 'approved';
    const showReject = user.status !== 'rejected';
    const avatarHtml = user.avatar_url
      ? `<img class="app-thumb rounded-pill dashboard-user-avatar-img" src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy">`
      : `<div class="app-thumb rounded-pill dashboard-user-avatar">${escapeHtml(user.emoji || '\uD83C\uDFB5')}</div>`;
    const displayName = user.name || user.username;
    const subName = user.name && user.username && user.name !== user.username ? `<span class="fs-sm fg-3 fw-normal ms-1 dashboard-user-handle">@${escapeHtml(user.username)}</span>` : '';
    return `<li class="list-group-item dashboard-user-item" data-user-id="${escapeHtml(user.id)}">
      ${avatarHtml}
      <div class="min-w-0 flex-grow-1 dashboard-user-info">
        <div class="fw-medium text-truncate dashboard-user-name">${escapeHtml(displayName)}${subName}</div>
        <div class="fs-xs fg-3 text-truncate dashboard-user-meta">${escapeHtml(user.email || user.user_id)} &middot; ${user.provider || 'local'} &middot; ${date}</div>
      </div>
      <span class="badge badge-subtle ${({ approved: 'theme-success', pending: 'theme-warning', rejected: 'theme-danger', denied: 'theme-danger' })[user.status] || 'theme-secondary'} dashboard-user-status status-${user.status}">${user.status}</span>
      <div class="d-flex gap-2 dashboard-user-actions">
        ${showApprove ? `<button class="btn-subtle theme-success btn-sm btn-approve" type="button" onclick="window.dashboardApproveUser(${escapeHtml(JSON.stringify(user.id))})">Approve</button>` : ''}
        ${showReject ? `<button class="btn-subtle theme-danger btn-sm btn-reject" type="button" onclick="window.dashboardRejectUser(${escapeHtml(JSON.stringify(user.id))})">Reject</button>` : ''}
      </div>
    </li>`;
  }).join('');
}

export function dashboardJoinLobby(lobbyId) { window.location.href = `/playlist/${encodeURIComponent(lobbyId)}`; }

export function dashboardRemoveLobby(lobbyId) {
  if (!confirm(`Delete playlist ${lobbyId}? Everyone who has it open loses it.`)) return;
  fetch(`/api/dashboard/lobbies/${encodeURIComponent(lobbyId)}`, { method: 'DELETE' })
    .then(res => { if (res.ok) fetchDashboardStats(); else alert('Failed to delete playlist'); })
    .catch(() => alert('Failed to delete playlist'));
}

export function dashboardApproveUser(userId) {
  fetch(`/api/dashboard/users/${encodeURIComponent(userId)}/approve`, { method: 'PUT', credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then(() => fetchDashboardUsers())
    .catch(err => { console.error('Failed to approve user:', err); showToast('Failed to approve user', 'error'); });
}

export function dashboardRejectUser(userId) {
  fetch(`/api/dashboard/users/${encodeURIComponent(userId)}/reject`, { method: 'PUT', credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then(() => fetchDashboardUsers())
    .catch(err => { console.error('Failed to reject user:', err); showToast('Failed to reject user', 'error'); });
}
