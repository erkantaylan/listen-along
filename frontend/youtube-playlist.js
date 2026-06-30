(() => {
  const form = document.getElementById('yt-add-form');
  const urlInput = document.getElementById('yt-url-input');
  const nameInput = document.getElementById('yt-name-input');
  const addButton = document.getElementById('yt-add-button');
  const errorEl = document.getElementById('yt-add-error');
  const listEl = document.getElementById('yt-song-list');
  const emptyEl = document.getElementById('yt-empty-message');
  const player = document.getElementById('yt-player');
  const playerPlaceholder = document.getElementById('yt-player-placeholder');
  const nowPlayingEl = document.getElementById('yt-now-playing');

  const NAME_KEY = 'yt_playlist_name';
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  nameInput.addEventListener('change', () => {
    localStorage.setItem(NAME_KEY, nameInput.value.trim());
  });

  let songs = [];
  let playingId = null;

  function extractVideoId(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
      const match = url.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      if (match) return match[2];
    }
    return null;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  async function fetchMetadata(videoId) {
    const fallback = {
      title: 'YouTube video',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
    try {
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
      if (!res.ok) return fallback;
      const data = await res.json();
      return {
        title: data.title || fallback.title,
        thumbnail: data.thumbnail_url || fallback.thumbnail
      };
    } catch {
      return fallback;
    }
  }

  function setError(message) {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function renderList() {
    emptyEl.hidden = songs.length > 0;
    listEl.innerHTML = songs.map((song) => {
      const isPlaying = song.id === playingId;
      const thumb = song.thumbnail || `https://img.youtube.com/vi/${song.videoId}/hqdefault.jpg`;
      return `
        <li class="yt-song-item ${isPlaying ? 'is-playing' : ''}" data-id="${escapeHtml(song.id)}">
          <img class="yt-song-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">
          <div class="yt-song-info">
            <div class="yt-song-title">${escapeHtml(song.title)}</div>
            <div class="yt-song-meta">added by ${escapeHtml(song.addedBy)}</div>
          </div>
          <div class="yt-song-actions">
            <button type="button" data-action="play">Play</button>
            <button type="button" data-action="remove">Remove</button>
          </div>
        </li>
      `;
    }).join('');
  }

  function playSong(song) {
    playingId = song.id;
    playerPlaceholder.hidden = true;
    player.src = `https://www.youtube.com/embed/${song.videoId}?autoplay=1&rel=0`;
    nowPlayingEl.textContent = `Now playing: ${song.title}`;
    renderList();
  }

  listEl.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const li = button.closest('.yt-song-item');
    const id = li.dataset.id;
    const song = songs.find((s) => s.id === id);
    if (!song) return;

    if (button.dataset.action === 'play') {
      playSong(song);
    } else if (button.dataset.action === 'remove') {
      try {
        await fetch(`/api/youtube-playlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch {
        // socket update or next refresh will reconcile state
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(null);

    const videoId = extractVideoId(urlInput.value);
    if (!videoId) {
      setError('That doesn\'t look like a YouTube video link. Paste a single video URL (not a playlist link).');
      return;
    }

    addButton.disabled = true;
    try {
      const { title, thumbnail } = await fetchMetadata(videoId);
      const addedBy = nameInput.value.trim();
      const res = await fetch('/api/youtube-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, title, thumbnail, addedBy })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not add that song.');
        return;
      }
      urlInput.value = '';
    } finally {
      addButton.disabled = false;
    }
  });

  const socket = io('/youtube-playlist');

  socket.on('songs', (initialSongs) => {
    songs = initialSongs || [];
    renderList();
  });

  socket.on('song:added', (song) => {
    songs.push(song);
    renderList();
  });

  socket.on('song:removed', ({ id }) => {
    songs = songs.filter((s) => s.id !== id);
    if (playingId === id) {
      playingId = null;
    }
    renderList();
  });

  renderList();
})();
