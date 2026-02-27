/**
 * Media Session API integration for lock screen / notification controls.
 *
 * Provides play/pause, next, previous on:
 *   - Android: notification shade + lock screen
 *   - iOS Safari: Control Center + lock screen
 *   - Desktop: media keys on keyboard
 *
 * Usage from app.js:
 *   MediaSessionManager.init({ onPlay, onPause, onNext, onPrevious })
 *   MediaSessionManager.updateTrack({ title, artist, thumbnail, songId })
 *   MediaSessionManager.updatePlaybackState('playing' | 'paused' | 'none')
 *   MediaSessionManager.updatePositionState({ duration, position, playbackRate })
 */
(function () {
  'use strict';

  var callbacks = {};
  var supported = 'mediaSession' in navigator;
  var currentArtwork = [];

  /**
   * Initialize media session with action callbacks.
   * @param {Object} opts
   * @param {Function} opts.onPlay
   * @param {Function} opts.onPause
   * @param {Function} opts.onNext
   * @param {Function} opts.onPrevious
   * @param {Function} [opts.onSeekTo]
   */
  function init(opts) {
    callbacks = opts || {};

    if (!supported) {
      console.log('Media Session API not supported in this browser');
      return;
    }

    var actions = [
      ['play', callbacks.onPlay],
      ['pause', callbacks.onPause],
      ['nexttrack', callbacks.onNext],
      ['previoustrack', callbacks.onPrevious]
    ];

    actions.forEach(function (entry) {
      var action = entry[0];
      var handler = entry[1];
      if (handler) {
        try {
          navigator.mediaSession.setActionHandler(action, function () {
            handler();
          });
        } catch (e) {
          console.warn('Media Session: action "' + action + '" not supported:', e.message);
        }
      }
    });

    // Seek support (optional, not all browsers)
    if (callbacks.onSeekTo) {
      try {
        navigator.mediaSession.setActionHandler('seekto', function (details) {
          if (details.seekTime !== undefined) {
            callbacks.onSeekTo(details.seekTime);
          }
        });
      } catch (e) {
        // seekto not supported on this browser
      }
    }
  }

  /**
   * Update the now-playing metadata shown on lock screen / notifications.
   * @param {Object} track
   * @param {string} track.title
   * @param {string} [track.artist]
   * @param {string} [track.thumbnail] - URL for artwork
   * @param {string} [track.songId] - Used to build cover URL
   */
  function updateTrack(track) {
    if (!supported || !track) return;

    currentArtwork = buildArtwork(track);

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Unknown Track',
        artist: track.artist || 'Listen Along',
        album: '',
        artwork: currentArtwork
      });
    } catch (e) {
      console.warn('Media Session: failed to set metadata:', e.message);
    }
  }

  /**
   * Build artwork array from track info.
   * Tries multiple sizes for best OS compatibility.
   */
  function buildArtwork(track) {
    var artwork = [];

    // Prefer local cover proxy (handles caching + CORS)
    var url = null;
    if (track.songId) {
      var fallback = track.thumbnail ? encodeURIComponent(track.thumbnail) : '';
      url = '/api/covers/' + track.songId + (fallback ? '?fallback=' + fallback : '');
    } else if (track.thumbnail) {
      url = track.thumbnail;
    }

    if (url) {
      // Provide multiple sizes — browsers/OS pick the best fit
      var sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
      sizes.forEach(function (size) {
        artwork.push({ src: url, sizes: size, type: 'image/jpeg' });
      });
    }

    return artwork;
  }

  /**
   * Update playback state shown in OS media controls.
   * @param {'playing'|'paused'|'none'} state
   */
  function updatePlaybackState(state) {
    if (!supported) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch (e) {
      // Some browsers don't support playbackState
    }
  }

  /**
   * Update position/duration for seek bar on lock screen.
   * @param {Object} opts
   * @param {number} opts.duration - Total duration in seconds
   * @param {number} opts.position - Current position in seconds
   * @param {number} [opts.playbackRate] - Defaults to 1
   */
  function updatePositionState(opts) {
    if (!supported || !navigator.mediaSession.setPositionState) return;
    try {
      if (opts.duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: opts.duration,
          playbackRate: opts.playbackRate || 1,
          position: Math.min(opts.position || 0, opts.duration)
        });
      }
    } catch (e) {
      // setPositionState not supported or invalid values
    }
  }

  /**
   * Clean up — remove all action handlers.
   */
  function destroy() {
    if (!supported) return;
    var actions = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto'];
    actions.forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch (e) {
        // ignore
      }
    });
    try {
      navigator.mediaSession.metadata = null;
    } catch (e) {
      // ignore
    }
  }

  // Expose as global
  window.MediaSessionManager = {
    init: init,
    updateTrack: updateTrack,
    updatePlaybackState: updatePlaybackState,
    updatePositionState: updatePositionState,
    destroy: destroy,
    isSupported: function () { return supported; }
  };
})();
