// The app-wide player bar (markup in index.html): fixed at the bottom of every
// page, Spotify-style. Shows an empty state with disabled controls until
// something is loaded. Track title/art/times are drawn by playback.js; this
// module handles visibility, page padding, the empty state, the "from" line
// and opening the context (lobby page or library).
import { state, elements } from './state.js';
import { navigateTo, t } from './ui.js';
import { player } from './player.js';

const $ = (id) => document.getElementById(id);
const CONTROL_IDS = ['repeat-btn', 'shuffle-btn', 'prev-btn', 'next-btn', 'progress-bar'];

// Hidden only before sign-in (login / pending approval).
function refreshVisibility() {
  const bar = $('player-bar');
  if (!bar) return;
  const signedOut = (elements.loginView && elements.loginView.classList.contains('active'))
    || (elements.pendingView && elements.pendingView.classList.contains('active'));
  bar.hidden = signedOut;
  document.body.classList.toggle('has-player-bar', !signedOut);
}

// Where the music comes from, for the bar's second line and the open button.
export function contextLabel(ctx) {
  if (!ctx) return '';
  if (ctx.type === 'library') return t('player.fromLibrary', 'Music Library');
  return ctx.name || `Lobby ${ctx.lobbyId}`;
}

function contextPath(ctx) {
  if (!ctx) return null;
  if (ctx.type === 'library') return '/library';
  return `/lobby/${ctx.lobbyId}`;
}

// Empty state, enabled controls and the "artist · from" line.
export function refreshPlayerBar() {
  const bar = $('player-bar');
  if (!bar) return;
  const track = player.track;
  bar.classList.toggle('is-empty', !track);
  for (const id of CONTROL_IDS) { const el = $(id); if (el) el.disabled = !track; }
  // With nothing loaded, Play starts the lobby on screen if it has songs.
  const play = $('play-btn');
  if (play) play.disabled = !track && !(state.lobbyId && state.queue.length);
  const open = $('player-open');
  const ctx = player.context;
  if (open) {
    open.disabled = !track || !ctx;
    const from = contextLabel(ctx);
    open.title = from ? t('player.openContext', 'Open {name}', { name: from }) : '';
  }
  if (!track) {
    elements.trackTitle.textContent = t('player.nothingPlaying', 'Nothing playing');
    elements.trackArtist.textContent = t('player.pickSong', 'Pick a song in a lobby or the library');
    return;
  }
  elements.trackArtist.textContent = [track.artist, contextLabel(ctx)].filter(Boolean).join(' · ');
}

export function setupPlayerBar() {
  const bar = $('player-bar');
  if (!bar) return;
  // Keep page content clear of the bar whatever its height (phone/desktop).
  const measure = () => document.body.style.setProperty('--app-player-height', `${bar.hidden ? 0 : bar.offsetHeight}px`);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(bar);
  window.addEventListener('resize', measure);
  document.addEventListener('app:viewchange', () => { refreshVisibility(); measure(); });
  refreshVisibility();
  measure();
}

// Interactive parts (only in the signed-in app, after the player is set up).
export function setupPlayerBarControls() {
  $('player-open').addEventListener('click', () => {
    const path = contextPath(player.context);
    if (path) navigateTo(path);
  });
  player.on('track', refreshPlayerBar);
  player.on('context', refreshPlayerBar);
  player.on('queue', refreshPlayerBar);
  refreshPlayerBar();
}
