const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const COVERS_DIR = process.env.COVERS_DIR || '/data/covers';

// In-memory cache: songId -> { path, contentType }
// Capped at MAX_COVER_CACHE_SIZE entries with LRU eviction
const MAX_COVER_CACHE_SIZE = 500;
const coverCache = new Map();

/**
 * Set a cache entry, evicting oldest entries if cache exceeds max size.
 * Deletes and re-inserts to move the key to the end (most recently used).
 */
function cacheSet(songId, value) {
  coverCache.delete(songId);
  coverCache.set(songId, value);
  while (coverCache.size > MAX_COVER_CACHE_SIZE) {
    const oldest = coverCache.keys().next().value;
    coverCache.delete(oldest);
  }
}

/**
 * Ensure the covers directory exists
 */
function ensureCoversDir() {
  if (!fs.existsSync(COVERS_DIR)) {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  }
}

/**
 * Get file extension from URL or content-type
 */
function getExtension(url, contentType) {
  if (contentType) {
    const typeMap = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif'
    };
    if (typeMap[contentType]) return typeMap[contentType];
  }

  // Try to extract from URL
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    return ext === '.jpeg' ? '.jpg' : ext;
  }

  return '.jpg'; // Default
}

/**
 * Download and cache a thumbnail image
 * @param {string} songId - Unique song identifier
 * @param {string} thumbnailUrl - URL to download from
 * @returns {Promise<string|null>} - Path to cached file or null on failure
 */
async function cacheCover(songId, thumbnailUrl) {
  if (!thumbnailUrl) return null;

  try {
    ensureCoversDir();

    return new Promise((resolve, reject) => {
      const protocol = thumbnailUrl.startsWith('https') ? https : http;

      const request = protocol.get(thumbnailUrl, { timeout: 10000 }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          cacheCover(songId, response.headers.location).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }

        const contentType = response.headers['content-type'] || '';
        const ext = getExtension(thumbnailUrl, contentType);
        const filename = `${songId}${ext}`;
        const filePath = path.join(COVERS_DIR, filename);

        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          cacheSet(songId, { path: filePath, contentType: contentType || 'image/jpeg' });
          resolve(filePath);
        });

        fileStream.on('error', (err) => {
          fs.unlink(filePath, () => {}); // Clean up partial file
          reject(err);
        });
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  } catch (err) {
    console.error(`Failed to cache cover for ${songId}:`, err.message);
    return null;
  }
}

/**
 * Get cached cover info for a song
 * @param {string} songId - Unique song identifier
 * @returns {{ path: string, contentType: string } | null}
 */
function getCachedCover(songId) {
  // Check memory cache first
  if (coverCache.has(songId)) {
    const cached = coverCache.get(songId);
    if (fs.existsSync(cached.path)) {
      return cached;
    }
    coverCache.delete(songId);
  }

  // Check filesystem for existing files
  ensureCoversDir();
  const extensions = ['.jpg', '.png', '.webp', '.gif'];
  for (const ext of extensions) {
    const filePath = path.join(COVERS_DIR, `${songId}${ext}`);
    if (fs.existsSync(filePath)) {
      const contentTypes = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      const info = { path: filePath, contentType: contentTypes[ext] };
      cacheSet(songId, info);
      return info;
    }
  }

  return null;
}

/**
 * Check if covers directory is available/writable
 */
function isAvailable() {
  try {
    ensureCoversDir();
    const testFile = path.join(COVERS_DIR, '.test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the in-memory cover cache (e.g., during song cache cleanup)
 */
function clearCache() {
  coverCache.clear();
}

module.exports = {
  cacheCover,
  getCachedCover,
  isAvailable,
  clearCache,
  COVERS_DIR,
  MAX_COVER_CACHE_SIZE
};
