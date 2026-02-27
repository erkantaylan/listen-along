// Listen-Along Frontend Application
(function() {
  'use strict';

  // localStorage Keys
  const STORAGE_KEYS = {
    USER_ID: 'listen-userId',
    USERNAME: 'listen-username',
    EMOJI: 'listen-emoji',
    LAST_LOBBY: 'listen-lastLobby',
    REPEAT_MODE: 'listen-repeatMode',
    SHUFFLE_ENABLED: 'listen-shuffleEnabled',
    PLAYBACK_MODE: 'listen-playbackMode',
    VOLUME: 'listen-volume',
    HIDE_ERRORED_SONGS: 'listen-hideErroredSongs',
    QUEUE_SORT: 'listen-queueSort'
  };

  // Predefined emoji avatars
  const AVATAR_EMOJIS = ['🎸','🎹','🎺','🎷','🥁','🎤','🎧','🎵','🦊','🐱','🐶','🐸','🦄','🐙','🤖','👻','🔥','⚡','🌈','🍕'];

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

  function getOrCreateEmoji() {
    const stored = storageGet(STORAGE_KEYS.EMOJI);
    if (stored) return stored;
    const emoji = AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)];
    storageSet(STORAGE_KEYS.EMOJI, emoji);
    return emoji;
  }

  // Load persisted preferences
  function getStoredRepeatMode() {
    return storageGet(STORAGE_KEYS.REPEAT_MODE) || 'off';
  }

  function getStoredShuffleEnabled() {
    return storageGet(STORAGE_KEYS.SHUFFLE_ENABLED) === 'true';
  }

  // Migrate old unified playback mode to separate repeat + shuffle keys
  function migratePlaybackMode() {
    const stored = storageGet(STORAGE_KEYS.PLAYBACK_MODE);
    if (stored && ['repeat-all', 'repeat-one', 'stop', 'shuffle'].includes(stored)) {
      // Map old unified mode to separate keys
      const repeatMap = { 'repeat-all': 'all', 'repeat-one': 'one', 'stop': 'off', 'shuffle': 'off' };
      storageSet(STORAGE_KEYS.REPEAT_MODE, repeatMap[stored]);
      storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(stored === 'shuffle'));
      // Remove the old unified key
      try { localStorage.removeItem(STORAGE_KEYS.PLAYBACK_MODE); } catch (e) { /* ignore */ }
    }
  }

  // Run migration on load
  migratePlaybackMode();

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
    emoji: getOrCreateEmoji(),
    repeatMode: getStoredRepeatMode(),
    audioUnlocked: false,
    pendingPlay: null,
    downloadStatus: {}, // Map of url -> { status, percent }
    userMode: 'listening', // 'listening' or 'lobby'
    listeningMode: 'synchronized', // 'synchronized' or 'independent'
    pinned: false, // whether lobby is pinned (persistent)
    // Solo playlist state
    soloPlaylistId: null,
    soloPlaylistSongs: [],
    soloCurrentIndex: -1,
    soloRepeatMode: getStoredRepeatMode(),
    playlists: [],
    pendingLobbyId: null, // Lobby ID pending room type selection
    volume: storageGet(STORAGE_KEYS.VOLUME) !== null ? parseFloat(storageGet(STORAGE_KEYS.VOLUME)) : 1,
    isMuted: false,
    volumeBeforeMute: 1,
    hideErroredSongs: storageGet(STORAGE_KEYS.HIDE_ERRORED_SONGS) !== 'false', // default true
    queueSort: storageGet(STORAGE_KEYS.QUEUE_SORT) || 'default' // 'default', 'newest', 'oldest'
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
    renameBtn: document.getElementById('rename-btn'),
    pinBtn: document.getElementById('pin-btn'),
    lobbyNameInput: document.getElementById('lobby-name-input'),
    userCount: document.getElementById('user-count'),

    // Now Playing
    albumArt: document.getElementById('album-art'),
    trackTitle: document.getElementById('track-title'),
    trackArtist: document.getElementById('track-artist'),
    progressBar: document.getElementById('progress-bar'),
    currentTime: document.getElementById('current-time'),
    duration: document.getElementById('duration'),

    // Playback Controls
    playBtn: document.getElementById('play-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    repeatBtn: document.getElementById('repeat-btn'),
    shuffleBtn: document.getElementById('shuffle-btn'),

    // Bottom Nav
    navItems: document.querySelectorAll('.nav-item'),

    // Tabs
    queueTab: document.getElementById('queue-tab'),
    socialTab: document.getElementById('social-tab'),

    // Queue
    songInput: document.getElementById('song-input'),
    addSongBtn: document.getElementById('add-song-btn'),
    queueList: document.getElementById('queue-list'),
    hideErroredCheckbox: document.getElementById('hide-errored-songs'),
    queueSortSelect: document.getElementById('queue-sort'),

    // Chat (inside social tab)
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatSendBtn: document.getElementById('chat-send-btn'),
    chatTicker: document.getElementById('chat-ticker'),
    chatTickerContent: document.getElementById('chat-ticker-content'),

    // Listeners
    listenersList: document.getElementById('listeners-list'),
    profileEditor: document.getElementById('profile-editor'),
    profileEmojiBtn: document.getElementById('profile-emoji-btn'),
    profileNameInput: document.getElementById('profile-name-input'),
    profileSaveBtn: document.getElementById('profile-save-btn'),
    emojiPicker: document.getElementById('emoji-picker'),

    // Volume
    volumeBtn: document.getElementById('volume-btn'),
    volumeBar: document.getElementById('volume-bar'),
    volumeIcon: document.getElementById('volume-icon'),
    soloVolumeBtn: document.getElementById('solo-volume-btn'),
    soloVolumeBar: document.getElementById('solo-volume-bar'),
    soloVolumeIcon: document.getElementById('solo-volume-icon'),

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
    statDisk: document.getElementById('stat-disk'),
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

    // Active Lobbies
    lobbiesSection: document.getElementById('lobbies-section'),
    lobbiesList: document.getElementById('lobbies-list'),

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
    nukeCacheBtn: document.getElementById('nuke-cache-btn'),
    clearErrorsBtn: document.getElementById('clear-errors-btn'),

    // Room Type Modal
    roomTypeModal: document.getElementById('room-type-modal'),
    roomTypeLobbyName: document.getElementById('room-type-lobby-name'),
    roomTypeCreateBtn: document.getElementById('room-type-create-btn'),
    roomTypeCancelBtn: document.getElementById('room-type-cancel-btn')
  };

  // Socket.IO Connection
  let socket = null;

  // Dashboard state
  let dashboardInterval = null;

  // Lobbies auto-refresh state
  let lobbiesInterval = null;

  // Initialize Application
  async function init() {
    // Initialize i18n first
    if (window.i18n) {
      await window.i18n.init();
      setupLanguageSelector();
    }

    // Check for dashboard route first (no socket needed)
    if (checkUrlForDashboard()) {
      return;
    }

    setupSocket();
    setupEventListeners();
    setupProfileEditor();
    checkUrlForLobby();
    setupAudioPlayer();
    setupMediaSession();
    setupSoloAudioHooks();
    fetchVersion();
    fetchLobbies();
    fetchPlaylists();
    // Auto-refresh lobbies while on landing page
    lobbiesInterval = setInterval(fetchLobbies, 10000);
  }

  // Setup language selector
  function setupLanguageSelector() {
    const selector = document.getElementById('language-selector');
    if (!selector || !window.i18n) return;

    // Set current language
    selector.value = window.i18n.getLanguage();

    // Handle language change
    selector.addEventListener('change', async (e) => {
      await window.i18n.setLanguage(e.target.value);
      // Re-render dynamic content that uses translations
      updateQueue();
      updateListeners();
    });
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
      showToast(t('toast.connectionLost', 'Connection lost. Reconnecting...'), 'error');
    });

    socket.on('reconnect', () => {
      console.log('Reconnected to server');
      showToast(t('toast.reconnected', 'Reconnected!'), 'success');
      if (state.lobbyId) {
        joinLobby(state.lobbyId);
      }
    });

    // Lobby Events
    socket.on('lobby:created', handleLobbyCreated);
    socket.on('lobby:joined', handleLobbyJoined);
    socket.on('lobby:not-found', handleLobbyNotFound);
    socket.on('lobby:error', handleLobbyError);
    socket.on('lobby:user-joined', handleUserJoined);
    socket.on('lobby:user-left', handleUserLeft);
    socket.on('lobby:closed', handleLobbyClosed);
    socket.on('lobby:renamed', handleLobbyRenamed);
    socket.on('lobby:pinned', handleLobbyPinned);

    // Queue Events
    socket.on('queue:update', handleQueueUpdated);
    socket.on('queue:song-added', handleSongAdded);
    socket.on('queue:error', (data) => {
      const loadingEl = document.getElementById('playlist-loading');
      if (loadingEl) loadingEl.remove();
      showToast(data.message, 'error');
    });
    socket.on('queue:adding', (data) => showToast(data.status, 'info'));

    // Playlist confirmation dialog
    socket.on('queue:playlist-confirm', handlePlaylistConfirm);
    socket.on('queue:playlist-progress', (data) => {
      // Update a single persistent toast instead of creating one per song
      let toast = document.getElementById('playlist-progress-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'playlist-progress-toast';
        toast.className = 'toast info';
        elements.toastContainer.appendChild(toast);
      }
      toast.textContent = `Adding songs: ${data.current}/${data.total}`;
    });
    socket.on('queue:playlist-complete', (data) => {
      // Remove the progress toast and show a final summary
      const progressToast = document.getElementById('playlist-progress-toast');
      if (progressToast) progressToast.remove();
      showToast(`Added ${data.added} songs from "${data.playlistTitle}"`, 'success');
    });

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

    // Chat Events
    socket.on('chat:message', handleChatMessage);
    socket.on('chat:history', handleChatHistory);
    socket.on('chat:error', (data) => showToast(data.message, 'error'));
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Create Lobby
    elements.createLobbyBtn.addEventListener('click', createLobby);

    // Lobby type selector styling (scoped to each selector group)
    document.querySelectorAll('.lobby-type-selector').forEach(selector => {
      selector.querySelectorAll('.lobby-type-option').forEach(option => {
        option.addEventListener('click', () => {
          selector.querySelectorAll('.lobby-type-option').forEach(o => o.classList.remove('selected'));
          option.classList.add('selected');
        });
      });
    });

    // Room type modal buttons
    if (elements.roomTypeCreateBtn) {
      elements.roomTypeCreateBtn.addEventListener('click', () => {
        const selectedMode = document.querySelector('#room-type-modal input[name="roomTypeMode"]:checked');
        const listeningMode = selectedMode ? selectedMode.value : 'synchronized';
        if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
        socket.emit('lobby:create', {
          username: state.username,
          emoji: state.emoji,
          listeningMode,
          lobbyId: state.pendingLobbyId
        });
        state.pendingLobbyId = null;
      });
    }
    if (elements.roomTypeCancelBtn) {
      elements.roomTypeCancelBtn.addEventListener('click', () => {
        if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
        state.pendingLobbyId = null;
        window.history.pushState({}, '', '/');
        showView('landing');
      });
    }

    // Leave Lobby
    elements.backBtn.addEventListener('click', leaveLobby);

    // Share Lobby
    elements.shareBtn.addEventListener('click', shareLobby);

    // Rename Lobby
    if (elements.renameBtn) {
      elements.renameBtn.addEventListener('click', promptRenameLobby);
    }

    // Pin Lobby
    if (elements.pinBtn) {
      elements.pinBtn.addEventListener('click', togglePin);
    }

    // Toggle Mode (listening/lobby)
    if (elements.modeBtn) {
      elements.modeBtn.addEventListener('click', toggleUserMode);
    }

    // Playback Controls
    elements.playBtn.addEventListener('click', togglePlayback);
    elements.prevBtn.addEventListener('click', playPrevious);
    elements.nextBtn.addEventListener('click', playNext);
    elements.repeatBtn.addEventListener('click', cycleRepeatMode);
    elements.shuffleBtn.addEventListener('click', toggleShuffle);

    // Progress Bar
    elements.progressBar.addEventListener('input', seekTo);

    // Add Song
    elements.addSongBtn.addEventListener('click', addSong);
    elements.songInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addSong();
    });

    // Chat
    if (elements.chatSendBtn) {
      elements.chatSendBtn.addEventListener('click', sendChatMessage);
    }
    if (elements.chatInput) {
      elements.chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
      });
    }

    // Queue drag and drop reordering
    setupQueueDragAndDrop();

    // Hide errored songs toggle
    if (elements.hideErroredCheckbox) {
      elements.hideErroredCheckbox.checked = state.hideErroredSongs;
      elements.hideErroredCheckbox.addEventListener('change', (e) => {
        state.hideErroredSongs = e.target.checked;
        storageSet(STORAGE_KEYS.HIDE_ERRORED_SONGS, state.hideErroredSongs);
        updateQueue();
      });
    }

    // Queue Sort
    if (elements.queueSortSelect) {
      elements.queueSortSelect.value = state.queueSort;
      elements.queueSortSelect.addEventListener('change', (e) => {
        state.queueSort = e.target.value;
        storageSet(STORAGE_KEYS.QUEUE_SORT, state.queueSort);
        updateQueue();
      });
    }

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

  // Profile Editor
  function setupProfileEditor() {
    if (!elements.profileEmojiBtn || !elements.profileNameInput) return;

    elements.profileEmojiBtn.textContent = state.emoji;
    elements.profileNameInput.value = state.username;

    // Build emoji picker grid
    elements.emojiPicker.innerHTML = AVATAR_EMOJIS.map(e =>
      `<button class="emoji-option${e === state.emoji ? ' selected' : ''}" data-emoji="${e}">${e}</button>`
    ).join('');

    elements.profileEmojiBtn.addEventListener('click', () => {
      elements.emojiPicker.hidden = !elements.emojiPicker.hidden;
    });

    elements.emojiPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-option');
      if (!btn) return;
      const emoji = btn.dataset.emoji;
      state.emoji = emoji;
      storageSet(STORAGE_KEYS.EMOJI, emoji);
      elements.profileEmojiBtn.textContent = emoji;
      elements.emojiPicker.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      elements.emojiPicker.hidden = true;
    });

    elements.profileSaveBtn.addEventListener('click', saveProfile);
    elements.profileNameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') saveProfile();
    });
  }

  function saveProfile() {
    const newName = elements.profileNameInput.value.trim();
    if (!newName) return;

    state.username = newName;
    storageSet(STORAGE_KEYS.USERNAME, newName);
    storageSet(STORAGE_KEYS.EMOJI, state.emoji);

    if (state.lobbyId && socket) {
      socket.emit('user:update', {
        lobbyId: state.lobbyId,
        username: state.username,
        emoji: state.emoji
      });
    }

    showToast('Profile updated', 'success');
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
    fetch('/api/dashboard/stats', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
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
        if (elements.statDisk) {
          const diskMB = (data.diskUsage.bytes / 1024 / 1024).toFixed(1);
          elements.statDisk.textContent = `${diskMB} MB (${data.diskUsage.fileCount} files)`;
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
    fetch('/api/dashboard/cache', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
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
  let cachedSongsData = [];

  function formatFileSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fetchCachedSongs() {
    fetch('/api/dashboard/cache/songs', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        cachedSongsData = data.songs || [];
        renderCacheSongList();
      })
      .catch(err => {
        console.error('Failed to fetch cached songs:', err);
      });
  }

  function renderCacheSongList() {
    if (!elements.cacheSongList) return;

    let songs = [...cachedSongsData];

    // Apply search filter
    const searchEl = document.getElementById('cache-search');
    const query = searchEl ? searchEl.value.toLowerCase() : '';
    if (query) {
      songs = songs.filter(s => (s.title || '').toLowerCase().includes(query));
    }

    // Apply sort
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

    if (songs.length === 0) {
      elements.cacheSongList.innerHTML = '<li class="dashboard-empty">No cached songs</li>';
      return;
    }

    elements.cacheSongList.innerHTML = songs.map(song => {
      const duration = formatDuration(song.duration);
      const fileSize = formatFileSize(song.file_size);
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
              <span>${fileSize}</span>
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

    fetch('/api/dashboard/cache/songs', { method: 'DELETE', credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          fetchCacheStats();
          fetchCachedSongs();
          fetchDashboardStats();
          alert(`Deleted ${data.deleted} cached songs`);
        } else {
          alert('Failed to delete songs');
        }
      })
      .catch(() => alert('Failed to delete songs'));
  }

  function clearErrorSongs() {
    if (!confirm('Delete all songs with error status?')) return;

    fetch('/api/dashboard/cache/errors', { method: 'DELETE', credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          fetchCacheStats();
          fetchCachedSongs();
          fetchDashboardStats();
          alert(`Deleted ${data.deleted} error songs`);
        } else {
          alert('Failed to delete error songs');
        }
      })
      .catch(() => alert('Failed to delete error songs'));
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

    // Initialize volume from stored preference
    audio.volume = state.volume;
    setupVolumeControls();
  }

  function setupMediaSession() {
    if (!window.MediaSessionManager) return;

    MediaSessionManager.init({
      onPlay: function () { togglePlayback(); },
      onPause: function () { togglePlayback(); },
      onNext: function () { playNext(); },
      onPrevious: function () { playPrevious(); },
      onSeekTo: function (time) {
        const audio = elements.audioPlayer;
        if (audio && audio.duration) {
          audio.currentTime = time;
        }
      }
    });

    // Update position state periodically from the audio element
    const audio = elements.audioPlayer;
    audio.addEventListener('timeupdate', function () {
      if (audio.duration) {
        MediaSessionManager.updatePositionState({
          duration: audio.duration,
          position: audio.currentTime
        });
      }
    });

    // Sync playback state with Media Session on play/pause
    audio.addEventListener('play', function () {
      MediaSessionManager.updatePlaybackState('playing');
    });
    audio.addEventListener('pause', function () {
      MediaSessionManager.updatePlaybackState('paused');
    });
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

  // Volume Control
  function setupVolumeControls() {
    const volumePercent = Math.round(state.volume * 100);

    // Initialize both sliders
    if (elements.volumeBar) {
      elements.volumeBar.value = volumePercent;
      elements.volumeBar.addEventListener('input', handleVolumeChange);
    }
    if (elements.soloVolumeBar) {
      elements.soloVolumeBar.value = volumePercent;
      elements.soloVolumeBar.addEventListener('input', handleVolumeChange);
    }

    // Mute toggle buttons
    if (elements.volumeBtn) {
      elements.volumeBtn.addEventListener('click', toggleMute);
    }
    if (elements.soloVolumeBtn) {
      elements.soloVolumeBtn.addEventListener('click', toggleMute);
    }

    updateVolumeIcon();
  }

  function handleVolumeChange(e) {
    const volume = parseInt(e.target.value, 10) / 100;
    state.volume = volume;
    state.isMuted = volume === 0;
    elements.audioPlayer.volume = volume;
    storageSet(STORAGE_KEYS.VOLUME, volume);

    // Sync both sliders
    const percent = Math.round(volume * 100);
    if (elements.volumeBar) elements.volumeBar.value = percent;
    if (elements.soloVolumeBar) elements.soloVolumeBar.value = percent;

    updateVolumeIcon();
  }

  function toggleMute() {
    if (state.isMuted) {
      state.isMuted = false;
      state.volume = state.volumeBeforeMute || 1;
    } else {
      state.isMuted = true;
      state.volumeBeforeMute = state.volume || 1;
      state.volume = 0;
    }

    elements.audioPlayer.volume = state.volume;
    storageSet(STORAGE_KEYS.VOLUME, state.volume);

    const percent = Math.round(state.volume * 100);
    if (elements.volumeBar) elements.volumeBar.value = percent;
    if (elements.soloVolumeBar) elements.soloVolumeBar.value = percent;

    updateVolumeIcon();
  }

  function updateVolumeIcon() {
    const vol = state.volume;
    let iconPath;
    if (vol === 0 || state.isMuted) {
      iconPath = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
    } else if (vol < 0.5) {
      iconPath = '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>';
    } else {
      iconPath = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
    if (elements.volumeIcon) elements.volumeIcon.innerHTML = iconPath;
    if (elements.soloVolumeIcon) elements.soloVolumeIcon.innerHTML = iconPath;
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

    // Stop lobbies polling when leaving landing
    if (lobbiesInterval) {
      clearInterval(lobbiesInterval);
      lobbiesInterval = null;
    }

    if (viewName === 'landing') {
      elements.landingView.classList.add('active');
      fetchLobbies();
      fetchPlaylists();
      lobbiesInterval = setInterval(fetchLobbies, 10000);
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
      if (elements.clearErrorsBtn) {
        elements.clearErrorsBtn.onclick = clearErrorSongs;
      }
      const cacheSearchEl = document.getElementById('cache-search');
      if (cacheSearchEl) cacheSearchEl.addEventListener('input', renderCacheSongList);
      const cacheSortEl = document.getElementById('cache-sort');
      if (cacheSortEl) cacheSortEl.addEventListener('change', renderCacheSongList);
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
    const name = elements.lobbyNameInput ? elements.lobbyNameInput.value.trim() : '';
    socket.emit('lobby:create', { username: state.username, emoji: state.emoji, listeningMode, name: name || undefined });
  }

  function joinLobby(lobbyId) {
    socket.emit('lobby:join', { lobbyId, username: state.username, emoji: state.emoji });
  }

  function leaveLobby() {
    socket.emit('lobby:leave', { lobbyId: state.lobbyId });
    state.lobbyId = null;
    state.isHost = false;
    state.lobbyName = null;
    state.listeningMode = 'synchronized';
    state.pinned = false;
    state.queue = [];
    state.listeners = [];
    state.currentTrack = null;
    state.downloadStatus = {};

    elements.audioPlayer.pause();
    elements.audioPlayer.src = '';

    window.history.pushState({}, '', '/');
    showView('landing');
    resetLobbyUI();
    resetChat();
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
    state.lobbyName = data.name || null;
    state.pinned = data.pinned || false;

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);

    elements.createLobbyBtn.disabled = false;
    elements.createLobbyBtn.textContent = 'Create Lobby';
    if (elements.lobbyNameInput) elements.lobbyNameInput.value = '';

    window.history.pushState({ lobbyId: data.lobbyId }, '', `/lobby/${data.lobbyId}`);
    elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
    updateListeningModeBadge();
    updatePinButton();

    showView('lobby');
    requestChatHistory();
    showToast('Lobby created! Share the link to invite friends.', 'success');
  }

  function handleLobbyNotFound({ lobbyId }) {
    // Show room type selection modal so user can choose before creating
    state.pendingLobbyId = lobbyId;
    if (elements.roomTypeLobbyName) {
      elements.roomTypeLobbyName.textContent = lobbyId;
    }
    // Reset modal selection to synchronized
    const modalOptions = document.querySelectorAll('#room-type-modal .lobby-type-option');
    modalOptions.forEach(opt => {
      const isSync = opt.dataset.mode === 'synchronized';
      opt.classList.toggle('selected', isSync);
      const radio = opt.querySelector('input[type="radio"]');
      if (radio) radio.checked = isSync;
    });
    if (elements.roomTypeModal) {
      elements.roomTypeModal.hidden = false;
    }
  }

  function handleLobbyJoined(data) {
    state.lobbyId = data.lobbyId;
    state.isHost = data.isHost || false;
    state.listeningMode = data.listeningMode || 'synchronized';
    state.lobbyName = data.name || null;
    state.pinned = data.pinned || false;
    state.queue = data.queue || [];
    // Handle both 'listeners' and 'users' from backend
    state.listeners = data.listeners || data.users || [];
    state.currentTrack = data.currentTrack || null;

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
    // Hide rejoin prompt if it was showing
    hideRejoinPrompt();

    elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
    updateListeningModeBadge();
    updatePinButton();

    showView('lobby');
    updateListeners();
    updateQueue();
    requestChatHistory();

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

    // Hide room type modal if open
    if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
    state.pendingLobbyId = null;

    // If lobby not found, clear it from localStorage
    if (data.message && data.message.toLowerCase().includes('not found')) {
      storageRemove(STORAGE_KEYS.LAST_LOBBY);
      hideRejoinPrompt();
    }

    showToast(data.message || 'Lobby error', 'error');
  }

  function handleLobbyRenamed(data) {
    state.lobbyName = data.name || null;
    elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
    showToast(`Lobby renamed to "${data.name}"`, 'success');
  }

  function handleLobbyPinned(data) {
    state.pinned = data.pinned;
    updatePinButton();
    showToast(data.pinned ? 'Lobby pinned — it won\'t be removed' : 'Lobby unpinned', 'success');
  }

  function updatePinButton() {
    if (!elements.pinBtn) return;
    elements.pinBtn.classList.toggle('active', state.pinned);
    elements.pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
    elements.pinBtn.title = state.pinned ? 'Unpin lobby (allow cleanup)' : 'Pin lobby (prevent cleanup)';
  }

  function togglePin() {
    socket.emit('lobby:pin', { lobbyId: state.lobbyId, pinned: !state.pinned });
  }

  function promptRenameLobby() {
    const currentName = state.lobbyName || '';
    const newName = prompt('Enter new lobby name:', currentName);
    if (newName === null) return; // Cancelled
    const trimmed = newName.trim();
    if (!trimmed) {
      showToast('Name cannot be empty', 'error');
      return;
    }
    if (trimmed.length > 50) {
      showToast('Name must be 50 characters or less', 'error');
      return;
    }
    socket.emit('lobby:rename', { lobbyId: state.lobbyId, name: trimmed });
  }

  function handleUserJoined(data) {
    // Use full users list from server if available, otherwise add single user
    if (data.users) {
      state.listeners = data.users;
    } else {
      state.listeners.push(data.user);
    }
    updateListeners();
    // Don't show join notification to the user who just joined
    if (data.user.socketId === socket.id) return;
    const joinDisplay = data.user.emoji ? `${data.user.emoji} ${data.user.username}` : data.user.username;
    showToast(`${joinDisplay} joined`, 'success');
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

  function handlePlaylistConfirm(data) {
    showPlaylistDialog(data);
  }

  function showPlaylistDialog(data) {
    // Remove any existing dialog or loading indicator
    const existing = document.getElementById('playlist-dialog');
    if (existing) existing.remove();
    const loadingEl = document.getElementById('playlist-loading');
    if (loadingEl) loadingEl.remove();

    const items = data.items || [];
    const hasSongMeta = data.songMeta && data.songMeta.title;

    // Build song list HTML
    const songListHtml = items.map((item, i) => `
      <label class="playlist-song-item" data-index="${i}" data-title="${escapeHtml(item.title).toLowerCase()}">
        <input type="checkbox" checked data-song-index="${i}">
        <span class="playlist-song-title">${escapeHtml(item.title)}</span>
        <span class="playlist-song-duration">${formatDuration(item.duration)}</span>
      </label>
    `).join('');

    const dialog = document.createElement('div');
    dialog.id = 'playlist-dialog';
    dialog.className = 'playlist-dialog-overlay';
    dialog.innerHTML = `
      <div class="playlist-dialog playlist-dialog-selection">
        <div class="playlist-dialog-header">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
          <h3>${escapeHtml(data.playlistTitle)}</h3>
        </div>
        <div class="playlist-selection-controls">
          <input type="text" id="playlist-search" class="playlist-search-input" placeholder="Search songs...">
          <div class="playlist-select-actions">
            <button class="btn btn-small" id="playlist-select-all">All</button>
            <button class="btn btn-small" id="playlist-select-none">None</button>
            <span class="playlist-selected-count" id="playlist-selected-count">${items.length} / ${items.length}</span>
          </div>
        </div>
        <div class="playlist-song-list" id="playlist-song-list">
          ${songListHtml}
        </div>
        <div class="playlist-dialog-actions">
          <button class="btn btn-primary playlist-dialog-btn" id="playlist-add-selected">
            Add selected songs
          </button>
          ${hasSongMeta ? `<button class="btn btn-secondary playlist-dialog-btn playlist-dialog-option" id="playlist-add-single">
            Add this song only
            <div class="playlist-dialog-option-detail">${escapeHtml(data.songMeta.title)} &middot; ${formatDuration(data.songMeta.duration)}</div>
          </button>` : ''}
          <button class="btn btn-secondary playlist-dialog-btn playlist-dialog-cancel" id="playlist-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const songList = document.getElementById('playlist-song-list');
    const searchInput = document.getElementById('playlist-search');
    const countEl = document.getElementById('playlist-selected-count');

    function updateCount() {
      const checked = songList.querySelectorAll('input[type="checkbox"]:checked').length;
      countEl.textContent = `${checked} / ${items.length}`;
    }

    // Search filter
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase();
      songList.querySelectorAll('.playlist-song-item').forEach(el => {
        el.style.display = el.dataset.title.includes(query) ? '' : 'none';
      });
    });

    // Select all/none
    document.getElementById('playlist-select-all').addEventListener('click', () => {
      songList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
      updateCount();
    });

    document.getElementById('playlist-select-none').addEventListener('click', () => {
      songList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      updateCount();
    });

    // Update count on checkbox change
    songList.addEventListener('change', updateCount);

    // Add selected
    document.getElementById('playlist-add-selected').addEventListener('click', () => {
      const selectedIndices = [];
      songList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        selectedIndices.push(parseInt(cb.dataset.songIndex, 10));
      });
      if (selectedIndices.length === 0) return;
      dialog.remove();
      socket.emit('queue:playlist-add', {
        lobbyId: data.lobbyId,
        url: data.url,
        mode: 'all',
        selectedIndices,
        addedBy: data.addedBy
      });
    });

    // Add single song (if URL had a video ID)
    const singleBtn = document.getElementById('playlist-add-single');
    if (singleBtn) {
      singleBtn.addEventListener('click', () => {
        dialog.remove();
        socket.emit('queue:playlist-add', {
          lobbyId: data.lobbyId,
          url: data.url,
          mode: 'single',
          addedBy: data.addedBy
        });
      });
    }

    document.getElementById('playlist-cancel').addEventListener('click', () => {
      dialog.remove();
    });

    // Close on overlay click
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        dialog.remove();
      }
    });
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
    updateListeners();
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
      storageSet(STORAGE_KEYS.REPEAT_MODE, data.repeatMode);
      updatePlaybackModeUI();
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
        updateQueue();
        updateListeners();

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
    updateListeners();

    if (data.audioUrl) {
      playAudioWithUnlock(data.audioUrl, 0, true);
    }
  }

  function handleShuffleState(data) {
    state.isShuffleEnabled = data.shuffleEnabled;
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(data.shuffleEnabled));
    updatePlaybackModeUI();
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
    // In independent mode, re-render queue to show who's listening to each song
    if (state.listeningMode === 'independent') {
      updateQueue();
    }
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
  function cycleRepeatMode() {
    const cycle = { 'off': 'all', 'all': 'one', 'one': 'off' };
    const newRepeat = cycle[state.repeatMode] || 'off';

    if (state.listeningMode === 'independent') {
      state.repeatMode = newRepeat;
      storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
      updatePlaybackModeUI();
      return;
    }

    // Synchronized mode: emit to server
    socket.emit('playback:setRepeat', { lobbyId: state.lobbyId, mode: newRepeat });

    // Update local state immediately for responsiveness
    state.repeatMode = newRepeat;
    storageSet(STORAGE_KEYS.REPEAT_MODE, newRepeat);
    updatePlaybackModeUI();
  }

  function toggleShuffle() {
    const newShuffle = !state.isShuffleEnabled;

    if (state.listeningMode === 'independent') {
      state.isShuffleEnabled = newShuffle;
      storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(newShuffle));
      updatePlaybackModeUI();
      return;
    }

    // Synchronized mode: emit to server
    socket.emit('playback:shuffle', {
      lobbyId: state.lobbyId,
      enabled: newShuffle,
      queueLength: state.queue.length
    });

    // Update local state immediately for responsiveness
    state.isShuffleEnabled = newShuffle;
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(newShuffle));
    updatePlaybackModeUI();
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
      // If more than 3 seconds in, restart current track; otherwise go to previous
      const audio = elements.audioPlayer;
      if (audio.currentTime > 3) {
        audio.currentTime = 0;
        if (audio.paused) {
          playAudioWithUnlock(audio.src, 0, true);
        }
        return;
      }
      // Go to previous track in queue
      if (state.queue.length === 0) return;
      const currentIndex = state.currentTrack
        ? state.queue.findIndex(s => s.id === state.currentTrack.id)
        : -1;
      let prevIndex = currentIndex - 1;
      if (prevIndex < 0) {
        if (state.repeatMode === 'all') {
          prevIndex = state.queue.length - 1;
        } else {
          // At the beginning, just restart current track
          if (audio.src) {
            audio.currentTime = 0;
            if (audio.paused) {
              playAudioWithUnlock(audio.src, 0, true);
            }
          }
          return;
        }
      }
      playLocalTrack(state.queue[prevIndex]);
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
    updateListeners();
    const streamUrl = `/api/stream?q=${encodeURIComponent(track.url)}`;
    playAudioWithUnlock(streamUrl, 0, true);

    // Report now-playing to server for listener display
    if (state.listeningMode === 'independent' && state.lobbyId) {
      socket.emit('listener:now-playing', {
        lobbyId: state.lobbyId,
        track: { title: track.title, thumbnail: track.thumbnail }
      });
    }
  }

  // Independent mode: advance to next track in queue
  function advanceLocalQueue() {
    if (state.queue.length === 0) return;

    const currentIndex = state.currentTrack
      ? state.queue.findIndex(s => s.id === state.currentTrack.id)
      : -1;

    if (state.repeatMode === 'one' && currentIndex >= 0) {
      playLocalTrack(state.queue[currentIndex]);
      return;
    }

    if (state.isShuffleEnabled && state.queue.length > 1) {
      // Pick a random track different from current
      let randomIndex;
      do {
        randomIndex = Math.floor(Math.random() * state.queue.length);
      } while (randomIndex === currentIndex && state.queue.length > 1);
      playLocalTrack(state.queue[randomIndex]);
      return;
    }

    let nextIndex = currentIndex + 1;
    if (nextIndex >= state.queue.length) {
      if (state.repeatMode === 'all') {
        nextIndex = 0;
      } else {
        elements.audioPlayer.pause();
        state.isPlaying = false;
        updatePlayButton();
        return;
      }
    }

    playLocalTrack(state.queue[nextIndex]);
  }

  // Queue Management
  function isPlaylistUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.has('list');
    } catch {
      return false;
    }
  }

  function showPlaylistLoading() {
    // Remove any existing loading indicator
    const existing = document.getElementById('playlist-loading');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'playlist-loading';
    overlay.className = 'playlist-dialog-overlay';
    overlay.innerHTML = `
      <div class="playlist-dialog playlist-loading-dialog">
        <div class="playlist-loading-spinner"></div>
        <div class="playlist-loading-text">Fetching playlist info...</div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function addSong() {
    const input = elements.songInput.value.trim();
    if (!input) return;

    // Show immediate loading feedback for playlist URLs
    if (isPlaylistUrl(input)) {
      showPlaylistLoading();
    }

    socket.emit('queue:add', {
      lobbyId: state.lobbyId,
      query: input,
      addedBy: state.username
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
    if (index <= 0) return;
    const song = state.queue[index];
    if (!song) return;
    socket.emit('queue:reorder', {
      lobbyId: state.lobbyId,
      songId: song.id,
      newIndex: index - 1
    });
  }

  function moveSongDown(index) {
    if (index >= state.queue.length - 1) return;
    const song = state.queue[index];
    if (!song) return;
    socket.emit('queue:reorder', {
      lobbyId: state.lobbyId,
      songId: song.id,
      newIndex: index + 1
    });
  }

  function playSongAt(index) {
    const song = state.queue[index];
    if (!song) return;

    if (state.listeningMode === 'independent') {
      playLocalTrack(song);
      return;
    }

    // Synchronized mode
    if (index === 0) {
      // Already playing - restart from beginning
      socket.emit('playback:seek', { lobbyId: state.lobbyId, position: 0 });
      return;
    }
    // Move song to next-up position then skip to it
    if (index !== 1) {
      socket.emit('queue:reorder', {
        lobbyId: state.lobbyId,
        songId: song.id,
        newIndex: 1
      });
    }
    socket.emit('playback:next', { lobbyId: state.lobbyId });
  }

  // Drag and drop reordering for queue
  function setupQueueDragAndDrop() {
    const list = elements.queueList;
    let draggedIndex = -1;

    list.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.queue-item');
      if (!item) {
        e.preventDefault();
        return;
      }
      draggedIndex = parseInt(item.dataset.index, 10);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedIndex));
      // Use a slight delay so the dragging class applies to the ghost image
      requestAnimationFrame(() => item.classList.add('dragging'));
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.queue-item');
      if (!item || parseInt(item.dataset.index, 10) === draggedIndex) return;

      // Remove existing indicators
      list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        item.classList.add('drag-over-top');
      } else {
        item.classList.add('drag-over-bottom');
      }
    });

    list.addEventListener('dragleave', (e) => {
      const item = e.target.closest('.queue-item');
      if (item) {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      }
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.querySelectorAll('.drag-over-top, .drag-over-bottom, .dragging').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
      });

      const targetItem = e.target.closest('.queue-item');
      if (!targetItem) return;

      const targetIndex = parseInt(targetItem.dataset.index, 10);
      if (targetIndex === draggedIndex) return;

      // Determine insertion point based on cursor position
      const rect = targetItem.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      // insertionPoint = position in original array where item should end up
      let insertionPoint = e.clientY < midY ? targetIndex : targetIndex + 1;

      // Calculate newIndex accounting for removal of dragged item
      let newIndex;
      if (draggedIndex < insertionPoint) {
        newIndex = insertionPoint - 1;
      } else {
        newIndex = insertionPoint;
      }

      if (newIndex !== draggedIndex && newIndex >= 0) {
        const song = state.queue[draggedIndex];
        if (song) {
          socket.emit('queue:reorder', {
            lobbyId: state.lobbyId,
            songId: song.id,
            newIndex: newIndex
          });
        }
      }
      draggedIndex = -1;
    });

    list.addEventListener('dragend', () => {
      list.querySelectorAll('.drag-over-top, .drag-over-bottom, .dragging').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
      });
      draggedIndex = -1;
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

    // Update lock screen / notification media controls
    if (window.MediaSessionManager) {
      MediaSessionManager.updateTrack({
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail,
        songId: track.id
      });
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

  function updatePlaybackModeUI() {
    // Update repeat button icon and state
    const repeatBtn = elements.repeatBtn;
    const repeatActive = state.repeatMode !== 'off';
    repeatBtn.classList.toggle('active', repeatActive);

    if (state.repeatMode === 'all') {
      repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
      repeatBtn.setAttribute('aria-label', 'Repeat all');
      repeatBtn.setAttribute('title', 'Repeat all');
    } else if (state.repeatMode === 'one') {
      repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">1</text></svg>';
      repeatBtn.setAttribute('aria-label', 'Repeat one');
      repeatBtn.setAttribute('title', 'Repeat one');
    } else {
      repeatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M8 8h8v8H8z"/></svg>';
      repeatBtn.setAttribute('aria-label', 'Repeat off');
      repeatBtn.setAttribute('title', 'Repeat off');
    }

    // Update shuffle button state
    const shuffleBtn = elements.shuffleBtn;
    shuffleBtn.classList.toggle('active', state.isShuffleEnabled);
    shuffleBtn.setAttribute('aria-label', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
    shuffleBtn.setAttribute('title', state.isShuffleEnabled ? 'Shuffle on' : 'Shuffle off');
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
          <p>${t('queue.empty', 'Queue is empty')}</p>
          <p class="hint">${t('queue.emptyHint', 'Add a song to get started')}</p>
        </li>
      `;
      return;
    }

    // Build list of songs with their original indices for action callbacks
    const songsWithIndices = state.queue.map((song, index) => ({ song, index }));
    let visibleSongs = state.hideErroredSongs
      ? songsWithIndices.filter(({ song }) => {
          const downloadInfo = state.downloadStatus[song.url];
          return !downloadInfo || downloadInfo.status !== 'error';
        })
      : [...songsWithIndices];

    // Apply sort order
    if (state.queueSort === 'newest') {
      visibleSongs.sort((a, b) => (b.song.addedAt || 0) - (a.song.addedAt || 0));
    } else if (state.queueSort === 'oldest') {
      visibleSongs.sort((a, b) => (a.song.addedAt || 0) - (b.song.addedAt || 0));
    }

    if (visibleSongs.length === 0) {
      elements.queueList.innerHTML = `
        <li class="queue-empty">
          <p>All songs have errors</p>
          <p class="hint">Uncheck "Hide errored songs" to see them</p>
        </li>
      `;
      return;
    }

    elements.queueList.innerHTML = visibleSongs.map(({ song, index }) => {
      const thumbUrl = song.id ? getCoverUrl(song.id, song.thumbnail) : sanitizeUrl(song.thumbnail);
      const downloadInfo = state.downloadStatus[song.url];
      const downloadHtml = getDownloadStatusHtml(downloadInfo, song.url);
      const isPlaying = state.currentTrack && state.currentTrack.id === song.id;
      const canMoveUp = index > 0;
      const canMoveDown = index < state.queue.length - 1;
      const listenersHtml = getQueueListenersHtml(song.title);

      return `
      <li class="queue-item ${isPlaying ? 'playing' : ''}" data-index="${index}" data-url="${escapeHtml(song.url)}" draggable="true">
        <div class="queue-item-drag-handle" title="Drag to reorder">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </div>
        <div class="queue-item-thumb">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}
          ${downloadHtml.icon}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(song.title)}</div>
          <div class="queue-item-meta">
            <span class="queue-item-duration">${song.duration ? formatDuration(song.duration) : ''}</span>
            ${song.addedBy ? `<span class="queue-item-added-by">${escapeHtml(song.addedBy)}</span>` : ''}
            ${downloadHtml.badge}
          </div>
          ${downloadHtml.progressBar}
        </div>
        ${listenersHtml}
        <div class="queue-item-actions">
          <div class="queue-item-reorder">
            <button class="btn-icon-small queue-item-up" aria-label="Move up" onclick="window.app.moveSongUp(${index})" ${!canMoveUp ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
            </button>
            <button class="btn-icon-small queue-item-down" aria-label="Move down" onclick="window.app.moveSongDown(${index})" ${!canMoveDown ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
            </button>
          </div>
          <button class="btn-icon queue-item-play" aria-label="Play" onclick="window.app.playSongAt(${index})">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
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
    const listenerWord = state.listeners.length !== 1
      ? t('lobby.listeners', 'listeners')
      : t('lobby.listener', 'listener');
    elements.userCount.textContent = `${state.listeners.length} ${listenerWord}`;

    if (state.listeners.length === 0) {
      elements.listenersList.innerHTML = `
        <li class="listener-empty">
          <p>${t('listeners.noListeners', 'No one else is here yet')}</p>
          <p class="hint">${t('listeners.shareHint', 'Share the lobby link to invite friends')}</p>
        </li>
      `;
      return;
    }

    elements.listenersList.innerHTML = state.listeners.map(user => {
      const modeIcon = user.mode === 'lobby'
        ? '<svg class="mode-icon lobby" viewBox="0 0 24 24" fill="currentColor" title="Lobby mode"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'
        : '<svg class="mode-icon listening" viewBox="0 0 24 24" fill="currentColor" title="Listening"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg>';
      const avatar = user.emoji || getInitials(user.username);

      // Determine what this user is currently listening to
      let nowListening = '';
      if (user.mode === 'listening') {
        // For synchronized mode, all listening users hear the same track
        // For independent mode, use per-user currentTrack from backend
        const track = (state.listeningMode === 'independent')
          ? user.currentTrack
          : state.currentTrack;
        if (track && track.title) {
          nowListening = `<span class="listener-track">${escapeHtml(track.title)}</span>`;
        }
      }

      return `
      <li class="listener-item ${user.mode === 'lobby' ? 'lobby-mode' : ''}">
        <div class="listener-avatar${user.emoji ? ' emoji' : ''}">${avatar}</div>
        <div class="listener-info">
          <span class="listener-name">${escapeHtml(user.username)}</span>
          ${nowListening}
        </div>
        ${modeIcon}
        ${user.isHost ? '<span class="listener-badge">Host</span>' : ''}
      </li>`;
    }).join('');
  }

  function resetLobbyUI() {
    elements.trackTitle.textContent = t('player.noTrackPlaying', 'No track playing');
    elements.trackArtist.textContent = t('player.addSongHint', 'Add a song to get started');
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
    updatePlaybackModeUI();
    updateModeButton();
    updateQueue();
    updateListeners();
  }

  // ==========================================
  // Chat
  // ==========================================

  // Recent ticker messages for marquee
  let tickerMessages = [];
  const MAX_TICKER_MESSAGES = 4;

  function sendChatMessage() {
    if (!elements.chatInput || !socket || !state.lobbyId) return;
    const content = elements.chatInput.value.trim();
    if (!content) return;

    socket.emit('chat:send', {
      lobbyId: state.lobbyId,
      userId: state.userId,
      username: state.username,
      emoji: state.emoji,
      content
    });

    elements.chatInput.value = '';
  }

  function handleChatMessage(msg) {
    appendChatMessage(msg);
    updateTicker(msg);
  }

  function handleChatHistory(data) {
    if (!elements.chatMessages) return;

    if (!data.messages || data.messages.length === 0) {
      elements.chatMessages.innerHTML = `
        <div class="chat-empty">
          <p>No messages yet</p>
          <p class="hint">Be the first to say something!</p>
        </div>`;
      return;
    }

    elements.chatMessages.innerHTML = '';
    data.messages.forEach(msg => appendChatMessage(msg));

    // Seed ticker with last few messages
    tickerMessages = data.messages.slice(-MAX_TICKER_MESSAGES);
    renderTicker();
  }

  function appendChatMessage(msg) {
    if (!elements.chatMessages) return;

    // Remove empty placeholder
    const empty = elements.chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'chat-msg';

    const time = new Date(msg.timestamp);
    const timeStr = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');

    div.innerHTML = `
      <div class="chat-msg-avatar">${msg.emoji || getInitials(msg.username)}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-header">
          <span class="chat-msg-user">${escapeHtml(msg.username)}</span>
          <span class="chat-msg-time">${timeStr}</span>
        </div>
        <div class="chat-msg-text">${escapeHtml(msg.content)}</div>
      </div>
    `;

    elements.chatMessages.appendChild(div);

    // Auto-scroll to bottom
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  function updateTicker(msg) {
    tickerMessages.push(msg);
    if (tickerMessages.length > MAX_TICKER_MESSAGES) {
      tickerMessages.shift();
    }
    renderTicker();
  }

  function renderTicker() {
    if (!elements.chatTicker || !elements.chatTickerContent) return;

    if (tickerMessages.length === 0) {
      elements.chatTicker.hidden = true;
      return;
    }

    elements.chatTicker.hidden = false;
    elements.chatTickerContent.innerHTML = tickerMessages.map(msg =>
      `<span class="ticker-msg"><span class="ticker-user">${escapeHtml(msg.username)}</span>: ${escapeHtml(msg.content)}</span>`
    ).join('');

    // Set animation duration based on content width for consistent scroll speed
    const contentWidth = elements.chatTickerContent.scrollWidth;
    const speed = 50; // pixels per second
    const duration = contentWidth / speed;
    elements.chatTickerContent.style.animationDuration = duration + 's';
  }

  function requestChatHistory() {
    if (socket && state.lobbyId) {
      socket.emit('chat:history', { lobbyId: state.lobbyId });
    }
  }

  function resetChat() {
    tickerMessages = [];
    if (elements.chatMessages) {
      elements.chatMessages.innerHTML = `
        <div class="chat-empty">
          <p>No messages yet</p>
          <p class="hint">Be the first to say something!</p>
        </div>`;
    }
    if (elements.chatTicker) elements.chatTicker.hidden = true;
    if (elements.chatTickerContent) elements.chatTickerContent.innerHTML = '';
  }

  // Tab Navigation
  function switchTab(tabName) {
    elements.navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });

    elements.queueTab.classList.toggle('active', tabName === 'queue');
    if (elements.socialTab) elements.socialTab.classList.toggle('active', tabName === 'social');

    // Auto-focus chat input when switching to social tab
    if (tabName === 'social' && elements.chatInput) {
      setTimeout(() => elements.chatInput.focus(), 100);
    }
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

  // Get listeners currently listening to a specific song (for Independent mode)
  function getListenersForSong(songTitle) {
    if (state.listeningMode !== 'independent') return [];
    return state.listeners.filter(user =>
      user.mode === 'listening' &&
      user.currentTrack &&
      user.currentTrack.title === songTitle
    );
  }

  // Generate HTML for listener avatars on a queue item
  function getQueueListenersHtml(songTitle) {
    const listeners = getListenersForSong(songTitle);
    if (listeners.length === 0) return '';

    const maxVisible = 3;
    const visible = listeners.slice(0, maxVisible);
    const overflow = listeners.length - maxVisible;

    const avatars = visible.map(user => {
      const avatar = user.emoji || getInitials(user.username);
      const hasEmoji = !!user.emoji;
      return `<div class="queue-listener-avatar${hasEmoji ? ' emoji' : ''}" title="${escapeHtml(user.username)}">${avatar}</div>`;
    }).join('');

    const overflowBadge = overflow > 0
      ? `<div class="queue-listener-avatar overflow" title="${overflow} more">+${overflow}</div>`
      : '';

    return `<div class="queue-item-listeners">${avatars}${overflowBadge}</div>`;
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(t('toast.linkCopied', 'Link copied to clipboard!'), 'success');
    }).catch(() => {
      showToast(t('toast.copyFailed', 'Could not copy link'), 'error');
    });
  }

  // Helper function to get translations with fallback
  function t(key, fallback, replacements = {}) {
    if (window.i18n && window.i18n.t) {
      const translation = window.i18n.t(key, replacements);
      // If translation returns the key itself, use fallback
      return translation === key ? fallback : translation;
    }
    return fallback;
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
  // Active Lobbies
  // ==========================================

  function fetchLobbies() {
    fetch('/api/lobbies')
      .then(res => res.json())
      .then(data => {
        renderLobbies(data.lobbies || []);
      })
      .catch(() => {
        // Silently handle fetch errors
      });
  }

  function renderLobbies(lobbies) {
    if (!elements.lobbiesSection || !elements.lobbiesList) return;

    if (lobbies.length === 0) {
      elements.lobbiesSection.hidden = true;
      return;
    }

    elements.lobbiesSection.hidden = false;
    elements.lobbiesList.innerHTML = lobbies.map(l => {
      const modeLabel = l.listeningMode === 'independent' ? 'Independent' : 'Synchronized';
      const modeClass = l.listeningMode === 'independent' ? 'independent' : 'synchronized';
      const age = formatAge(l.createdAt);
      const displayName = l.name ? escapeHtml(l.name) : escapeHtml(l.id);
      const pinIcon = l.pinned ? '<svg class="pin-indicator" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : '';

      return `
        <li class="lobby-card" onclick="window.app.joinLobbyFromCard('${escapeHtml(l.id)}')">
          <div class="lobby-card-header">
            <span class="lobby-card-id">${pinIcon}${displayName}</span>
            <span class="listening-mode-badge ${modeClass}">${modeLabel}</span>
          </div>
          <div class="lobby-card-stats">
            <span class="lobby-card-stat">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              ${l.userCount}
            </span>
            <span class="lobby-card-stat">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              ${l.songCount}
            </span>
            <span class="lobby-card-age">${age}</span>
          </div>
        </li>
      `;
    }).join('');
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

    fetch(`/api/playlists/${playlistId}?userId=${encodeURIComponent(state.userId)}`, {
      method: 'DELETE'
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
    if (elements.soloTrackTitle) elements.soloTrackTitle.textContent = t('player.noTrackPlaying', 'No track playing');
    if (elements.soloTrackArtist) elements.soloTrackArtist.textContent = t('player.addSongHint', 'Add a song to get started');
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
      elements.soloQueueList.innerHTML = `<li class="queue-empty"><p>${t('solo.playlistEmpty', 'Playlist is empty')}</p><p class="hint">${t('player.addSongHint', 'Add a song to get started')}</p></li>`;
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
          <button class="btn-icon queue-item-play" aria-label="Play" onclick="window.app.soloPlayTrack(${index})">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
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

  function joinLobbyFromCard(lobbyId) {
    window.history.pushState({ lobbyId }, '', `/lobby/${lobbyId}`);
    state.lobbyId = lobbyId;
    joinLobby(lobbyId);
  }

  // Expose API for inline handlers
  window.app = {
    removeSong,
    moveSongUp,
    moveSongDown,
    playSongAt,
    openPlaylist,
    deletePlaylist: deletePlaylistAction,
    soloPlayTrack: soloPlayTrack,
    soloRemoveSong: soloRemoveSong,
    joinLobbyFromCard
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
