// Listen-Along Frontend Application
(function() {
  'use strict';

  // localStorage Keys
  const STORAGE_KEYS = {
    USER_ID: 'listen-userId',
    USERNAME: 'listen-username',
    LAST_LOBBY: 'listen-lastLobby',
    REPEAT_MODE: 'listen-repeatMode',
    SHUFFLE_ENABLED: 'listen-shuffleEnabled'
  };

  // localStorage Helpers
  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn('localStorage unavailable:', e);
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('localStorage unavailable:', e);
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('localStorage unavailable:', e);
    }
  }

  // Load persisted user identity or generate new
  function getOrCreateUserId() {
    const stored = storageGet(STORAGE_KEYS.USER_ID);
    if (stored) return stored;
    const newId = 'user_' + Math.random().toString(36).substr(2, 9);
    storageSet(STORAGE_KEYS.USER_ID, newId);
    return newId;
  }

  function getOrCreateUsername() {
    const stored = storageGet(STORAGE_KEYS.USERNAME);
    if (stored) return stored;
    const adjectives = ['Happy', 'Chill', 'Groovy', 'Funky', 'Cool', 'Mellow'];
    const nouns = ['Listener', 'DJ', 'Vibes', 'Beat', 'Rhythm', 'Sound'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const newUsername = `${adj}${noun}${Math.floor(Math.random() * 100)}`;
    storageSet(STORAGE_KEYS.USERNAME, newUsername);
    return newUsername;
  }

  // Load persisted preferences
  function getStoredRepeatMode() {
    return storageGet(STORAGE_KEYS.REPEAT_MODE) || 'off';
  }

  function getStoredShuffleEnabled() {
    return storageGet(STORAGE_KEYS.SHUFFLE_ENABLED) === 'true';
  }

  // App State
  const state = {
    lobbyId: null,
    isHost: false,
    isPlaying: false,
    isShuffleEnabled: getStoredShuffleEnabled(),
    currentTrack: null,
    queue: [],
    listeners: [],
    userId: getOrCreateUserId(),
    username: getOrCreateUsername(),
    repeatMode: getStoredRepeatMode(),
    audioUnlocked: false,
    pendingPlay: null,
    downloadStatus: {}, // Map of url -> { status, percent }
    userMode: 'listening', // 'listening' or 'lobby'
    listeningMode: 'synchronized', // 'synchronized' or 'independent'
    // Solo playlist state
    soloPlaylistId: null,
    soloPlaylistSongs: [],
    soloCurrentIndex: -1,
    soloRepeatMode: getStoredRepeatMode(),
    playlists: []
  };

  // DOM Elements
  const elements = {
    // Views
    landingView: document.getElementById('landing-view'),
    lobbyView: document.getElementById('lobby-view'),
    dashboardView: document.getElementById('dashboard-view'),

    // Landing
    createLobbyBtn: document.getElementById('create-lobby-btn'),

    // Lobby Header
    backBtn: document.getElementById('back-btn'),
    shareBtn: document.getElementById('share-btn'),
    listeningModeBadge: document.getElementById('listening-mode-badge'),
    modeBtn: document.getElementById('mode-btn'),
    lobbyName: document.getElementById('lobby-name'),
    userCount: document.getElementById('user-count'),

    // Now Playing
    albumArt: document.getElementById('album-art'),
    trackTitle: document.getElementById('track-title'),
    trackArtist: document.getElementById('track-artist'),
    progressBar: document.getElementById('progress-bar'),
    currentTime: document.getElementById('current-time'),
    duration: document.getElementById('duration'),

    // Playback Controls
    shuffleBtn: document.getElementById('shuffle-btn'),
    playBtn: document.getElementById('play-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    repeatBtn: document.getElementById('repeat-btn'),

    // Bottom Nav
    navItems: document.querySelectorAll('.nav-item'),

    // Tabs
    queueTab: document.getElementById('queue-tab'),
    listenersTab: document.getElementById('listeners-tab'),

    // Queue
    songInput: document.getElementById('song-input'),
    addSongBtn: document.getElementById('add-song-btn'),
    queueList: document.getElementById('queue-list'),

    // Listeners
    listenersList: document.getElementById('listeners-list'),

    // Audio
    audioPlayer: document.getElementById('audio-player'),

    // Toast
    toastContainer: document.getElementById('toast-container'),

    // Version
    versionDisplay: document.getElementById('version-display'),

    // Dashboard
    dashboardUptime: document.getElementById('dashboard-uptime'),
    statLobbies: document.getElementById('stat-lobbies'),
    statUsers: document.getElementById('stat-users'),
    statMemory: document.getElementById('stat-memory'),
    dashboardLobbyList: document.getElementById('dashboard-lobby-list'),

    // Solo Player
    soloView: document.getElementById('solo-view'),
    soloBackBtn: document.getElementById('solo-back-btn'),
    soloPlaylistName: document.getElementById('solo-playlist-name'),
    soloSongCount: document.getElementById('solo-song-count'),
    soloAlbumArt: document.getElementById('solo-album-art'),
    soloTrackTitle: document.getElementById('solo-track-title'),
    soloTrackArtist: document.getElementById('solo-track-artist'),
    soloProgressBar: document.getElementById('solo-progress-bar'),
    soloCurrentTime: document.getElementById('solo-current-time'),
    soloDuration: document.getElementById('solo-duration'),
    soloPlayBtn: document.getElementById('solo-play-btn'),
    soloPrevBtn: document.getElementById('solo-prev-btn'),
    soloNextBtn: document.getElementById('solo-next-btn'),
    soloRepeatBtn: document.getElementById('solo-repeat-btn'),
    soloSongInput: document.getElementById('solo-song-input'),
    soloAddSongBtn: document.getElementById('solo-add-song-btn'),
    soloAddSongHeaderBtn: document.getElementById('solo-add-song-header-btn'),
    soloQueueList: document.getElementById('solo-queue-list'),

    // Playlists
    playlistsSection: document.getElementById('playlists-section'),
    createPlaylistBtn: document.getElementById('create-playlist-btn'),
    playlistsList: document.getElementById('playlists-list'),

    // Cache Management
    cacheReady: document.getElementById('cache-ready'),
    cacheDownloading: document.getElementById('cache-downloading'),
    cachePending: document.getElementById('cache-pending'),
    cacheError: document.getElementById('cache-error'),
    cacheDuration: document.getElementById('cache-duration'),
    cacheSongList: document.getElementById('cache-song-list'),
    nukeCacheBtn: document.getElementById('nuke-cache-btn')
  };

  // Socket.IO Connection
  let socket = null;

  // Dashboard state
  let dashboardInterval = null;

  // Initialize Application
  function init() {
    // Check for dashboard route first (no socket needed)
    if (checkUrlForDashboard()) {
      return;
    }

    setupSocket();
    setupEventListeners();
    checkUrlForLobby();
    setupAudioPlayer();
    setupSoloAudioHooks();
    fetchVersion();
    fetchPlaylists();
  }

  // Fetch and display version
  function fetchVersion() {
    fetch('/api/version')
      .then(res => res.json())
      .then(data => {
        if (data.version && elements.versionDisplay) {
          elements.versionDisplay.textContent = `v${data.version}`;
        }
      })
      .catch(() => {
        // Silently ignore version fetch errors
      });
  }

  // Socket.IO Setup
  function setupSocket() {
    socket = io({
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    socket.on('connect', () => {
      console.log('Connected to server');
      if (state.lobbyId) {
        joinLobby(state.lobbyId);
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      showToast('Connection lost. Reconnecting...', 'error');
    });

    socket.on('reconnect', () => {
      console.log('Reconnected to server');
      showToast('Reconnected!', 'success');
      if (state.lobbyId) {
        joinLobby(state.lobbyId);
      }
    });

    // Lobby Events
    socket.on('lobby:created', handleLobbyCreated);
    socket.on('lobby:joined', handleLobbyJoined);
    socket.on('lobby:error', handleLobbyError);
    socket.on('lobby:user-joined', handleUserJoined);
    socket.on('lobby:user-left', handleUserLeft);
    socket.on('lobby:closed', handleLobbyClosed);

    // Queue Events
    socket.on('queue:update', handleQueueUpdated);
    socket.on('queue:song-added', handleSongAdded);
    socket.on('queue:error', (data) => showToast(data.message, 'error'));
    socket.on('queue:adding', (data) => showToast(data.status, 'info'));

    // Playback Events
    socket.on('playback:state', handlePlaybackState);
    socket.on('playback:sync', handlePlaybackSync);
    socket.on('playback:track-changed', handleTrackChanged);
    socket.on('playback:shuffle', handleShuffleState);

    // Download Events
    socket.on('download:status', handleDownloadStatus);
    socket.on('download:progress', handleDownloadProgress);

    // Mode Events
    socket.on('mode:changed', handleModeChanged);
    socket.on('users:updated', handleUsersUpdated);
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Create Lobby
    elements.createLobbyBtn.addEventListener('click', createLobby);

    // Lobby type selector styling
    document.querySelectorAll('.lobby-type-option').forEach(option => {
      option.addEventListener('click', () => {
        document.querySelectorAll('.lobby-type-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
      });
    });

    // Leave Lobby
    elements.backBtn.addEventListener('click', leaveLobby);

    // Share Lobby
    elements.shareBtn.addEventListener('click', shareLobby);

    // Toggle Mode (listening/lobby)
    if (elements.modeBtn) {
      elements.modeBtn.addEventListener('click', toggleUserMode);
    }

    // Playback Controls
    elements.shuffleBtn.addEventListener('click', toggleShuffle);
    elements.playBtn.addEventListener('click', togglePlayback);
    elements.prevBtn.addEventListener('click', playPrevious);
    elements.nextBtn.addEventListener('click', playNext);
    elements.repeatBtn.addEventListener('click', cycleRepeatMode);

    // Progress Bar
    elements.progressBar.addEventListener('input', seekTo);

    // Add Song
    elements.addSongBtn.addEventListener('click', addSong);
    elements.songInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addSong();
    });

    // Tab Navigation
    elements.navItems.forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.tab));
    });

    // Handle browser navigation
    window.addEventListener('popstate', handlePopState);

    // Playlist / Solo player
    if (elements.createPlaylistBtn) {
      elements.createPlaylistBtn.addEventListener('click', createNewPlaylist);
    }
    if (elements.soloBackBtn) {
      elements.soloBackBtn.addEventListener('click', leaveSoloPlayer);
    }
    if (elements.soloPlayBtn) {
      elements.soloPlayBtn.addEventListener('click', soloTogglePlayback);
    }
    if (elements.soloPrevBtn) {
      elements.soloPrevBtn.addEventListener('click', soloPrevious);
    }
    if (elements.soloNextBtn) {
      elements.soloNextBtn.addEventListener('click', soloNext);
    }
    if (elements.soloRepeatBtn) {
      elements.soloRepeatBtn.addEventListener('click', soloCycleRepeat);
    }
    if (elements.soloProgressBar) {
      elements.soloProgressBar.addEventListener('input', soloSeek);
    }
    if (elements.soloAddSongBtn) {
      elements.soloAddSongBtn.addEventListener('click', soloAddSong);
    }
    if (elements.soloAddSongHeaderBtn) {
      elements.soloAddSongHeaderBtn.addEventListener('click', () => {
        if (elements.soloSongInput) elements.soloSongInput.focus();
      });
    }
    if (elements.soloSongInput) {
      elements.soloSongInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') soloAddSong();
      });
    }
  }

  // Check URL for Dashboard
  function checkUrlForDashboard() {
    if (window.location.pathname === '/dashboard') {
      showView('dashboard');
      return true;
    }
    return false;
  }

  // Check URL for Lobby ID
  function checkUrlForLobby() {
    const path = window.location.pathname;
    const match = path.match(/^\/lobby\/([a-zA-Z0-9-]+)$/);
    if (match) {
      state.lobbyId = match[1];
      joinLobby(state.lobbyId);
    } else {
      // No lobby in URL, check if we have a remembered lobby to rejoin
      checkForLastLobby();
    }
  }

  // Check for last visited lobby and offer to rejoin
  function checkForLastLobby() {
    const lastLobby = storageGet(STORAGE_KEYS.LAST_LOBBY);
    if (!lastLobby) return;

    // Show rejoin prompt
    showRejoinPrompt(lastLobby);
  }

  // Show prompt to rejoin last lobby
  function showRejoinPrompt(lobbyId) {
    // Don't show if there's already a prompt
    if (document.getElementById('rejoin-prompt')) return;

    const prompt = document.createElement('div');
    prompt.id = 'rejoin-prompt';
    prompt.className = 'rejoin-prompt';
    prompt.innerHTML = `
      <div class="rejoin-content">
        <p>Rejoin your last lobby?</p>
        <div class="rejoin-lobby-id">${escapeHtml(lobbyId)}</div>
        <div class="rejoin-actions">
          <button class="btn rejoin-btn" id="rejoin-yes">Rejoin</button>
          <button class="btn btn-secondary rejoin-btn" id="rejoin-no">No thanks</button>
        </div>
      </div>
    `;

    // Insert after landing view or at the start of main content
    const landingView = elements.landingView;
    if (landingView) {
      landingView.appendChild(prompt);
    }

    // Event handlers
    document.getElementById('rejoin-yes').addEventListener('click', () => {
      hideRejoinPrompt();
      window.history.pushState({ lobbyId }, '', `/lobby/${lobbyId}`);
      state.lobbyId = lobbyId;
      joinLobby(lobbyId);
    });

    document.getElementById('rejoin-no').addEventListener('click', () => {
      hideRejoinPrompt();
      // Clear stored lobby so we don't ask again
      storageRemove(STORAGE_KEYS.LAST_LOBBY);
    });
  }

  function hideRejoinPrompt() {
    const prompt = document.getElementById('rejoin-prompt');
    if (prompt) {
      prompt.remove();
    }
  }

  // Fetch and display dashboard stats
  function fetchDashboardStats() {
    fetch('/api/dashboard/stats')
      .then(res => res.json())
      .then(data => {
        if (elements.statLobbies) {
          elements.statLobbies.textContent = data.totalLobbies;
        }
        if (elements.statUsers) {
          elements.statUsers.textContent = data.totalUsers;
        }
        if (elements.statMemory) {
          const memMB = Math.round(data.memoryUsage.heapUsed / 1024 / 1024);
          elements.statMemory.textContent = memMB;
        }
        if (elements.dashboardUptime) {
          elements.dashboardUptime.textContent = `Uptime: ${formatUptime(data.uptime)}`;
        }
        if (elements.dashboardLobbyList) {
          updateDashboardLobbies(data.lobbies);
        }
      })
      .catch(err => {
        console.error('Failed to fetch dashboard stats:', err);
      });
  }

  // Update dashboard lobby list
  function updateDashboardLobbies(lobbies) {
    if (!lobbies || lobbies.length === 0) {
      elements.dashboardLobbyList.innerHTML = '<li class="dashboard-empty">No active lobbies</li>';
      return;
    }

    elements.dashboardLobbyList.innerHTML = lobbies.map(lobby => {
      const age = formatAge(lobby.createdAt);
      return `
        <li class="dashboard-lobby-item">
          <div class="dashboard-lobby-id">${escapeHtml(lobby.id)}</div>
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
        </li>
      `;
    }).join('');
  }

  // Format uptime as human readable
  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  // Format age from timestamp
  function formatAge(timestamp) {
    const age = Date.now() - timestamp;
    const mins = Math.floor(age / 60000);
    const hours = Math.floor(age / 3600000);

    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'just now';
  }

  // Fetch and display cache stats
  function fetchCacheStats() {
    fetch('/api/dashboard/cache')
      .then(res => res.json())
      .then(data => {
        if (!data.enabled) {
          if (elements.cacheSongList) {
            elements.cacheSongList.innerHTML = '<li class="dashboard-empty">Caching disabled (no database)</li>';
          }
          return;
        }

        if (elements.cacheReady) elements.cacheReady.textContent = data.stats.ready;
        if (elements.cacheDownloading) elements.cacheDownloading.textContent = data.stats.downloading;
        if (elements.cachePending) elements.cachePending.textContent = data.stats.pending;
        if (elements.cacheError) elements.cacheError.textContent = data.stats.error;
        if (elements.cacheDuration) {
          elements.cacheDuration.textContent = formatDuration(data.stats.totalDuration);
        }
      })
      .catch(err => {
        console.error('Failed to fetch cache stats:', err);
      });
  }

  // Format duration in seconds to human readable
  function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Fetch and display cached songs
  function fetchCachedSongs() {
    fetch('/api/dashboard/cache/songs')
      .then(res => res.json())
      .then(data => {
        updateCacheSongList(data.songs);
      })
      .catch(err => {
        console.error('Failed to fetch cached songs:', err);
      });
  }

  // Update cache song list
  function updateCacheSongList(songs) {
    if (!elements.cacheSongList) return;

    if (!songs || songs.length === 0) {
      elements.cacheSongList.innerHTML = '<li class="dashboard-empty">No cached songs</li>';
      return;
    }

    elements.cacheSongList.innerHTML = songs.map(song => {
      const duration = formatDuration(song.duration);
      const statusClass = song.status;
      const thumbnail = song.thumbnail_url
        ? `<img class="cache-song-thumb" src="${escapeHtml(song.thumbnail_url)}" alt="">`
        : `<div class="cache-song-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;

      return `
        <li class="cache-song-item">
          ${thumbnail}
          <div class="cache-song-info">
            <div class="cache-song-title">${escapeHtml(song.title || 'Unknown')}</div>
            <div class="cache-song-meta">
              <span>${duration}</span>
              <span class="cache-song-status ${statusClass}">${song.status}</span>
            </div>
          </div>
          <div class="cache-song-actions">
            ${song.status === 'ready' ? `<button class="btn-icon" onclick="window.playCachedSong('${escapeHtml(song.url)}')" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
            <button class="btn-icon" onclick="window.deleteCachedSong('${escapeHtml(song.id)}')" title="Delete"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          </div>
        </li>
      `;
    }).join('');
  }

  // Delete a single cached song
  function deleteCachedSong(songId) {
    if (!confirm('Delete this cached song?')) return;

    fetch(`/api/dashboard/cache/songs/${songId}`, { method: 'DELETE' })
      .then(res => {
        if (res.ok) {
          fetchCacheStats();
          fetchCachedSongs();
        } else {
          alert('Failed to delete song');
        }
      })
      .catch(() => alert('Failed to delete song'));
  }

  // Delete all cached songs
  function nukeAllCachedSongs() {
    if (!confirm('Delete ALL cached songs? This cannot be undone.')) return;

    fetch('/api/dashboard/cache/songs', { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          fetchCacheStats();
          fetchCachedSongs();
          alert(`Deleted ${data.deleted} cached songs`);
        } else {
          alert('Failed to delete songs');
        }
      })
      .catch(() => alert('Failed to delete songs'));
  }

  // Play a cached song (opens in a new lobby or uses existing)
  function playCachedSong(url) {
    // For now, copy the URL to clipboard so user can add it to a lobby
    navigator.clipboard.writeText(url).then(() => {
      alert('Song URL copied to clipboard. Create or join a lobby to play it.');
    }).catch(() => {
      prompt('Copy this URL to add to a lobby:', url);
    });
  }

  // Audio Player Setup
  function setupAudioPlayer() {
    const audio = elements.audioPlayer;

    audio.addEventListener('timeupdate', () => {
      if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        elements.progressBar.value = percent;
        elements.currentTime.textContent = formatTime(audio.currentTime);
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      elements.duration.textContent = formatTime(audio.duration);
    });

    audio.addEventListener('ended', () => {
      // Solo player handles its own ended events
      if (state.soloPlaylistId) return;
      if (state.listeningMode === 'independent') {
        advanceLocalQueue();
        return;
      }
      socket.emit('playback:ended', { lobbyId: state.lobbyId });
    });

    audio.addEventListener('play', () => {
      state.isPlaying = true;
      state.audioUnlocked = true;
      updatePlayButton();
      hideUnlockPrompt();
    });

    audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updatePlayButton();
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
      showToast('Error playing audio', 'error');
    });

    // Mobile Safari unlock detection
    setupAudioUnlock();
  }

  // Mobile Safari audio unlock handling
  function setupAudioUnlock() {
    // Detect iOS Safari
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    if (isIOS || isSafari) {
      // On iOS/Safari, try to unlock audio on any user interaction
      const unlockAudio = () => {
        if (state.audioUnlocked) return;

        const audio = elements.audioPlayer;
        // Create a silent play to unlock audio
        const silentPlay = audio.play();
        if (silentPlay) {
          silentPlay.then(() => {
            audio.pause();
            state.audioUnlocked = true;
            console.log('Audio unlocked via user gesture');
            hideUnlockPrompt();
            // If there was a pending play, execute it now
            if (state.pendingPlay) {
              const pending = state.pendingPlay;
              state.pendingPlay = null;
              playAudioWithUnlock(pending.src, pending.position, pending.shouldPlay);
            }
          }).catch(() => {
            // Still locked, will be unlocked on explicit play button tap
          });
        }
      };

      // Unlock on various user interactions
      ['touchstart', 'touchend', 'click'].forEach(event => {
        document.addEventListener(event, unlockAudio, { once: false, passive: true });
      });
    }
  }

  // Try to play audio, handling Safari restrictions
  function playAudioWithUnlock(src, position, shouldPlay) {
    const audio = elements.audioPlayer;

    if (src && audio.src !== src) {
      audio.src = src;
    }

    if (position !== undefined && isFinite(position)) {
      audio.currentTime = position;
    }

    if (shouldPlay) {
      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(e => {
          console.log('Autoplay blocked:', e);
          // Show user-friendly message for Safari users
          if (e.name === 'NotAllowedError') {
            state.pendingPlay = { src: audio.src, position: audio.currentTime, shouldPlay: true };
            showUnlockPrompt();
          }
        });
      }
    }
  }

  // Show a prompt for Safari users to tap to enable audio
  function showUnlockPrompt() {
    if (document.getElementById('audio-unlock-prompt')) return;

    const prompt = document.createElement('div');
    prompt.id = 'audio-unlock-prompt';
    prompt.className = 'audio-unlock-prompt';
    prompt.innerHTML = `
      <div class="unlock-content">
        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
        </svg>
        <span>Tap to enable audio</span>
      </div>
    `;

    prompt.addEventListener('click', () => {
      const audio = elements.audioPlayer;
      if (state.pendingPlay) {
        audio.src = state.pendingPlay.src;
        audio.currentTime = state.pendingPlay.position || 0;
      }
      audio.play().then(() => {
        state.audioUnlocked = true;
        state.pendingPlay = null;
        hideUnlockPrompt();
      }).catch(e => {
        console.error('Play failed even with user gesture:', e);
        showToast('Could not play audio. Try again.', 'error');
      });
    });

    document.body.appendChild(prompt);
  }

  function hideUnlockPrompt() {
    const prompt = document.getElementById('audio-unlock-prompt');
    if (prompt) {
      prompt.remove();
    }
  }

  // View Management
  function showView(viewName) {
    elements.landingView.classList.remove('active');
    elements.lobbyView.classList.remove('active');
    if (elements.soloView) {
      elements.soloView.classList.remove('active');
    }
    if (elements.dashboardView) {
      elements.dashboardView.classList.remove('active');
    }

    // Stop dashboard polling when leaving
    if (dashboardInterval) {
      clearInterval(dashboardInterval);
      dashboardInterval = null;
    }

    if (viewName === 'landing') {
      elements.landingView.classList.add('active');
      fetchPlaylists();
    } else if (viewName === 'solo') {
      elements.soloView.classList.add('active');
    } else if (viewName === 'lobby') {
      elements.lobbyView.classList.add('active');
    } else if (viewName === 'dashboard' && elements.dashboardView) {
      elements.dashboardView.classList.add('active');
      fetchDashboardStats();
      fetchCacheStats();
      fetchCachedSongs();
      // Set up nuke button listener
      if (elements.nukeCacheBtn) {
        elements.nukeCacheBtn.onclick = nukeAllCachedSongs;
      }
      dashboardInterval = setInterval(() => {
        fetchDashboardStats();
        fetchCacheStats();
      }, 2000);
    }
  }

  // Lobby Actions
  function createLobby() {
    elements.createLobbyBtn.disabled = true;
    elements.createLobbyBtn.textContent = 'Creating...';
    const selectedMode = document.querySelector('input[name="listeningMode"]:checked');
    const listeningMode = selectedMode ? selectedMode.value : 'synchronized';
    socket.emit('lobby:create', { username: state.username, listeningMode });
  }

  function joinLobby(lobbyId) {
    socket.emit('lobby:join', { lobbyId, username: state.username });
  }

  function leaveLobby() {
    socket.emit('lobby:leave', { lobbyId: state.lobbyId });
    state.lobbyId = null;
    state.isHost = false;
    state.listeningMode = 'synchronized';
    state.queue = [];
    state.listeners = [];
    state.currentTrack = null;
    state.downloadStatus = {};

    elements.audioPlayer.pause();
    elements.audioPlayer.src = '';

    window.history.pushState({}, '', '/');
    showView('landing');
    resetLobbyUI();
  }

  function shareLobby() {
    const url = window.location.href;

    if (navigator.share) {
      navigator.share({
        title: 'Join my listen-along lobby!',
        text: 'Listen to music together with me',
        url: url
      }).catch(() => {
        copyToClipboard(url);
      });
    } else {
      copyToClipboard(url);
    }
  }

  // Socket Event Handlers
  function handleLobbyCreated(data) {
    state.lobbyId = data.lobbyId;
    state.isHost = true;
    state.listeningMode = data.listeningMode || 'synchronized';

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);

    elements.createLobbyBtn.disabled = false;
    elements.createLobbyBtn.textContent = 'Create Lobby';

    window.history.pushState({ lobbyId: data.lobbyId }, '', `/lobby/${data.lobbyId}`);
    elements.lobbyName.textContent = `Lobby ${data.lobbyId}`;
    updateListeningModeBadge();

    showView('lobby');
    showToast('Lobby created! Share the link to invite friends.', 'success');
  }

  function handleLobbyJoined(data) {
    state.lobbyId = data.lobbyId;
    state.isHost = data.isHost || false;
    state.listeningMode = data.listeningMode || 'synchronized';
    state.queue = data.queue || [];
    // Handle both 'listeners' and 'users' from backend
    state.listeners = data.listeners || data.users || [];
    state.currentTrack = data.currentTrack || null;

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
    // Hide rejoin prompt if it was showing
    hideRejoinPrompt();

    elements.lobbyName.textContent = `Lobby ${data.lobbyId}`;
    updateListeningModeBadge();

    showView('lobby');
    updateListeners();
    updateQueue();

    if (state.currentTrack) {
      updateNowPlaying(state.currentTrack);
      if (data.playbackState) {
        handlePlaybackSync(data.playbackState);
      }
    }
  }

  function handleLobbyError(data) {
    elements.createLobbyBtn.disabled = false;
    elements.createLobbyBtn.textContent = 'Create Lobby';

    // If lobby not found, clear it from localStorage
    if (data.message && data.message.toLowerCase().includes('not found')) {
      storageRemove(STORAGE_KEYS.LAST_LOBBY);
      hideRejoinPrompt();
    }

    showToast(data.message || 'Lobby error', 'error');
  }

  function handleUserJoined(data) {
    // Use full users list from server if available, otherwise add single user
    if (data.users) {
      state.listeners = data.users;
    } else {
      state.listeners.push(data.user);
    }
    updateListeners();
    showToast(`${data.user.username} joined`, 'success');
  }

  function handleUserLeft(data) {
    state.listeners = state.listeners.filter(u => u.id !== data.userId);
    updateListeners();
  }

  function handleLobbyClosed(data) {
    showToast(data.message || 'This lobby has been closed.', 'error');
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    state.lobbyId = null;
    state.isHost = false;
    state.queue = [];
    state.listeners = [];
    state.currentTrack = null;
    elements.audioPlayer.pause();
    elements.audioPlayer.src = '';
    window.history.pushState({}, '', '/');
    showView('landing');
    resetLobbyUI();
  }

  function handleQueueUpdated(data) {
    state.queue = data.songs || data.queue || [];
    updateQueue();
    if (data.songs && data.songs.length > 0) {
      showToast(`Queue updated: ${data.songs.length} song(s)`, 'success');
    }
  }

  function handleSongAdded(data) {
    state.queue.push(data.song);
    updateQueue();
    showToast(`Added: ${data.song.title}`, 'success');
  }

  function handlePlaybackState(data) {
    state.isPlaying = data.isPlaying;
    state.currentTrack = data.track;

    if (state.currentTrack) {
      updateNowPlaying(state.currentTrack);
    }

    if (data.isPlaying && data.audioUrl) {
      playAudioWithUnlock(data.audioUrl, data.position || 0, true);
    } else {
      elements.audioPlayer.pause();
    }

    updatePlayButton();
  }

  function handlePlaybackSync(data) {
    // In independent mode, don't apply server sync - each user controls their own playback
    if (state.listeningMode === 'independent') return;

    const audio = elements.audioPlayer;
    const serverPosition = data.position || 0;

    // Update play state for UI
    state.isPlaying = data.isPlaying;
    updatePlayButton();

    // Update repeat mode if provided
    if (data.repeatMode !== undefined && data.repeatMode !== state.repeatMode) {
      state.repeatMode = data.repeatMode;
      // Persist preference
      storageSet(STORAGE_KEYS.REPEAT_MODE, data.repeatMode);
      updateRepeatButton();
    }

    // Don't play audio if user is in lobby mode
    const shouldPlayAudio = state.userMode === 'listening';

    // If we have a track and it's different or audio has no src, set it up
    if (data.track && data.track.url) {
      const streamUrl = `/api/stream?q=${encodeURIComponent(data.track.url)}`;

      // Check if we need to change the source
      if (!audio.src || !audio.src.includes(encodeURIComponent(data.track.url))) {
        state.currentTrack = data.track;
        updateNowPlaying(data.track);

        if (data.isPlaying && shouldPlayAudio) {
          playAudioWithUnlock(streamUrl, serverPosition, true);
        } else {
          audio.src = streamUrl;
          audio.currentTime = serverPosition;
        }
        return;
      }
    }

    // Sync position if drift is more than 1 second
    const drift = Math.abs(audio.currentTime - serverPosition);
    if (drift > 1) {
      audio.currentTime = serverPosition;
    }

    // Sync play/pause state (only if in listening mode)
    if (shouldPlayAudio) {
      if (data.isPlaying && audio.paused) {
        playAudioWithUnlock(audio.src, audio.currentTime, true);
      } else if (!data.isPlaying && !audio.paused) {
        audio.pause();
      }
    } else {
      // In lobby mode, ensure audio is paused
      if (!audio.paused) {
        audio.pause();
      }
    }
  }

  function handleTrackChanged(data) {
    state.currentTrack = data.track;
    state.queue = data.queue || state.queue;

    updateNowPlaying(data.track);
    updateQueue();

    if (data.audioUrl) {
      playAudioWithUnlock(data.audioUrl, 0, true);
    }
  }

  function handleShuffleState(data) {
    state.isShuffleEnabled = data.shuffleEnabled;
    // Persist preference
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(data.shuffleEnabled));
    updateShuffleButton();
  }

  function handleDownloadStatus(data) {
    state.downloadStatus[data.url] = {
      status: data.status,
      percent: data.percent || 0,
      error: data.error
    };
    updateQueue();
  }

  function handleDownloadProgress(data) {
    if (state.downloadStatus[data.url]) {
      state.downloadStatus[data.url].percent = data.percent;
    } else {
      state.downloadStatus[data.url] = {
        status: 'downloading',
        percent: data.percent
      };
    }
    updateQueueProgress(data.url, data.percent);
  }

  function handleModeChanged(data) {
    state.userMode = data.mode;
    updateModeButton();

    // Handle audio based on mode
    if (data.mode === 'lobby') {
      // Pause audio when entering lobby mode
      elements.audioPlayer.pause();
      showToast('Lobby mode: Audio paused', 'info');
    } else if (data.mode === 'listening' && state.isPlaying) {
      // Resume audio when entering listening mode if something is playing
      const audio = elements.audioPlayer;
      if (audio.src) {
        playAudioWithUnlock(audio.src, audio.currentTime, true);
      }
      showToast('Listening mode: Audio resumed', 'info');
    }
  }

  function handleUsersUpdated(data) {
    state.listeners = data.users || [];
    updateListeners();
  }

  function toggleUserMode() {
    const newMode = state.userMode === 'listening' ? 'lobby' : 'listening';
    socket.emit('mode:set', { lobbyId: state.lobbyId, mode: newMode });
  }

  // Optimized progress update without full re-render
  function updateQueueProgress(url, percent) {
    const queueItems = elements.queueList.querySelectorAll('.queue-item');
    for (const item of queueItems) {
      const progressBar = item.querySelector('.queue-item-progress-bar');
      if (progressBar && item.dataset.url === url) {
        progressBar.style.width = `${percent}%`;
        const percentText = item.querySelector('.queue-item-percent');
        if (percentText) {
          percentText.textContent = `${percent}%`;
        }
        break;
      }
    }
  }

  // Playback Controls
  function toggleShuffle() {
    const newShuffleState = !state.isShuffleEnabled;
    socket.emit('playback:shuffle', {
      lobbyId: state.lobbyId,
      enabled: newShuffleState,
      queueLength: state.queue.length
    });
  }

  function togglePlayback() {
    if (state.listeningMode === 'independent') {
      const audio = elements.audioPlayer;
      if (audio.paused) {
        // If no track loaded, play first song from queue
        if (!audio.src || audio.src === window.location.origin + '/') {
          if (state.queue.length > 0) {
            playLocalTrack(state.queue[0]);
          }
        } else {
          playAudioWithUnlock(audio.src, audio.currentTime, true);
        }
      } else {
        audio.pause();
      }
      return;
    }
    socket.emit('playback:toggle', { lobbyId: state.lobbyId });
  }

  function playPrevious() {
    if (state.listeningMode === 'independent') {
      // Restart current track from beginning
      const audio = elements.audioPlayer;
      if (audio.src) {
        audio.currentTime = 0;
        if (audio.paused) {
          playAudioWithUnlock(audio.src, 0, true);
        }
      }
      return;
    }
    socket.emit('playback:previous', { lobbyId: state.lobbyId });
  }

  function playNext() {
    if (state.listeningMode === 'independent') {
      advanceLocalQueue();
      return;
    }
    socket.emit('playback:next', { lobbyId: state.lobbyId });
  }

  function cycleRepeatMode() {
    const modes = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(state.repeatMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];
    if (state.listeningMode === 'independent') {
      state.repeatMode = nextMode;
      storageSet(STORAGE_KEYS.REPEAT_MODE, nextMode);
      updateRepeatButton();
      return;
    }
    socket.emit('playback:setRepeat', { lobbyId: state.lobbyId, mode: nextMode });
  }

  function seekTo() {
    const percent = elements.progressBar.value;
    const duration = elements.audioPlayer.duration;
    if (duration) {
      const position = (percent / 100) * duration;
      if (state.listeningMode === 'independent') {
        elements.audioPlayer.currentTime = position;
        return;
      }
      socket.emit('playback:seek', { lobbyId: state.lobbyId, position });
    }
  }

  // Independent mode: play a track locally
  function playLocalTrack(track) {
    if (!track) return;
    state.currentTrack = track;
    updateNowPlaying(track);
    const streamUrl = `/api/stream?q=${encodeURIComponent(track.url)}`;
    playAudioWithUnlock(streamUrl, 0, true);
  }

  // Independent mode: advance to next track in queue
  function advanceLocalQueue() {
    if (state.queue.length === 0) return;

    const currentIndex = state.currentTrack
      ? state.queue.findIndex(s => s.id === state.currentTrack.id)
      : -1;

    let nextIndex = currentIndex + 1;

    if (state.repeatMode === 'one' && currentIndex >= 0) {
      // Repeat current track
      playLocalTrack(state.queue[currentIndex]);
      return;
    }

    if (nextIndex >= state.queue.length) {
      if (state.repeatMode === 'all') {
        nextIndex = 0;
      } else {
        // Queue finished
        elements.audioPlayer.pause();
        state.isPlaying = false;
        updatePlayButton();
        return;
      }
    }

    playLocalTrack(state.queue[nextIndex]);
  }

  // Queue Management
  function addSong() {
    const input = elements.songInput.value.trim();
    if (!input) return;

    socket.emit('queue:add', {
      lobbyId: state.lobbyId,
      query: input
    });

    elements.songInput.value = '';
  }

  function removeSong(index) {
    const song = state.queue[index];
    if (!song) return;
    socket.emit('queue:remove', {
      lobbyId: state.lobbyId,
      songId: song.id
    });
  }

  function moveSongUp(index) {
    if (index <= 1) return; // Can't move the first song (playing) or move to index 0
    const song = state.queue[index];
    if (!song) return;
    socket.emit('queue:reorder', {
      lobbyId: state.lobbyId,
      songId: song.id,
      newIndex: index - 1
    });
  }

  function moveSongDown(index) {
    if (index === 0 || index >= state.queue.length - 1) return; // Can't move the playing song or past the end
    const song = state.queue[index];
    if (!song) return;
    socket.emit('queue:reorder', {
      lobbyId: state.lobbyId,
      songId: song.id,
      newIndex: index + 1
    });
  }

  // UI Updates
  function updateNowPlaying(track) {
    elements.trackTitle.textContent = track.title || 'Unknown Track';
    elements.trackArtist.textContent = track.artist || '';

    const thumbUrl = track.id ? getCoverUrl(track.id, track.thumbnail) : sanitizeUrl(track.thumbnail);
    if (thumbUrl) {
      elements.albumArt.innerHTML = `<img src="${thumbUrl}" alt="Album art">`;
    } else {
      elements.albumArt.innerHTML = `
        <div class="placeholder-art">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
      `;
    }
  }

  function updatePlayButton() {
    const icon = elements.playBtn.querySelector('svg');
    if (state.isPlaying) {
      icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
      elements.playBtn.setAttribute('aria-label', 'Pause');
    } else {
      icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      elements.playBtn.setAttribute('aria-label', 'Play');
    }
  }

  function updateShuffleButton() {
    if (elements.shuffleBtn) {
      if (state.isShuffleEnabled) {
        elements.shuffleBtn.classList.add('active');
        elements.shuffleBtn.setAttribute('aria-pressed', 'true');
      } else {
        elements.shuffleBtn.classList.remove('active');
        elements.shuffleBtn.setAttribute('aria-pressed', 'false');
      }
    }
  }

  function updateRepeatButton() {
    if (elements.repeatBtn) {
      elements.repeatBtn.dataset.mode = state.repeatMode;
      const labels = {
        'off': 'Repeat off',
        'all': 'Repeat all',
        'one': 'Repeat one'
      };
      elements.repeatBtn.setAttribute('aria-label', labels[state.repeatMode]);
    }
  }

  function updateListeningModeBadge() {
    const badge = elements.listeningModeBadge;
    if (!badge) return;

    if (state.listeningMode === 'independent') {
      badge.textContent = 'Independent';
      badge.className = 'listening-mode-badge independent';
      badge.hidden = false;
    } else {
      badge.textContent = 'Synchronized';
      badge.className = 'listening-mode-badge synchronized';
      badge.hidden = false;
    }
  }

  function updateModeButton() {
    if (elements.modeBtn) {
      const isListening = state.userMode === 'listening';
      elements.modeBtn.classList.toggle('active', isListening);
      elements.modeBtn.setAttribute('aria-pressed', isListening.toString());
      elements.modeBtn.setAttribute('aria-label', isListening ? 'Switch to lobby mode' : 'Switch to listening mode');
      elements.modeBtn.title = isListening ? 'Listening - click to enter lobby mode' : 'Lobby mode - click to start listening';

      // Update icon
      const icon = elements.modeBtn.querySelector('svg');
      if (icon) {
        if (isListening) {
          // Headphones icon for listening
          icon.innerHTML = '<path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>';
        } else {
          // Eye icon for lobby mode (watching but not listening)
          icon.innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
        }
      }
    }
  }

  function updateQueue() {
    if (state.queue.length === 0) {
      elements.queueList.innerHTML = `
        <li class="queue-empty">
          <p>Queue is empty</p>
          <p class="hint">Add a song to get started</p>
        </li>
      `;
      return;
    }

    elements.queueList.innerHTML = state.queue.map((song, index) => {
      const thumbUrl = song.id ? getCoverUrl(song.id, song.thumbnail) : sanitizeUrl(song.thumbnail);
      const downloadInfo = state.downloadStatus[song.url];
      const downloadHtml = getDownloadStatusHtml(downloadInfo, song.url);
      const isPlaying = index === 0;
      const canMoveUp = index > 1; // Can't move to index 0 (currently playing)
      const canMoveDown = index > 0 && index < state.queue.length - 1;

      return `
      <li class="queue-item ${state.currentTrack && state.currentTrack.id === song.id ? 'playing' : ''}" data-index="${index}" data-url="${escapeHtml(song.url)}">
        <div class="queue-item-thumb">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}
          ${downloadHtml.icon}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(song.title)}</div>
          <div class="queue-item-meta">
            <span class="queue-item-duration">${song.duration || ''}</span>
            ${downloadHtml.badge}
          </div>
          ${downloadHtml.progressBar}
        </div>
        <div class="queue-item-actions">
          ${!isPlaying ? `
            <div class="queue-item-reorder">
              <button class="btn-icon-small queue-item-up" aria-label="Move up" onclick="window.app.moveSongUp(${index})" ${!canMoveUp ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
              </button>
              <button class="btn-icon-small queue-item-down" aria-label="Move down" onclick="window.app.moveSongDown(${index})" ${!canMoveDown ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              </button>
            </div>
          ` : ''}
          <button class="btn-icon queue-item-remove" aria-label="Remove from queue" onclick="window.app.removeSong(${index})">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </li>`;
    }).join('');
  }

  function getDownloadStatusHtml(downloadInfo, url) {
    if (!downloadInfo) {
      return { icon: '', badge: '', progressBar: '' };
    }

    const status = downloadInfo.status;
    const percent = downloadInfo.percent || 0;

    let icon = '';
    let badge = '';
    let progressBar = '';

    switch (status) {
      case 'pending':
        icon = '<span class="queue-item-status pending" title="Pending download">⏳</span>';
        badge = '<span class="queue-item-badge pending">pending</span>';
        break;
      case 'downloading':
        icon = '<span class="queue-item-status downloading" title="Downloading">📥</span>';
        badge = `<span class="queue-item-badge downloading"><span class="queue-item-percent">${percent}%</span></span>`;
        progressBar = `<div class="queue-item-progress"><div class="queue-item-progress-bar" style="width: ${percent}%"></div></div>`;
        break;
      case 'ready':
        icon = '<span class="queue-item-status ready" title="Ready">✓</span>';
        break;
      case 'error':
        icon = '<span class="queue-item-status error" title="Download failed">❌</span>';
        badge = '<span class="queue-item-badge error">error</span>';
        break;
    }

    return { icon, badge, progressBar };
  }

  function updateListeners() {
    elements.userCount.textContent = `${state.listeners.length} listener${state.listeners.length !== 1 ? 's' : ''}`;

    if (state.listeners.length === 0) {
      elements.listenersList.innerHTML = `
        <li class="listener-empty">
          <p>No one else is here yet</p>
          <p class="hint">Share the lobby link to invite friends</p>
        </li>
      `;
      return;
    }

    elements.listenersList.innerHTML = state.listeners.map(user => {
      const modeIcon = user.mode === 'lobby'
        ? '<svg class="mode-icon lobby" viewBox="0 0 24 24" fill="currentColor" title="Lobby mode"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'
        : '<svg class="mode-icon listening" viewBox="0 0 24 24" fill="currentColor" title="Listening"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg>';
      return `
      <li class="listener-item ${user.mode === 'lobby' ? 'lobby-mode' : ''}">
        <div class="listener-avatar">${getInitials(user.username)}</div>
        <span class="listener-name">${escapeHtml(user.username)}</span>
        ${modeIcon}
        ${user.isHost ? '<span class="listener-badge">Host</span>' : ''}
      </li>`;
    }).join('');
  }

  function resetLobbyUI() {
    elements.trackTitle.textContent = 'No track playing';
    elements.trackArtist.textContent = 'Add a song to get started';
    elements.progressBar.value = 0;
    elements.currentTime.textContent = '0:00';
    elements.duration.textContent = '0:00';
    elements.albumArt.innerHTML = `
      <div class="placeholder-art">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      </div>
    `;
    state.isPlaying = false;
    state.isShuffleEnabled = false;
    state.repeatMode = 'off';
    state.userMode = 'listening';
    updatePlayButton();
    updateShuffleButton();
    updateRepeatButton();
    updateModeButton();
    updateQueue();
    updateListeners();
  }

  // Tab Navigation
  function switchTab(tabName) {
    elements.navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });

    elements.queueTab.classList.toggle('active', tabName === 'queue');
    elements.listenersTab.classList.toggle('active', tabName === 'listeners');
  }

  // Browser Navigation
  function handlePopState() {
    const path = window.location.pathname;
    if (path === '/') {
      if (state.lobbyId) {
        leaveLobby();
      }
    } else {
      checkUrlForLobby();
    }
  }

  // Utility Functions
  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function sanitizeUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return url;
      }
    } catch (e) {
      return '';
    }
    return '';
  }

  function getCoverUrl(songId, thumbnailUrl) {
    if (!songId) return sanitizeUrl(thumbnailUrl);
    const fallback = thumbnailUrl ? encodeURIComponent(thumbnailUrl) : '';
    return `/api/covers/${songId}${fallback ? `?fallback=${fallback}` : ''}`;
  }

  function getInitials(name) {
    return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Link copied to clipboard!', 'success');
    }).catch(() => {
      showToast('Could not copy link', 'error');
    });
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(1rem)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ==========================================
  // Playlists & Solo Player
  // ==========================================

  function fetchPlaylists() {
    fetch(`/api/playlists?userId=${encodeURIComponent(state.userId)}`)
      .then(res => res.json())
      .then(data => {
        state.playlists = data.playlists || [];
        renderPlaylists();
      })
      .catch(() => {
        // Silently handle - playlists not available without DB
      });
  }

  function renderPlaylists() {
    if (!elements.playlistsSection || !elements.playlistsList) return;

    if (state.playlists.length === 0) {
      elements.playlistsSection.hidden = false;
      elements.playlistsList.innerHTML = '<li class="playlists-empty">No playlists yet. Create one to save songs!</li>';
      return;
    }

    elements.playlistsSection.hidden = false;
    elements.playlistsList.innerHTML = state.playlists.map(p => `
      <li class="playlist-item" data-id="${escapeHtml(p.id)}">
        <div class="playlist-item-icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
        </div>
        <div class="playlist-item-info" onclick="window.app.openPlaylist('${escapeHtml(p.id)}')">
          <div class="playlist-item-name">${escapeHtml(p.name)}</div>
          <div class="playlist-item-meta">${p.song_count || 0} song${(p.song_count || 0) !== 1 ? 's' : ''}</div>
        </div>
        <div class="playlist-item-actions">
          <button class="btn-icon" onclick="window.app.deletePlaylist('${escapeHtml(p.id)}')" aria-label="Delete playlist">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </li>
    `).join('');
  }

  function createNewPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;

    fetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, name: name.trim() })
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to create');
        return res.json();
      })
      .then(created => {
        showToast(`Playlist "${created.name}" created`, 'success');
        fetchPlaylists();
      })
      .catch(() => {
        showToast('Could not create playlist. Database may be unavailable.', 'error');
      });
  }

  function deletePlaylistAction(playlistId) {
    if (!confirm('Delete this playlist?')) return;

    fetch(`/api/playlists/${playlistId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId })
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed');
        return res.json();
      })
      .then(() => {
        showToast('Playlist deleted', 'success');
        fetchPlaylists();
      })
      .catch(() => showToast('Failed to delete playlist', 'error'));
  }

  function openPlaylist(playlistId) {
    fetch(`/api/playlists/${playlistId}`)
      .then(res => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then(playlist => {
        state.soloPlaylistId = playlist.id;
        state.soloPlaylistSongs = playlist.songs || [];
        state.soloCurrentIndex = -1;

        elements.soloPlaylistName.textContent = playlist.name;
        updateSoloSongCount();
        updateSoloQueue();
        resetSoloNowPlaying();

        showView('solo');
        window.history.pushState({ solo: playlistId }, '', `/`);

        if (state.soloPlaylistSongs.length > 0) {
          soloPlayTrack(0);
        }
      })
      .catch(() => showToast('Could not open playlist', 'error'));
  }

  function leaveSoloPlayer() {
    elements.audioPlayer.pause();
    elements.audioPlayer.src = '';
    state.soloPlaylistId = null;
    state.soloPlaylistSongs = [];
    state.soloCurrentIndex = -1;
    showView('landing');
  }

  function updateSoloSongCount() {
    if (elements.soloSongCount) {
      const count = state.soloPlaylistSongs.length;
      elements.soloSongCount.textContent = `${count} song${count !== 1 ? 's' : ''}`;
    }
  }

  function resetSoloNowPlaying() {
    if (elements.soloTrackTitle) elements.soloTrackTitle.textContent = 'No track playing';
    if (elements.soloTrackArtist) elements.soloTrackArtist.textContent = 'Add a song to get started';
    if (elements.soloAlbumArt) {
      elements.soloAlbumArt.innerHTML = '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
    }
    if (elements.soloProgressBar) elements.soloProgressBar.value = 0;
    if (elements.soloCurrentTime) elements.soloCurrentTime.textContent = '0:00';
    if (elements.soloDuration) elements.soloDuration.textContent = '0:00';
  }

  function soloPlayTrack(index) {
    if (index < 0 || index >= state.soloPlaylistSongs.length) return;

    state.soloCurrentIndex = index;
    const song = state.soloPlaylistSongs[index];

    // Update now playing display
    if (elements.soloTrackTitle) elements.soloTrackTitle.textContent = song.title || 'Unknown';
    if (elements.soloTrackArtist) elements.soloTrackArtist.textContent = '';

    const thumbUrl = sanitizeUrl(song.thumbnail);
    if (elements.soloAlbumArt) {
      if (thumbUrl) {
        elements.soloAlbumArt.innerHTML = `<img src="${thumbUrl}" alt="Album art">`;
      } else {
        elements.soloAlbumArt.innerHTML = '<div class="placeholder-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
      }
    }

    const streamUrl = `/api/stream?q=${encodeURIComponent(song.url)}`;
    playAudioWithUnlock(streamUrl, 0, true);
    updateSoloQueue();
  }

  function soloTogglePlayback() {
    const audio = elements.audioPlayer;
    if (audio.paused) {
      if (!audio.src || audio.src === window.location.origin + '/') {
        if (state.soloPlaylistSongs.length > 0) {
          soloPlayTrack(0);
        }
      } else {
        playAudioWithUnlock(audio.src, audio.currentTime, true);
      }
    } else {
      audio.pause();
    }
  }

  function soloPrevious() {
    const audio = elements.audioPlayer;
    if (audio.src) {
      audio.currentTime = 0;
      if (audio.paused) {
        playAudioWithUnlock(audio.src, 0, true);
      }
    }
  }

  function soloNext() {
    soloAdvance();
  }

  function soloAdvance() {
    if (state.soloPlaylistSongs.length === 0) return;

    let nextIndex = state.soloCurrentIndex + 1;

    if (state.soloRepeatMode === 'one' && state.soloCurrentIndex >= 0) {
      soloPlayTrack(state.soloCurrentIndex);
      return;
    }

    if (nextIndex >= state.soloPlaylistSongs.length) {
      if (state.soloRepeatMode === 'all') {
        nextIndex = 0;
      } else {
        elements.audioPlayer.pause();
        return;
      }
    }

    soloPlayTrack(nextIndex);
  }

  function soloCycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(state.soloRepeatMode);
    state.soloRepeatMode = modes[(currentIndex + 1) % modes.length];
    storageSet(STORAGE_KEYS.REPEAT_MODE, state.soloRepeatMode);
    updateSoloRepeatButton();
  }

  function updateSoloRepeatButton() {
    if (elements.soloRepeatBtn) {
      elements.soloRepeatBtn.dataset.mode = state.soloRepeatMode;
      const labels = { 'off': 'Repeat off', 'all': 'Repeat all', 'one': 'Repeat one' };
      elements.soloRepeatBtn.setAttribute('aria-label', labels[state.soloRepeatMode]);
    }
  }

  function soloSeek() {
    const percent = elements.soloProgressBar.value;
    const duration = elements.audioPlayer.duration;
    if (duration) {
      elements.audioPlayer.currentTime = (percent / 100) * duration;
    }
  }

  function soloAddSong() {
    const input = elements.soloSongInput.value.trim();
    if (!input || !state.soloPlaylistId) return;

    elements.soloAddSongBtn.disabled = true;
    showToast('Fetching song info...', 'info');

    // First fetch metadata
    fetch(`/api/metadata?q=${encodeURIComponent(input)}`)
      .then(res => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then(meta => {
        // Add to playlist via API
        return fetch(`/api/playlists/${state.soloPlaylistId}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: meta.url || input,
            title: meta.title || 'Unknown',
            duration: meta.duration || 0,
            thumbnail: meta.thumbnail || null
          })
        });
      })
      .then(res => {
        if (!res.ok) throw new Error('Failed to add');
        return res.json();
      })
      .then(song => {
        state.soloPlaylistSongs.push(song);
        updateSoloQueue();
        updateSoloSongCount();
        elements.soloSongInput.value = '';
        showToast(`Added: ${song.title}`, 'success');

        // Auto-play if first song
        if (state.soloPlaylistSongs.length === 1) {
          soloPlayTrack(0);
        }
      })
      .catch(err => {
        showToast('Failed to add song', 'error');
      })
      .finally(() => {
        elements.soloAddSongBtn.disabled = false;
      });
  }

  function soloRemoveSong(index) {
    const song = state.soloPlaylistSongs[index];
    if (!song || !state.soloPlaylistId) return;

    fetch(`/api/playlists/${state.soloPlaylistId}/songs/${song.id}`, { method: 'DELETE' })
      .then(res => {
        if (!res.ok) throw new Error('Failed');
        state.soloPlaylistSongs.splice(index, 1);

        // Adjust current index
        if (index < state.soloCurrentIndex) {
          state.soloCurrentIndex--;
        } else if (index === state.soloCurrentIndex) {
          // Current song removed - play next or stop
          if (state.soloPlaylistSongs.length > 0) {
            const nextIdx = Math.min(state.soloCurrentIndex, state.soloPlaylistSongs.length - 1);
            soloPlayTrack(nextIdx);
          } else {
            elements.audioPlayer.pause();
            elements.audioPlayer.src = '';
            state.soloCurrentIndex = -1;
            resetSoloNowPlaying();
          }
        }

        updateSoloQueue();
        updateSoloSongCount();
      })
      .catch(() => showToast('Failed to remove song', 'error'));
  }

  function updateSoloQueue() {
    if (!elements.soloQueueList) return;

    if (state.soloPlaylistSongs.length === 0) {
      elements.soloQueueList.innerHTML = '<li class="queue-empty"><p>Playlist is empty</p><p class="hint">Add a song to get started</p></li>';
      return;
    }

    elements.soloQueueList.innerHTML = state.soloPlaylistSongs.map((song, index) => {
      const thumbUrl = sanitizeUrl(song.thumbnail);
      const isPlaying = index === state.soloCurrentIndex;

      return `
      <li class="queue-item ${isPlaying ? 'playing' : ''}" data-index="${index}">
        <div class="queue-item-thumb" onclick="window.app.soloPlayTrack(${index})">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}
        </div>
        <div class="queue-item-info" onclick="window.app.soloPlayTrack(${index})" style="cursor:pointer">
          <div class="queue-item-title">${escapeHtml(song.title)}</div>
          <div class="queue-item-meta">
            <span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span>
          </div>
        </div>
        <div class="queue-item-actions">
          <button class="btn-icon queue-item-remove" aria-label="Remove from playlist" onclick="window.app.soloRemoveSong(${index})">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </li>`;
    }).join('');
  }

  // Hook audio events for solo player
  function setupSoloAudioHooks() {
    const audio = elements.audioPlayer;

    audio.addEventListener('timeupdate', () => {
      // Update solo progress bar if in solo view
      if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) {
        if (audio.duration) {
          const percent = (audio.currentTime / audio.duration) * 100;
          elements.soloProgressBar.value = percent;
          elements.soloCurrentTime.textContent = formatTime(audio.currentTime);
        }
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) {
        elements.soloDuration.textContent = formatTime(audio.duration);
      }
    });

    audio.addEventListener('ended', () => {
      if (state.soloPlaylistId && elements.soloView && elements.soloView.classList.contains('active')) {
        soloAdvance();
      }
    });

    audio.addEventListener('play', () => {
      if (state.soloPlaylistId) updateSoloPlayButton();
    });

    audio.addEventListener('pause', () => {
      if (state.soloPlaylistId) updateSoloPlayButton();
    });
  }

  function updateSoloPlayButton() {
    if (!elements.soloPlayBtn) return;
    const icon = elements.soloPlayBtn.querySelector('svg');
    const audio = elements.audioPlayer;
    if (!audio.paused) {
      icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
      elements.soloPlayBtn.setAttribute('aria-label', 'Pause');
    } else {
      icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      elements.soloPlayBtn.setAttribute('aria-label', 'Play');
    }
  }

  // Dashboard actions
  function dashboardJoinLobby(lobbyId) {
    window.location.href = `/lobby/${lobbyId}`;
  }

  function dashboardRemoveLobby(lobbyId) {
    if (!confirm(`Remove lobby ${lobbyId}? This will disconnect all users.`)) {
      return;
    }
    fetch(`/api/dashboard/lobbies/${lobbyId}`, { method: 'DELETE' })
      .then(res => {
        if (res.ok) {
          fetchDashboardStats();
        } else {
          alert('Failed to remove lobby');
        }
      })
      .catch(() => alert('Failed to remove lobby'));
  }

  // Expose API for inline handlers
  window.app = {
    removeSong,
    moveSongUp,
    moveSongDown,
    openPlaylist,
    deletePlaylist: deletePlaylistAction,
    soloPlayTrack: soloPlayTrack,
    soloRemoveSong: soloRemoveSong
  };
  window.dashboardJoinLobby = dashboardJoinLobby;
  window.dashboardRemoveLobby = dashboardRemoveLobby;
  window.deleteCachedSong = deleteCachedSong;
  window.playCachedSong = playCachedSong;

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
