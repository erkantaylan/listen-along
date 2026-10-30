// The app-wide player bar (markup in index.html): fixed at the bottom of every
// page, Spotify-style. Shows an empty state with disabled controls until
// something is loaded. Track title/art/times are drawn by playback.js; this
// module handles visibility, page padding, the empty state, the "from" line,
// opening the context (playlist page or library) and the listen-along strip
// ("Listening along with Ayşe" + Stop, or "Ayşe and 2 others are listening
// along" for the person being listened to).
import { state, elements } from './state.js';
import { navigateTo, t } from './ui.js';
import { player } from './player.js';
import { playlistPath } from './router.js';
import { listenState, onListenChange, followersText, stopListenAlong } from './listen-along.js';
import { bindSongMenu, bindReportIcons, reportIconHtml, reportsFor, onReportsChange } from './song-reports.js';

// The current song as the song menu / reports see it.
function currentSong() {
  const track = player.track;
  if (!track) return null;
  return { songId: track.libraryId || null, url: track.url, title: track.title, artist: track.artist };
}

// The warning icon (reported song) and the ⋮ button follow the track.
function refreshBroken() {
  const song = currentSong();
  const el = $('track-broken');
  if (el) {
    const html = song ? reportIconHtml(reportsFor(song)) : '';
    el.innerHTML = html;
    el.hidden = !html;
  }
  const btn = $('player-menu-btn');
  if (btn) btn.hidden = !song;
}

const $ = (id) => document.getElementById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
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
  if (ctx.type === 'listen') {
    // Only while actually listening along (the track stays after stopping).
    const { leader } = listenState();
    return leader && leader.id === ctx.leaderId ? tf('listen.withName', 'Listening along with {name}', { name: leader.name }) : '';
  }
  return ctx.name || `Playlist ${ctx.lobbyId}`;
}

function contextPath(ctx) {
  if (!ctx) return null;
  if (ctx.type === 'library') return '/library';
  if (ctx.type === 'listen') return null;
  return playlistPath(ctx.lobbyId);
}

// Empty state, enabled controls and the "artist · from" line.
export function refreshPlayerBar() {
  const bar = $('player-bar');
  if (!bar) return;
  const track = player.track;
  bar.classList.toggle('is-empty', !track);
  for (const id of CONTROL_IDS) { const el = $(id); if (el) el.disabled = !track; }
  // With nothing loaded, Play starts the playlist on screen if it has songs.
  const play = $('play-btn');
  if (play) play.disabled = !track && !(state.lobbyId && state.queue.length);
  const open = $('player-open');
  const ctx = player.context;
  if (open) {
    open.disabled = !track || !contextPath(ctx);
    const from = contextLabel(ctx);
    open.title = from ? t('player.openContext', 'Open {name}', { name: from }) : '';
  }
  refreshListenStrip();
  refreshBroken();
  if (!track) {
    elements.trackTitle.textContent = t('player.nothingPlaying', 'Nothing playing');
    elements.trackArtist.textContent = t('player.pickSong', 'Pick a song in a playlist or the library');
    return;
  }
  elements.trackArtist.textContent = [track.artist, contextLabel(ctx)].filter(Boolean).join(' · ');
}

// The strip above the bar's row: following someone, or being listened to.
function refreshListenStrip() {
  const strip = $('listen-strip');
  if (!strip) return;
  const { leader, ending, followers } = listenState();
  const text = $('listen-strip-text');
  const stop = $('listen-stop');
  if (leader) {
    text.textContent = ending
      ? tf('listen.endingStrip', '{name} went offline · stops after this song', { name: leader.name })
      : tf('listen.withName', 'Listening along with {name}', { name: leader.name });
    stop.hidden = false;
    strip.hidden = false;
  } else if (followers.count > 0) {
    text.textContent = followersText(followers);
    stop.hidden = true;
    strip.hidden = false;
  } else {
    strip.hidden = true;
  }
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
  onListenChange(refreshPlayerBar);
  $('listen-stop')?.addEventListener('click', () => stopListenAlong());
  // Right-click / long-press the current song, or its ⋮ button: the song menu.
  bindSongMenu(document.querySelector('#player-bar .sticky-player-row'), '.player-open, .player-menu-btn', () => currentSong());
  bindReportIcons($('track-broken'), () => { const song = currentSong(); return song ? reportsFor(song) : []; });
  onReportsChange(refreshBroken);
  refreshPlayerBar();
}
