// Listen-Along Frontend Application
(function() {
  'use strict';

  // App State
  const state = {
    lobbyId: null,
    isHost: false,
    isPlaying: false,
    isShuffleEnabled: false,
    currentTrack: null,
    queue: [],
    listeners: [],
    userId: generateUserId(),
    username: generateUsername(),
    repeatMode: 'off' // 'off', 'all', 'one'
  };

  // DOM Elements
  const elements = {
    // Views
    landingView: document.getElementById('landing-view'),
    lobbyView: document.getElementById('lobby-view'),

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
    versionDisplay: document.getElementById('version-display')
  };

  // Socket.IO Connection
  let socket = null;

  // Initialize Application
  function init() {
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

  // Check URL for Lobby ID
  function checkUrlForLobby() {
    const path = window.location.pathname;
    const match = path.match(/^\/lobby\/([a-zA-Z0-9]+)$/);
    if (match) {
      state.lobbyId = match[1];
      joinLobby(state.lobbyId);
    }
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
      updatePlayButton();
    });

    audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updatePlayButton();
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
      showToast('Error playing audio', 'error');
    });
  }

  // View Management
  function showView(viewName) {
    elements.landingView.classList.remove('active');
    elements.lobbyView.classList.remove('active');

    if (viewName === 'landing') {
      elements.landingView.classList.add('active');
    } else if (viewName === 'lobby') {
      elements.lobbyView.classList.add('active');
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
      elements.audioPlayer.src = data.audioUrl;
      elements.audioPlayer.currentTime = data.position || 0;
      elements.audioPlayer.play().catch(e => console.log('Autoplay blocked:', e));
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
      updateRepeatButton();
    }

    // If we have a track and it's different or audio has no src, set it up
    if (data.track && data.track.url) {
      const streamUrl = `/api/stream?q=${encodeURIComponent(data.track.url)}`;

      // Check if we need to change the source
      if (!audio.src || !audio.src.includes(encodeURIComponent(data.track.url))) {
        state.currentTrack = data.track;
        updateNowPlaying(data.track);
        audio.src = streamUrl;
        audio.currentTime = serverPosition;

        if (data.isPlaying) {
          audio.play().catch(e => console.log('Autoplay blocked:', e));
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
      audio.play().catch(e => console.log('Autoplay blocked:', e));
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
      elements.audioPlayer.src = data.audioUrl;
      elements.audioPlayer.play().catch(e => console.log('Autoplay blocked:', e));
    }
  }

  function handleShuffleState(data) {
    state.isShuffleEnabled = data.shuffleEnabled;
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

    const thumbUrl = sanitizeUrl(track.thumbnail);
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
      const thumbUrl = sanitizeUrl(song.thumbnail);
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
  function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
  }

  function generateUsername() {
    const adjectives = ['Happy', 'Chill', 'Groovy', 'Funky', 'Cool', 'Mellow'];
    const nouns = ['Listener', 'DJ', 'Vibes', 'Beat', 'Rhythm', 'Sound'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj}${noun}${Math.floor(Math.random() * 100)}`;
  }

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

  // Expose API for inline handlers
  window.app = {
    removeSong
  };

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
