/**
 * Song download and caching system
 * Downloads songs in background and serves cached files for fast playback
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const db = require('./db');
const covers = require('./covers');
const { v4: uuidv4 } = require('uuid');
const ytdlp = require('./ytdlp');

// Event emitter for download progress
const downloadEvents = new EventEmitter();

// Track active downloads with their progress
const activeDownloads = new Map();

// Directory for cached songs
const SONGS_PATH = process.env.SONGS_PATH || '/data/songs';

// Ensure songs directory exists
function ensureSongsDir() {
  if (!fs.existsSync(SONGS_PATH)) {
    fs.mkdirSync(SONGS_PATH, { recursive: true });
    console.log(`Created songs directory: ${SONGS_PATH}`);
  }
}

/**
 * Get cached song by URL
 * @param {string} url - YouTube URL or search term
 * @returns {Promise<Object|null>} Song record or null if not cached
 */
async function getCachedSong(url) {
  if (!db.isAvailable()) return null;

  try {
    const result = await db.query(
      'SELECT * FROM songs WHERE url = $1',
      [url]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error fetching cached song:', err.message);
    return null;
  }
}

/**
 * Check if a cached file exists and is readable
 * @param {string} filePath - Path to the cached file
 * @returns {boolean}
 */
function isCachedFileValid(filePath) {
  if (!filePath) return false;
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 10240; // must be >10KB to be a real audio file
  } catch {
    return false;
  }
}

function validateAudioFile(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath
    ]);
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', (code) => resolve(code === 0 && stdout.trim() === 'audio'));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Create a read stream for a cached song
 * @param {string} filePath - Path to the cached file
 * @returns {Object} { stream, size }
 */
function createCachedStream(filePath) {
  const stats = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  return {
    stream,
    size: stats.size
  };
}

/**
 * Start background download of a song
 * @param {string} url - YouTube URL
 * @param {Object} metadata - Song metadata (title, duration, thumbnail)
 * @param {string} lobbyId - Optional lobby ID for progress events
 * @returns {Promise<string>} Song ID
 */
async function startDownload(url, metadata = {}, lobbyId = null) {
  if (!db.isAvailable()) {
    console.log('Database not available, skipping download');
    return null;
  }

  // Check if already downloading or cached
  const existing = await getCachedSong(url);
  if (existing) {
    if (existing.status === 'ready' && isCachedFileValid(existing.file_path)) {
      console.log(`Song already cached: ${url}`);
      // Emit ready status for already cached songs
      downloadEvents.emit('status', {
        url,
        songId: existing.id,
        status: 'ready',
        percent: 100,
        lobbyId
      });
      return existing.id;
    }
    if (existing.status === 'downloading') {
      console.log(`Song already downloading: ${url}`);
      return existing.id;
    }
    // If error or invalid file, re-download
    if (existing.status === 'error' || !isCachedFileValid(existing.file_path)) {
      await db.query('DELETE FROM songs WHERE id = $1', [existing.id]);
    }
  }

  ensureSongsDir();

  // Create song record
  const songId = uuidv4();
  const now = Date.now();

  try {
    await db.query(
      `INSERT INTO songs (id, url, title, duration, thumbnail_url, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)`,
      [songId, url, metadata.title || 'Unknown', metadata.duration || 0, metadata.thumbnail || null, now]
    );
  } catch (err) {
    console.error('Error creating song record:', err.message);
    return null;
  }

  // Emit pending status
  downloadEvents.emit('status', {
    url,
    songId,
    status: 'pending',
    percent: 0,
    lobbyId
  });

  // Start download - await if waitForComplete flag is set, otherwise background
  if (metadata.waitForComplete) {
    try {
      await downloadSong(songId, url, lobbyId);
    } catch (err) {
      console.error('Download failed for %s: %s', url, err.message);
    }
  } else {
    downloadSong(songId, url, lobbyId).catch(err => {
      console.error('Download failed for %s: %s', url, err.message);
    });
  }

  return songId;
}

/**
 * Download and transcode a song
 * @param {string} songId - Song ID in database
 * @param {string} url - YouTube URL
 * @param {string} lobbyId - Optional lobby ID for progress events
 */
async function downloadSong(songId, url, lobbyId = null) {
  const outputPath = path.join(SONGS_PATH, `${songId}.mp3`);

  // Track this download
  activeDownloads.set(url, { songId, status: 'downloading', percent: 0 });

  try {
    // Update status to downloading
    await db.query(
      'UPDATE songs SET status = $1, updated_at = $2 WHERE id = $3',
      ['downloading', Date.now(), songId]
    );

    // Emit downloading status
    downloadEvents.emit('status', {
      url,
      songId,
      status: 'downloading',
      percent: 0,
      lobbyId
    });

    console.log(`Starting download: ${url}`);

    await new Promise((resolve, reject) => {
      const isUrl = url.startsWith('http://') || url.startsWith('https://');
      const target = isUrl ? url : `ytsearch:${url}`;

      // yt-dlp outputs raw audio to stdout
      // player_client=web avoids SABR (Server ABR) format which breaks pipe mode
      const ytdlpProc = spawn('yt-dlp', [
        '-f', 'bestaudio',
        '-o', '-',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=web_safari,web',
        target
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // ffmpeg transcodes to mp3
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 'mp3',
        '-ab', '128k',
        '-y',
        outputPath
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Pipe yt-dlp output to ffmpeg input
      ytdlpProc.stdout.pipe(ffmpeg.stdin);

      let ytdlpError = '';
      let ffmpegError = '';
      let lastProgressEmit = 0;

      ytdlpProc.stderr.on('data', (data) => {
        const output = data.toString();
        ytdlpError += output;

        // Parse yt-dlp download progress (e.g., "[download]  50.0% of 5.00MiB")
        const progressMatch = output.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          const percent = Math.min(Math.round(parseFloat(progressMatch[1]) * 0.9), 90); // Cap at 90% during download
          const now = Date.now();
          // Throttle progress updates to every 500ms
          if (now - lastProgressEmit > 500) {
            lastProgressEmit = now;
            activeDownloads.set(url, { songId, status: 'downloading', percent });
            downloadEvents.emit('progress', {
              url,
              songId,
              status: 'downloading',
              percent,
              lobbyId
            });
          }
        }
      });

      ffmpeg.stderr.on('data', (data) => {
        ffmpegError += data.toString();
      });

      let ytdlpExitError = null;

      ytdlpProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          ytdlpExitError = ytdlp.parseError(ytdlpError, code);
          ffmpeg.stdin.end();
        } else {
          // yt-dlp finished, now transcoding (90-100%)
          activeDownloads.set(url, { songId, status: 'downloading', percent: 95 });
          downloadEvents.emit('progress', {
            url,
            songId,
            status: 'downloading',
            percent: 95,
            lobbyId
          });
        }
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          if (ytdlpError) console.error(`[yt-dlp stderr] ${ytdlpError.slice(-500)}`);
          reject(ytdlpExitError || new Error(`ffmpeg error (${code}): ${ffmpegError.slice(-300)}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });

      ytdlpProc.on('error', (err) => {
        reject(err);
      });
    });

    // Verify file was created and is a valid audio file
    if (!isCachedFileValid(outputPath)) {
      throw new Error('Download completed but file is invalid');
    }
    const audioValid = await validateAudioFile(outputPath);
    if (!audioValid) {
      fs.unlinkSync(outputPath);
      throw new Error('Download produced an unplayable file (corrupt or wrong format)');
    }

    // Update status to ready
    await db.query(
      'UPDATE songs SET status = $1, file_path = $2, updated_at = $3 WHERE id = $4',
      ['ready', outputPath, Date.now(), songId]
    );

    // Update tracking and emit complete
    activeDownloads.set(url, { songId, status: 'ready', percent: 100 });
    downloadEvents.emit('status', {
      url,
      songId,
      status: 'ready',
      percent: 100,
      lobbyId
    });

    console.log(`Download complete: ${url} -> ${outputPath}`);

  } catch (err) {
    // Update status to error
    await db.query(
      'UPDATE songs SET status = $1, error_message = $2, updated_at = $3 WHERE id = $4',
      ['error', err.message, Date.now(), songId]
    );

    // Update tracking and emit error
    activeDownloads.set(url, { songId, status: 'error', percent: 0 });
    downloadEvents.emit('status', {
      url,
      songId,
      status: 'error',
      error: err.message,
      lobbyId
    });

    // Clean up partial file
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    throw err;
  } finally {
    // Clean up tracking after a delay
    setTimeout(() => activeDownloads.delete(url), 60000);
  }
}

/**
 * Get all cached songs
 * @returns {Promise<Array>} Array of song records
 */
async function getAllSongs() {
  if (!db.isAvailable()) return [];

  try {
    const result = await db.query(`
      SELECT s.id, s.url, s.title, s.duration, s.file_path, s.thumbnail_url,
             s.status, s.error_message, s.created_at, s.updated_at,
             (SELECT COUNT(DISTINCT ps.playlist_id) FROM playlist_songs ps WHERE ps.url = s.url)::int AS playlist_count,
             (SELECT COUNT(DISTINCT qs.lobby_id) FROM queue_songs qs WHERE qs.url = s.url)::int AS queue_count
      FROM songs s
      ORDER BY s.updated_at DESC
    `);
    // Attach file size for each song that has a file on disk
    return result.rows.map(song => {
      if (song.file_path && fs.existsSync(song.file_path)) {
        try {
          song.file_size = fs.statSync(song.file_path).size;
        } catch { song.file_size = null; }
      } else {
        song.file_size = null;
      }
      return song;
    });
  } catch (err) {
    console.error('Error fetching all songs:', err.message);
    return [];
  }
}

/**
 * Delete a single cached song by ID
 * @param {string} songId - Song UUID
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
async function deleteSong(songId) {
  if (!db.isAvailable()) return false;

  try {
    // Get file path first
    const result = await db.query('SELECT file_path FROM songs WHERE id = $1', [songId]);
    if (result.rows.length === 0) return false;

    const filePath = result.rows[0].file_path;

    // Delete file if it exists
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete database record
    await db.query('DELETE FROM songs WHERE id = $1', [songId]);
    console.log(`Deleted cached song: ${songId}`);
    return true;
  } catch (err) {
    console.error('Error deleting song:', err.message);
    return false;
  }
}

/**
 * Delete all cached songs
 * @returns {Promise<number>} Number of songs deleted
 */
async function deleteAllSongs() {
  if (!db.isAvailable()) return 0;

  try {
    // Get all file paths
    const result = await db.query('SELECT id, file_path FROM songs');
    let deleted = 0;

    // Delete all files
    for (const song of result.rows) {
      if (song.file_path && fs.existsSync(song.file_path)) {
        try {
          fs.unlinkSync(song.file_path);
        } catch (err) {
          console.error(`Failed to delete file: ${song.file_path}`, err.message);
        }
      }
      deleted++;
    }

    // Delete all database records
    await db.query('DELETE FROM songs');
    console.log(`Deleted all ${deleted} cached songs`);
    return deleted;
  } catch (err) {
    console.error('Error deleting all songs:', err.message);
    return 0;
  }
}

/**
 * Delete all songs with error status
 * @returns {Promise<number>} Number of songs deleted
 */
async function deleteErrorSongs() {
  if (!db.isAvailable()) return 0;

  try {
    const result = await db.query("SELECT id, file_path FROM songs WHERE status = 'error'");
    let deleted = 0;

    for (const song of result.rows) {
      if (song.file_path && fs.existsSync(song.file_path)) {
        try {
          fs.unlinkSync(song.file_path);
        } catch (err) {
          console.error(`Failed to delete file: ${song.file_path}`, err.message);
        }
      }
      deleted++;
    }

    await db.query("DELETE FROM songs WHERE status = 'error'");
    console.log(`Deleted ${deleted} error songs`);
    return deleted;
  } catch (err) {
    console.error('Error deleting error songs:', err.message);
    return 0;
  }
}

/**
 * Delete orphaned cached songs (not in any queue or playlist)
 * @returns {Promise<number>} Number of songs deleted
 */
async function deleteOrphanedSongs() {
  if (!db.isAvailable()) return 0;

  try {
    const result = await db.query(`
      SELECT s.id, s.file_path FROM songs s
      WHERE s.url NOT IN (SELECT DISTINCT url FROM queue_songs)
        AND s.url NOT IN (SELECT DISTINCT url FROM playlist_songs)
    `);
    let deleted = 0;

    for (const song of result.rows) {
      if (song.file_path && fs.existsSync(song.file_path)) {
        try {
          fs.unlinkSync(song.file_path);
        } catch (err) {
          console.error(`Failed to delete file: ${song.file_path}`, err.message);
        }
      }
      deleted++;
    }

    if (result.rows.length > 0) {
      const ids = result.rows.map(r => r.id);
      await db.query(`DELETE FROM songs WHERE id = ANY($1::uuid[])`, [ids]);
    }
    console.log(`Deleted ${deleted} orphaned songs`);
    return deleted;
  } catch (err) {
    console.error('Error deleting orphaned songs:', err.message);
    return 0;
  }
}

/**
 * Delete files on disk that have no matching record in the songs DB table.
 * These accumulate when postgres is reset/restored while the songs volume persists.
 * @returns {Promise<{deleted: number, bytes: number}>}
 */
async function deleteUnregisteredFiles() {
  if (!db.isAvailable()) return { deleted: 0, bytes: 0 };

  try {
    const result = await db.query('SELECT file_path FROM songs WHERE file_path IS NOT NULL');
    const knownPaths = new Set(result.rows.map(r => r.file_path));

    if (!fs.existsSync(SONGS_PATH)) return { deleted: 0, bytes: 0 };

    const diskFiles = fs.readdirSync(SONGS_PATH);
    let deleted = 0;
    let bytes = 0;

    for (const file of diskFiles) {
      const fullPath = path.join(SONGS_PATH, file);
      if (!knownPaths.has(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            bytes += stat.size;
            fs.unlinkSync(fullPath);
            deleted++;
          }
        } catch {}
      }
    }

    console.log(`Deleted ${deleted} unregistered disk files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    return { deleted, bytes };
  } catch (err) {
    console.error('Error deleting unregistered files:', err.message);
    return { deleted: 0, bytes: 0 };
  }
}

/**
 * Clean up old cached songs (older than maxAge)
 * @param {number} maxAge - Maximum age in milliseconds (default 7 days)
 */
async function cleanupOldSongs(maxAge = 7 * 24 * 60 * 60 * 1000) {
  if (!db.isAvailable()) return;

  const cutoff = Date.now() - maxAge;

  try {
    const result = await db.query(
      'SELECT id, file_path FROM songs WHERE updated_at < $1',
      [cutoff]
    );

    for (const song of result.rows) {
      // Delete file
      if (song.file_path && fs.existsSync(song.file_path)) {
        try {
          fs.unlinkSync(song.file_path);
        } catch (err) {
          console.error(`Failed to delete cached file: ${song.file_path}`, err.message);
        }
      }

      // Delete database record
      await db.query('DELETE FROM songs WHERE id = $1', [song.id]);
    }

    if (result.rows.length > 0) {
      console.log(`Cleaned up ${result.rows.length} old cached songs`);
      // Clear cover cache to remove stale entries for deleted songs
      covers.clearCache();
    }
  } catch (err) {
    console.error('Error during cache cleanup:', err.message);
  }
}

module.exports = {
  getCachedSong,
  isCachedFileValid,
  createCachedStream,
  startDownload,
  getAllSongs,
  deleteSong,
  deleteAllSongs,
  deleteErrorSongs,
  deleteOrphanedSongs,
  deleteUnregisteredFiles,
  cleanupOldSongs,
  downloadEvents,
  SONGS_PATH
};
