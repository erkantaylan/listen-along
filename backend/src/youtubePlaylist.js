/**
 * Standalone shared YouTube playlist page.
 *
 * No yt-dlp, no downloading, no server-side fetches to YouTube at all —
 * clients just embed videos via YouTube's own iframe player, so the
 * yt-dlp IP-block problems on the main app never apply here. The server
 * only holds a single global in-memory list of {videoId, title, ...}
 * and broadcasts changes over a dedicated Socket.IO namespace.
 */

const crypto = require('crypto');

const MAX_SONGS = 500;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const NAMESPACE = '/youtube-playlist';

let songs = [];

function getSongs() {
  return songs;
}

function addSong({ videoId, title, thumbnail, addedBy }) {
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }
  const song = {
    id: crypto.randomUUID(),
    videoId,
    title: (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 200) : 'Untitled',
    thumbnail: (typeof thumbnail === 'string' && thumbnail.trim()) ? thumbnail.trim().slice(0, 500) : null,
    addedBy: (typeof addedBy === 'string' && addedBy.trim()) ? addedBy.trim().slice(0, 50) : 'Anonymous',
    addedAt: Date.now()
  };
  songs.push(song);
  if (songs.length > MAX_SONGS) {
    songs.shift();
  }
  return song;
}

function removeSong(id) {
  const index = songs.findIndex((s) => s.id === id);
  if (index === -1) return false;
  songs.splice(index, 1);
  return true;
}

function setupSocketHandlers(io) {
  io.of(NAMESPACE).on('connection', (socket) => {
    socket.emit('songs', getSongs());
  });
}

function broadcast(io, event, payload) {
  io.of(NAMESPACE).emit(event, payload);
}

module.exports = {
  getSongs,
  addSong,
  removeSong,
  setupSocketHandlers,
  broadcast
};
