// Dashboard admin panel (lobbies, users). Library/token management is on /admin.
import { state, elements, viewActivators, setDashboardInterval } from './state.js';
import { showView, showToast, escapeHtml, formatUptime, formatAge, formatDuration, formatFileSize, toLower } from './ui.js';

let dashboardUsers = [];

function initSidebarNav() {
  const sidebar = document.getElementById('dashboard-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const hamburger = document.getElementById('sidebar-hamburger');
  const closeBtn = document.getElementById('sidebar-close');
  const titleEl = document.getElementById('dashboard-section-title');

  const openSidebar = () => { sidebar.classList.add('open'); overlay.classList.add('open'); };
  const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };

  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  document.querySelectorAll('.sidebar-link[data-section]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = link.dataset.section;
      document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      document.querySelectorAll('.dashboard-section').forEach(s => s.classList.remove('active'));
      const section = document.querySelector(`.dashboard-section[data-section="${target}"]`);
      if (section) section.classList.add('active');
      if (titleEl) titleEl.textContent = link.textContent.trim();
      closeSidebar();
    });
  });
}

// Register view activator
viewActivators.dashboard = () => {
  initSidebarNav();
  fetchDashboardStats();
  setDashboardInterval(setInterval(() => { fetchDashboardStats(); }, 2000));
  fetchDashboardUsers();
  if (elements.usersSearch) elements.usersSearch.addEventListener('input', renderDashboardUserList);
  if (elements.usersFilter) elements.usersFilter.addEventListener('change', renderDashboardUserList);
};

export function checkUrlForDashboard() {
  if (window.location.pathname === '/dashboard') {
    showView('dashboard');
    return true;
  }
  return false;
}

export function fetchDashboardStats() {
  fetch('/api/dashboard/stats', { credentials: 'include' })
    .then(res => {
      // Admin session expired or logged out: log in again on /admin.
      if (res.status === 401) { window.location.href = '/admin?next=/dashboard'; throw new Error('Admin login required'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (elements.statLobbies) elements.statLobbies.textContent = data.totalLobbies;
      if (elements.statUsers) elements.statUsers.textContent = data.totalUsers;
      if (elements.statMemory) elements.statMemory.textContent = Math.round(data.memoryUsage.heapUsed / 1024 / 1024);
      if (elements.statDisk) {
        let diskText = `${(data.diskUsage.bytes / 1024 / 1024).toFixed(1)} MB (${data.diskUsage.fileCount} files)`;
        if (data.diskUsage.unregisteredFiles > 0) {
          diskText += ` — ⚠️ ${data.diskUsage.unregisteredFiles} unregistered (${(data.diskUsage.unregisteredBytes / 1024 / 1024).toFixed(1)} MB)`;
        }
        elements.statDisk.textContent = diskText;
      }
      if (elements.dashboardUptime) elements.dashboardUptime.textContent = `Uptime: ${formatUptime(data.uptime)}`;
      if (elements.dashboardLobbyList) updateDashboardLobbies(data.lobbies);
    })
    .catch(err => console.error('Failed to fetch dashboard stats:', err));
}

function updateDashboardLobbies(lobbies) {
  if (!lobbies || lobbies.length === 0) {
    elements.dashboardLobbyList.innerHTML = '<li class="list-group-item app-empty dashboard-empty">No active lobbies</li>';
    return;
  }
  elements.dashboardLobbyList.innerHTML = lobbies.map(lobby => {
    const age = formatAge(lobby.createdAt);
    return `<li class="list-group-item dashboard-lobby-item">
      <div class="fw-medium text-truncate dashboard-lobby-id">${lobby.name ? escapeHtml(lobby.name) : escapeHtml(lobby.id)}</div>
      <div class="d-flex flex-wrap column-gap-4 fs-sm fg-3 dashboard-lobby-info">
        <span class="dashboard-lobby-users">${lobby.userCount} user${lobby.userCount !== 1 ? 's' : ''}</span>
        <span class="dashboard-lobby-queue">${lobby.queueLength} in queue</span>
        ${lobby.currentTrack ? `<span class="dashboard-lobby-track ${lobby.isPlaying ? 'playing' : ''}">${escapeHtml(lobby.currentTrack)}</span>` : ''}
      </div>
      <div class="d-flex gap-2 dashboard-lobby-actions">
        <button class="btn btn-sm" type="button" onclick="window.dashboardJoinLobby(${escapeHtml(JSON.stringify(lobby.id))})">Join</button>
        <button class="btn-outline theme-danger btn-sm" type="button" onclick="window.dashboardRemoveLobby(${escapeHtml(JSON.stringify(lobby.id))})">Remove</button>
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

export function dashboardJoinLobby(lobbyId) { window.location.href = `/lobby/${lobbyId}`; }

export function dashboardRemoveLobby(lobbyId) {
  if (!confirm(`Remove lobby ${lobbyId}? This will disconnect all users.`)) return;
  fetch(`/api/dashboard/lobbies/${lobbyId}`, { method: 'DELETE' })
    .then(res => { if (res.ok) fetchDashboardStats(); else alert('Failed to remove lobby'); })
    .catch(() => alert('Failed to remove lobby'));
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
