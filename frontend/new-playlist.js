// "New playlist" dialog (landing page). An .app-modal card: name (required,
// 50 chars like the server), Public / Private, Cancel + primary Create.
// Creating goes over the socket (lobby:create); lobby.js tells this module
// how it went (newPlaylistCreated / newPlaylistFailed).
import { state, socket } from './state.js';
import { escapeHtml, t, trapFocus } from './ui.js';
import { player } from './player.js';

const MAX_NAME = 50;
let pending = false;

const dialogEl = () => document.getElementById('new-playlist-dialog');

export function isNewPlaylistPending() {
  return pending && !!dialogEl();
}

export function closeNewPlaylistDialog() {
  const d = dialogEl();
  pending = false;
  if (!d) return;
  const back = d._returnFocus;
  d.remove();
  // The empty-state button may have been re-rendered meanwhile.
  const target = back && document.contains(back) ? back : (back ? document.getElementById('new-playlist-btn') : null);
  if (target) target.focus({ preventScroll: true });
}

export function openNewPlaylistDialog(returnFocus = null) {
  closeNewPlaylistDialog();
  const d = document.createElement('div');
  d.id = 'new-playlist-dialog';
  d.className = 'app-modal new-playlist-overlay';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'new-playlist-title');
  d._returnFocus = returnFocus || document.activeElement;
  const radio = (value, label, hint, checked) => `<label class="d-flex gap-3 align-items-start new-playlist-choice">
          <input type="radio" class="radio" name="new-playlist-visibility" value="${value}"${checked ? ' checked' : ''}>
          <span><span class="d-block fw-medium">${escapeHtml(label)}</span><span class="d-block fs-sm fg-3">${escapeHtml(hint)}</span></span>
        </label>`;
  d.innerHTML = `<form class="card app-modal-card new-playlist-form" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="new-playlist-title" class="h6 mb-0">${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</h2>
      <button class="btn-text theme-secondary btn-icon btn-sm new-playlist-close" type="button" aria-label="${escapeHtml(t('landing.cancel', 'Cancel'))}" title="${escapeHtml(t('landing.cancel', 'Cancel'))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <div class="card-body vstack gap-5">
      <div>
        <label for="new-playlist-name" class="form-label fw-medium">${escapeHtml(t('landing.playlistName', 'Playlist name'))}</label>
        <input type="text" id="new-playlist-name" class="form-control" maxlength="${MAX_NAME}" required autocomplete="off" placeholder="${escapeHtml(t('landing.playlistNamePlaceholder', 'e.g. Road trip'))}" aria-describedby="new-playlist-name-error new-playlist-count">
        <div class="d-flex gap-2 mt-1">
          <div id="new-playlist-name-error" class="fs-sm new-playlist-field-error me-auto" aria-live="polite"></div>
          <div id="new-playlist-count" class="fs-xs fg-4 flex-shrink-0 ms-auto">0/${MAX_NAME}</div>
        </div>
      </div>
      <fieldset class="vstack gap-3">
        <legend class="form-label fw-medium">${escapeHtml(t('landing.visibility', 'Visibility'))}</legend>
        ${radio('public', t('landing.public', 'Public'), t('landing.publicHint', 'Public: every signed-in user can see and edit it.'), true)}
        ${radio('private', t('landing.private', 'Private'), t('landing.privateHint', 'Private: only you can see it.'), false)}
      </fieldset>
      <div class="alert theme-danger fs-sm mb-0 new-playlist-error" role="alert" hidden></div>
    </div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn new-playlist-cancel" type="button">${escapeHtml(t('landing.cancel', 'Cancel'))}</button>
      <button class="btn-solid theme-primary new-playlist-submit" type="submit">${escapeHtml(t('landing.createPlaylist', 'Create playlist'))}</button>
    </div>
  </form>`;
  document.body.appendChild(d);

  const form = d.querySelector('form');
  const input = d.querySelector('#new-playlist-name');
  const count = d.querySelector('#new-playlist-count');
  const fieldErr = d.querySelector('#new-playlist-name-error');
  const showFieldError = (msg) => {
    fieldErr.textContent = msg || '';
    input.classList.toggle('is-invalid', !!msg);
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  input.addEventListener('input', () => {
    count.textContent = `${input.value.length}/${MAX_NAME}`;
    if (input.value.trim()) showFieldError('');
  });
  d.querySelector('.new-playlist-close').addEventListener('click', closeNewPlaylistDialog);
  d.querySelector('.new-playlist-cancel').addEventListener('click', closeNewPlaylistDialog);
  d.addEventListener('click', (e) => { if (e.target === d) closeNewPlaylistDialog(); });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeNewPlaylistDialog(); return; }
    trapFocus(d, e);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pending) return;
    const name = input.value.trim();
    if (!name) { showFieldError(t('landing.nameRequired', 'Give the playlist a name.')); input.focus(); return; }
    if (name.length > MAX_NAME) { showFieldError(t('error.nameTooLong', `Name must be ${MAX_NAME} characters or less`)); input.focus(); return; }
    const visibility = form.elements['new-playlist-visibility'].value === 'private' ? 'private' : 'public';
    setBusy(true);
    socket.emit('lobby:create', { username: state.username, emoji: state.emoji, name, visibility, userId: state.userId, asViewer: !!player.context });
  });
  input.focus();
}

function setBusy(busy) {
  pending = busy;
  const d = dialogEl();
  if (!d) return;
  const submit = d.querySelector('.new-playlist-submit');
  submit.disabled = busy;
  submit.textContent = busy ? t('landing.creating', 'Creating…') : t('landing.createPlaylist', 'Create playlist');
  d.querySelector('form').setAttribute('aria-busy', String(busy));
  if (busy) d.querySelector('.new-playlist-error').hidden = true;
}

// lobby:created arrived: the caller navigates; just close (no focus return,
// the view changes).
export function newPlaylistCreated() {
  const d = dialogEl();
  if (d) d._returnFocus = null;
  closeNewPlaylistDialog();
}

// lobby:error while creating: show it in the dialog. A name clash goes under
// the name field, anything else in the alert.
export function newPlaylistFailed(message) {
  setBusy(false);
  const d = dialogEl();
  if (!d) return;
  const input = d.querySelector('#new-playlist-name');
  if (/name/i.test(message || '')) {
    d.querySelector('#new-playlist-name-error').textContent = message;
    input.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  } else {
    const err = d.querySelector('.new-playlist-error');
    err.textContent = message || t('error.generic', 'Something went wrong');
    err.hidden = false;
  }
}
