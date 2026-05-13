// Dashboard admin panel and cache management
import { state, elements, viewActivators, setDashboardInterval } from './state.js';
import { showView, showToast, escapeHtml, formatUptime, formatAge, formatDuration, formatFileSize, toLower } from './ui.js';

let cachedSongsData = [];
let dashboardUsers = [];

// Register view activator
viewActivators.dashboard = () => {
  fetchDashboardStats();
  fetchCacheStats();
  fetchCachedSongs();
  if (elements.nukeCacheBtn) elements.nukeCacheBtn.onclick = nukeAllCachedSongs;
  if (elements.clearErrorsBtn) elements.clearErrorsBtn.onclick = clearErrorSongs;
  if (elements.cleanOrphansBtn) elements.cleanOrphansBtn.onclick = cleanOrphanedSongs;
  const redownloadBtn = document.getElementById('redownload-missing-btn');
  if (redownloadBtn) redownloadBtn.onclick = redownloadMissingSongs;
  const purgeBtn = document.getElementById('purge-unregistered-btn');
  if (purgeBtn) purgeBtn.onclick = purgeUnregisteredFiles;
  const cacheSearchEl = document.getElementById('cache-search');
  if (cacheSearchEl) cacheSearchEl.addEventListener('input', renderCacheSongList);
  const cacheFilterEl = document.getElementById('cache-filter');
  if (cacheFilterEl) cacheFilterEl.addEventListener('change', renderCacheSongList);
  const cacheSortEl = document.getElementById('cache-sort');
  if (cacheSortEl) cacheSortEl.addEventListener('change', renderCacheSongList);
  const cookiesSaveBtn = document.getElementById('cookies-save-btn');
  if (cookiesSaveBtn) cookiesSaveBtn.onclick = saveCookies;
  const cookiesDeleteBtn = document.getElementById('cookies-delete-btn');
  if (cookiesDeleteBtn) cookiesDeleteBtn.onclick = deleteCookies;
  fetchCookiesStatus();
  setDashboardInterval(setInterval(() => { fetchDashboardStats(); fetchCacheStats(); }, 2000));
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
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
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
    elements.dashboardLobbyList.innerHTML = '<li class="dashboard-empty">No active lobbies</li>';
    return;
  }
  elements.dashboardLobbyList.innerHTML = lobbies.map(lobby => {
    const age = formatAge(lobby.createdAt);
    return `<li class="dashboard-lobby-item">
      <div class="dashboard-lobby-id">${lobby.name ? escapeHtml(lobby.name) : escapeHtml(lobby.id)}</div>
      <div class="dashboard-lobby-info">
        <span class="dashboard-lobby-users">${lobby.userCount} user${lobby.userCount !== 1 ? 's' : ''}</span>
        <span class="dashboard-lobby-queue">${lobby.queueLength} in queue</span>
        ${lobby.currentTrack ? `<span class="dashboard-lobby-track ${lobby.isPlaying ? 'playing' : ''}">${escapeHtml(lobby.currentTrack)}</span>` : ''}
      </div>
      <div class="dashboard-lobby-actions">
        <button class="btn btn-small" onclick="window.dashboardJoinLobby('${escapeHtml(lobby.id)}')">Join</button>
        <button class="btn btn-small btn-danger" onclick="window.dashboardRemoveLobby('${escapeHtml(lobby.id)}')">Remove</button>
      </div>
      <div class="dashboard-lobby-age">${age}</div>
    </li>`;
  }).join('');
}

export function fetchCacheStats() {
  fetch('/api/dashboard/cache', { credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then(data => {
      if (!data.enabled) {
        if (elements.cacheSongList) elements.cacheSongList.innerHTML = '<li class="dashboard-empty">Caching disabled (no database)</li>';
        return;
      }
      if (elements.cacheReady) elements.cacheReady.textContent = data.stats.ready;
      if (elements.cacheDownloading) elements.cacheDownloading.textContent = data.stats.downloading;
      if (elements.cachePending) elements.cachePending.textContent = data.stats.pending;
      if (elements.cacheError) elements.cacheError.textContent = data.stats.error;
      if (elements.cacheDuration) elements.cacheDuration.textContent = formatDuration(data.stats.totalDuration);
    })
    .catch(err => console.error('Failed to fetch cache stats:', err));
}

export function fetchCachedSongs() {
  fetch('/api/dashboard/cache/songs', { credentials: 'include' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then(data => { cachedSongsData = data.songs || []; renderCacheSongList(); })
    .catch(err => console.error('Failed to fetch cached songs:', err));
}

export function renderCacheSongList() {
  if (!elements.cacheSongList) return;
  let songs = [...cachedSongsData];
  const unusedCount = cachedSongsData.filter(s => !s.playlist_count && !s.queue_count).length;
  if (elements.cacheUnused) elements.cacheUnused.textContent = unusedCount;

  const filterEl = document.getElementById('cache-filter');
  const filterBy = filterEl ? filterEl.value : 'all';
  if (filterBy === 'unused') songs = songs.filter(s => !s.playlist_count && !s.queue_count);
  else if (filterBy === 'used') songs = songs.filter(s => s.playlist_count > 0 || s.queue_count > 0);

  const searchEl = document.getElementById('cache-search');
  const query = searchEl ? searchEl.value.toLocaleLowerCase('tr') : '';
  if (query) songs = songs.filter(s => (s.title || '').toLocaleLowerCase('tr').includes(query));

  const sortEl = document.getElementById('cache-sort');
  const sortBy = sortEl ? sortEl.value : 'date-desc';
  songs.sort((a, b) => {
    switch (sortBy) {
      case 'name-asc': return (a.title || '').localeCompare(b.title || '');
      case 'name-desc': return (b.title || '').localeCompare(a.title || '');
      case 'duration-asc': return (a.duration || 0) - (b.duration || 0);
      case 'duration-desc': return (b.duration || 0) - (a.duration || 0);
      case 'size-asc': return (a.file_size || 0) - (b.file_size || 0);
      case 'size-desc': return (b.file_size || 0) - (a.file_size || 0);
      case 'date-asc': return (a.updated_at || 0) - (b.updated_at || 0);
      default: return (b.updated_at || 0) - (a.updated_at || 0);
    }
  });

  if (songs.length === 0) { elements.cacheSongList.innerHTML = '<li class="dashboard-empty">No cached songs</li>'; return; }

  elements.cacheSongList.innerHTML = songs.map(song => {
    const duration = formatDuration(song.duration);
    const fileSize = formatFileSize(song.file_size);
    const isUnused = !song.playlist_count && !song.queue_count;
    let usageLabel = '';
    if (!isUnused) {
      const parts = [];
      if (song.playlist_count) parts.push(`${song.playlist_count} list${song.playlist_count > 1 ? 's' : ''}`);
      if (song.queue_count) parts.push(`${song.queue_count} queue${song.queue_count > 1 ? 's' : ''}`);
      usageLabel = parts.join(', ');
    }
    const usageBadge = isUnused ? '<span class="cache-song-status unused">unused</span>' : `<span class="cache-song-status used">in ${usageLabel}</span>`;
    const thumbnail = song.thumbnail_url
      ? `<img class="cache-song-thumb" src="${escapeHtml(song.thumbnail_url)}" alt="">`
      : '<div class="cache-song-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
    return `<li class="cache-song-item${isUnused ? ' cache-song-unused' : ''}" data-song-id="${escapeHtml(song.id)}">
      ${thumbnail}
      <div class="cache-song-info"><div class="cache-song-title">${escapeHtml(song.title || 'Unknown')}</div>
        <div class="cache-song-meta"><span>${duration}</span><span>${fileSize}</span><span class="cache-song-status ${song.status}">${song.status}</span>${usageBadge}</div>
        ${song.status === 'error' && song.error_message ? `<div class="cache-song-error">${escapeHtml(song.error_message)}</div>` : ''}
      </div>
      <div class="cache-song-actions">
        ${song.status === 'ready' ? `<button class="btn-icon" onclick="window.playCachedSong(${JSON.stringify(song.url)})" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
        <button class="btn-icon" onclick="window.deleteCachedSong('${escapeHtml(song.id)}')" title="Delete"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
      </div>
    </li>`;
  }).join('');
}

export function deleteCachedSong(songId) {
  if (!confirm('Delete this cached song?')) return;
  fetch(`/api/dashboard/cache/songs/${songId}`, { method: 'DELETE' })
    .then(res => { if (res.ok) { fetchCacheStats(); fetchCachedSongs(); } else alert('Failed to delete song'); })
    .catch(() => alert('Failed to delete song'));
}

function nukeAllCachedSongs() {
  if (!confirm('Delete ALL cached songs? This cannot be undone.')) return;
  fetch('/api/dashboard/cache/songs', { method: 'DELETE', credentials: 'include' })
    .then(res => res.json())
    .then(data => { if (data.success) { fetchCacheStats(); fetchCachedSongs(); fetchDashboardStats(); alert(`Deleted ${data.deleted} cached songs`); } else alert('Failed to delete songs'); })
    .catch(() => alert('Failed to delete songs'));
}

function clearErrorSongs() {
  if (!confirm('Delete all songs with error status?')) return;
  fetch('/api/dashboard/cache/errors', { method: 'DELETE', credentials: 'include' })
    .then(res => res.json())
    .then(data => { if (data.success) { fetchCacheStats(); fetchCachedSongs(); fetchDashboardStats(); alert(`Deleted ${data.deleted} error songs`); } else alert('Failed to delete error songs'); })
    .catch(() => alert('Failed to delete error songs'));
}

function redownloadMissingSongs() {
  fetch('/api/dashboard/cache/redownload-missing', { method: 'POST', credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        fetchCacheStats();
        fetchCachedSongs();
        if (data.queued === 0) showToast('All songs are already cached', 'info');
        else showToast(`Queued ${data.queued} song${data.queued !== 1 ? 's' : ''} for download`, 'success');
      } else showToast('Failed to queue downloads: ' + (data.error || 'unknown error'), 'error');
    })
    .catch(() => showToast('Failed to queue downloads', 'error'));
}

function purgeUnregisteredFiles() {
  if (!confirm('Delete all files on disk that have no database record? This frees space from old files left after a database reset.')) return;
  fetch('/api/dashboard/cache/unregistered', { method: 'DELETE', credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        fetchCacheStats(); fetchDashboardStats();
        showToast(`Removed ${data.deleted} unregistered file${data.deleted !== 1 ? 's' : ''} (${(data.bytes / 1024 / 1024).toFixed(1)} MB freed)`, 'success');
      } else showToast('Failed to purge unregistered files', 'error');
    })
    .catch(() => showToast('Failed to purge unregistered files', 'error'));
}

function cleanOrphanedSongs() {
  const unusedCount = cachedSongsData.filter(s => !s.playlist_count && !s.queue_count).length;
  if (!confirm(`Remove ${unusedCount} song${unusedCount !== 1 ? 's' : ''} not used in any playlist or queue?`)) return;
  fetch('/api/dashboard/cache/orphaned', { method: 'DELETE', credentials: 'include' })
    .then(res => res.json())
    .then(data => { if (data.success) { fetchCacheStats(); fetchCachedSongs(); fetchDashboardStats(); alert(`Removed ${data.deleted} unused song${data.deleted !== 1 ? 's' : ''}`); } else alert('Failed to remove unused songs'); })
    .catch(() => alert('Failed to remove unused songs'));
}

export function playCachedSong(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert('Song URL copied to clipboard. Create or join a lobby to play it.');
  }).catch(() => { prompt('Copy this URL to add to a lobby:', url); });
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
  if (filtered.length === 0) { elements.dashboardUserList.innerHTML = '<li class="dashboard-empty">No users found</li>'; return; }
  elements.dashboardUserList.innerHTML = filtered.map(user => {
    const date = new Date(parseInt(user.created_at)).toLocaleDateString();
    const showApprove = user.status !== 'approved';
    const showReject = user.status !== 'rejected';
    const avatarHtml = user.avatar_url
      ? `<img class="dashboard-user-avatar-img" src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy">`
      : `<div class="dashboard-user-avatar">${user.emoji || '\uD83C\uDFB5'}</div>`;
    const displayName = user.name || user.username;
    const subName = user.name && user.username && user.name !== user.username ? `<span class="dashboard-user-handle">@${escapeHtml(user.username)}</span>` : '';
    return `<li class="dashboard-user-item" data-user-id="${escapeHtml(user.id)}">
      ${avatarHtml}
      <div class="dashboard-user-info">
        <div class="dashboard-user-name">${escapeHtml(displayName)}${subName}</div>
        <div class="dashboard-user-meta">${escapeHtml(user.email || user.user_id)} &middot; ${user.provider || 'local'} &middot; ${date}</div>
      </div>
      <span class="dashboard-user-status status-${user.status}">${user.status}</span>
      <div class="dashboard-user-actions">
        ${showApprove ? `<button class="btn btn-small btn-approve" onclick="window.dashboardApproveUser('${escapeHtml(user.id)}')">Approve</button>` : ''}
        ${showReject ? `<button class="btn btn-small btn-reject" onclick="window.dashboardRejectUser('${escapeHtml(user.id)}')">Reject</button>` : ''}
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

function fetchCookiesStatus() {
  const statusEl = document.getElementById('cookies-status');
  if (!statusEl) return;
  fetch('/api/dashboard/cookies', { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.exists) {
        const ago = formatAge(data.updatedAt);
        statusEl.textContent = `Cookies active — updated ${ago}`;
        statusEl.className = 'cookies-status cookies-active';
      } else {
        statusEl.textContent = 'No cookies set';
        statusEl.className = 'cookies-status cookies-none';
      }
    })
    .catch(() => { statusEl.textContent = 'Could not load cookie status'; });
}

function saveCookies() {
  const textarea = document.getElementById('cookies-input');
  const content = textarea ? textarea.value.trim() : '';
  if (!content) { showToast('Paste cookies.txt content first', 'error'); return; }
  fetch('/api/dashboard/cookies', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'text/plain' },
    body: content
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast('Cookies saved', 'success');
        if (textarea) textarea.value = '';
        fetchCookiesStatus();
      } else {
        showToast(data.error || 'Failed to save cookies', 'error');
      }
    })
    .catch(() => showToast('Failed to save cookies', 'error'));
}

function deleteCookies() {
  if (!confirm('Remove YouTube cookies?')) return;
  fetch('/api/dashboard/cookies', { method: 'DELETE', credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.success) { showToast('Cookies removed', 'success'); fetchCookiesStatus(); }
      else showToast('Failed to remove cookies', 'error');
    })
    .catch(() => showToast('Failed to remove cookies', 'error'));
}
