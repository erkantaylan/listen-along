const { spawn } = require('child_process');

/**
 * Extract metadata for a YouTube video or search query
 * @param {string} query - YouTube URL or search term
 * @returns {Promise<Object>} Video metadata
 */
function getMetadata(query) {
  return new Promise((resolve, reject) => {
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    const target = isUrl ? query : `ytsearch:${query}`;

    const args = [
      '-j',                    // JSON output
      '--no-playlist',         // Single video only
      '-f', 'bestaudio',       // Audio format selection
      target
    ];

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const error = parseError(stderr, code);
        return reject(error);
      }

      try {
        const info = JSON.parse(stdout);
        resolve({
          id: info.id,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          uploader: info.uploader,
          url: info.webpage_url
        });
      } catch (e) {
        reject(new Error('Failed to parse video metadata'));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Create an audio stream for a YouTube video
 * @param {string} query - YouTube URL or search term
 * @returns {Object} { stream, proc } - Audio stream and process handle
 */
function createAudioStream(query) {
  const isUrl = query.startsWith('http://') || query.startsWith('https://');
  const target = isUrl ? query : `ytsearch:${query}`;

  const args = [
    '-f', 'bestaudio',
    '-o', '-',                 // Output to stdout
    '--no-playlist',
    target
  ];

  const proc = spawn('yt-dlp', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return {
    stream: proc.stdout,
    proc,
    kill: () => proc.kill('SIGTERM')
  };
}

/**
 * Create a transcoded audio stream (converts to mp3 via ffmpeg)
 * @param {string} query - YouTube URL or search term
 * @returns {Object} { stream, kill } - Audio stream and cleanup function
 */
function createTranscodedStream(query) {
  const isUrl = query.startsWith('http://') || query.startsWith('https://');
  const target = isUrl ? query : `ytsearch:${query}`;

  // yt-dlp outputs raw audio to stdout
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-playlist',
    target
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // ffmpeg transcodes to mp3 for browser compatibility
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',           // Input from stdin
    '-f', 'mp3',              // Output format
    '-ab', '128k',            // Bitrate
    '-'                       // Output to stdout
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Pipe yt-dlp output to ffmpeg input
  ytdlp.stdout.pipe(ffmpeg.stdin);

  // Handle yt-dlp errors
  let ytdlpError = '';
  ytdlp.stderr.on('data', (data) => {
    ytdlpError += data.toString();
  });

  ytdlp.on('close', (code) => {
    if (code !== 0 && code !== null) {
      ffmpeg.stdin.end();
    }
  });

  const kill = () => {
    ytdlp.kill('SIGTERM');
    ffmpeg.kill('SIGTERM');
  };

  return {
    stream: ffmpeg.stdout,
    ytdlp,
    ffmpeg,
    kill,
    getError: () => ytdlpError
  };
}

/**
 * Parse yt-dlp error output into a user-friendly error
 * @param {string} stderr - Error output from yt-dlp
 * @param {number} code - Exit code
 * @returns {Error} Parsed error with appropriate message
 */
function parseError(stderr, code) {
  const lowerErr = stderr.toLowerCase();

  if (lowerErr.includes('private video')) {
    const err = new Error('This video is private');
    err.code = 'VIDEO_PRIVATE';
    return err;
  }

  if (lowerErr.includes('sign in') || lowerErr.includes('age-restricted')) {
    const err = new Error('Video requires sign-in or is age-restricted');
    err.code = 'VIDEO_RESTRICTED';
    return err;
  }

  // Check region block before generic unavailable (more specific match first)
  if (lowerErr.includes('blocked') || lowerErr.includes('not available in your country')) {
    const err = new Error('Video is blocked in this region');
    err.code = 'VIDEO_BLOCKED';
    return err;
  }

  if (lowerErr.includes('video unavailable') || lowerErr.includes('not available')) {
    const err = new Error('Video not available');
    err.code = 'VIDEO_UNAVAILABLE';
    return err;
  }

  if (lowerErr.includes('no video formats') || lowerErr.includes('no suitable format')) {
    const err = new Error('No audio format available');
    err.code = 'NO_FORMAT';
    return err;
  }

  if (lowerErr.includes('unable to extract') || lowerErr.includes('no results')) {
    const err = new Error('Video not found');
    err.code = 'NOT_FOUND';
    return err;
  }

  // Generic error
  const err = new Error(`yt-dlp error (code ${code}): ${stderr.slice(0, 200)}`);
  err.code = 'YTDLP_ERROR';
  return err;
}

/**
 * Check if yt-dlp is available
 * @returns {Promise<boolean>}
 */
function checkAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

module.exports = {
  getMetadata,
  createAudioStream,
  createTranscodedStream,
  parseError,
  checkAvailable
};
