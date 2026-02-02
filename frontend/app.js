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
    pendingPlay: null
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
    dashboardLobbyList: document.getElementById('dashboard-lobby-list')
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
    fetchVersion();
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
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Create Lobby
    elements.createLobbyBtn.addEventListener('click', createLobby);

    // Leave Lobby
    elements.backBtn.addEventListener('click', leaveLobby);

    // Share Lobby
    elements.shareBtn.addEventListener('click', shareLobby);

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
    } else if (viewName === 'lobby') {
      elements.lobbyView.classList.add('active');
    } else if (viewName === 'dashboard' && elements.dashboardView) {
      elements.dashboardView.classList.add('active');
      fetchDashboardStats();
      dashboardInterval = setInterval(fetchDashboardStats, 2000);
    }
  }

  // Lobby Actions
  function createLobby() {
    elements.createLobbyBtn.disabled = true;
    elements.createLobbyBtn.textContent = 'Creating...';
    socket.emit('lobby:create', { username: state.username });
  }

  function joinLobby(lobbyId) {
    socket.emit('lobby:join', { lobbyId, username: state.username });
  }

  function leaveLobby() {
    socket.emit('lobby:leave', { lobbyId: state.lobbyId });
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

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);

    elements.createLobbyBtn.disabled = false;
    elements.createLobbyBtn.textContent = 'Create Lobby';

    window.history.pushState({ lobbyId: data.lobbyId }, '', `/lobby/${data.lobbyId}`);
    elements.lobbyName.textContent = `Lobby ${data.lobbyId}`;

    showView('lobby');
    showToast('Lobby created! Share the link to invite friends.', 'success');
  }

  function handleLobbyJoined(data) {
    state.lobbyId = data.lobbyId;
    state.isHost = data.isHost || false;
    state.queue = data.queue || [];
    // Handle both 'listeners' and 'users' from backend
    state.listeners = data.listeners || data.users || [];
    state.currentTrack = data.currentTrack || null;

    // Save lobby to localStorage for future rejoin
    storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
    // Hide rejoin prompt if it was showing
    hideRejoinPrompt();

    elements.lobbyName.textContent = `Lobby ${data.lobbyId}`;

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
    const audio = elements.audioPlayer;
    const serverPosition = data.position || 0;

    // Update repeat mode if provided
    if (data.repeatMode !== undefined && data.repeatMode !== state.repeatMode) {
      state.repeatMode = data.repeatMode;
      // Persist preference
      storageSet(STORAGE_KEYS.REPEAT_MODE, data.repeatMode);
      updateRepeatButton();
    }

    // If we have a track and it's different or audio has no src, set it up
    if (data.track && data.track.url) {
      const streamUrl = `/api/stream?q=${encodeURIComponent(data.track.url)}`;

      // Check if we need to change the source
      if (!audio.src || !audio.src.includes(encodeURIComponent(data.track.url))) {
        state.currentTrack = data.track;
        updateNowPlaying(data.track);

        if (data.isPlaying) {
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

    // Sync play/pause state
    if (data.isPlaying && audio.paused) {
      playAudioWithUnlock(audio.src, audio.currentTime, true);
    } else if (!data.isPlaying && !audio.paused) {
      audio.pause();
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
    socket.emit('playback:toggle', { lobbyId: state.lobbyId });
  }

  function playPrevious() {
    socket.emit('playback:previous', { lobbyId: state.lobbyId });
  }

  function playNext() {
    socket.emit('playback:next', { lobbyId: state.lobbyId });
  }

  function cycleRepeatMode() {
    const modes = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(state.repeatMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];
    socket.emit('playback:setRepeat', { lobbyId: state.lobbyId, mode: nextMode });
  }

  function seekTo() {
    const percent = elements.progressBar.value;
    const duration = elements.audioPlayer.duration;
    if (duration) {
      const position = (percent / 100) * duration;
      socket.emit('playback:seek', { lobbyId: state.lobbyId, position });
    }
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
    socket.emit('queue:remove', {
      lobbyId: state.lobbyId,
      index
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
      return `
      <li class="queue-item ${state.currentTrack && state.currentTrack.id === song.id ? 'playing' : ''}" data-index="${index}">
        <div class="queue-item-thumb">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(song.title)}</div>
          <div class="queue-item-duration">${song.duration || ''}</div>
        </div>
        <button class="btn-icon queue-item-remove" aria-label="Remove from queue" onclick="window.app.removeSong(${index})">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </li>`;
    }).join('');
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

    elements.listenersList.innerHTML = state.listeners.map(user => `
      <li class="listener-item">
        <div class="listener-avatar">${getInitials(user.username)}</div>
        <span class="listener-name">${escapeHtml(user.username)}</span>
        ${user.isHost ? '<span class="listener-badge">Host</span>' : ''}
      </li>
    `).join('');
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
    updatePlayButton();
    updateShuffleButton();
    updateRepeatButton();
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
    removeSong
  };
  window.dashboardJoinLobby = dashboardJoinLobby;
  window.dashboardRemoveLobby = dashboardRemoveLobby;

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
