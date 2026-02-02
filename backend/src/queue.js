const { v4: uuidv4 } = require('uuid');

// In-memory storage: lobbyId -> Queue
const queues = new Map();

class Queue {
  constructor(lobbyId) {
    this.lobbyId = lobbyId;
    this.songs = [];
  }

  addSong({ url, title, duration, addedBy, thumbnail }) {
    const song = {
      id: uuidv4(),
      url,
      title: title || 'Unknown',
      duration: duration || 0,
      addedBy: addedBy || 'anonymous',
      thumbnail: thumbnail || null,
      addedAt: Date.now()
    };
    this.songs.push(song);
    return song;
  }

  removeSong(songId) {
    const index = this.songs.findIndex(s => s.id === songId);
    if (index === -1) return null;
    const [removed] = this.songs.splice(index, 1);
    return removed;
  }

  reorderSong(songId, newIndex) {
    const currentIndex = this.songs.findIndex(s => s.id === songId);
    if (currentIndex === -1) return false;
    if (newIndex < 0 || newIndex >= this.songs.length) return false;

    const [song] = this.songs.splice(currentIndex, 1);
    this.songs.splice(newIndex, 0, song);
    return true;
  }

  getSongs() {
    return [...this.songs];
  }

  getCurrentSong() {
    return this.songs[0] || null;
  }

  advanceQueue() {
    return this.songs.shift() || null;
  }

  /**
   * Move current song (first) to end of queue - for repeat-all mode
   */
  moveCurrentToEnd() {
    if (this.songs.length === 0) return null;
    const current = this.songs.shift();
    this.songs.push(current);
    return current;
  }

  clear() {
    this.songs = [];
  }
}

function getQueue(lobbyId) {
  if (!queues.has(lobbyId)) {
    queues.set(lobbyId, new Queue(lobbyId));
  }
  return queues.get(lobbyId);
}

function deleteQueue(lobbyId) {
  return queues.delete(lobbyId);
}

function hasQueue(lobbyId) {
  return queues.has(lobbyId);
}

module.exports = {
  Queue,
  getQueue,
  deleteQueue,
  hasQueue
};
