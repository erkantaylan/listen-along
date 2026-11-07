// The one dialog that edits or replaces a library song ("Replace with…" in the
// song menu, and the library row's swap button). What it does follows from what
// changed, and the primary button says so:
//   a file chosen          "Replace"            uploaded now; the link is its label
//   another YouTube link   "Replace from link"  a download job for a downloader
//                                               (la worker); the song keeps playing
//                                               the old audio until it is done
//   title, artist, album   "Save"               saved now; the audio is untouched
//   nothing                disabled
// The server enforces every rule again (backend/src/jobRoutes.js, libraryRoutes.js).
import { showToast, trapFocus, formatDuration, t } from './ui.js';
import { jobStatusText, onJobChange, handleJobUpdate } from './jobs.js';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';

const LOOKUP_DELAY_MS = 400;
const FAILED_JOB_SHOWN_MS = 24 * 3600 * 1000;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const squeeze = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function youtubeIdFromUrl(url) {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(String(url || ''));
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(url || '')) ? url : null);
}

function currentLink(song) {
  return song.source_url || (song.youtube_id ? `https://www.youtube.com/watch?v=${song.youtube_id}` : '');
}

/** The real, openable link, or null (only http(s) ever becomes an href). */
function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

function percentOf(job) {
  const m = /(\d{1,3})%\s*$/.exec(job.progress || '');
  return job.status === 'assigned' && m ? Math.min(100, Number(m[1])) : null;
}

const JOB_THEME = { queued: 'theme-warning', assigned: 'theme-primary', done: 'theme-success', failed: 'theme-danger', cancelled: 'theme-secondary' };

function showableJob(job) {
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'assigned') return job;
  if (job.status === 'failed' && Date.now() - Date.parse(job.finished_at || job.created_at) < FAILED_JOB_SHOWN_MS) return job;
  return null;
}

let closeOpen = null;

export function closeReplaceDialog() {
  if (closeOpen) closeOpen();
}

/** Open the dialog for a library song. returnFocus gets focus back on close. */
export async function openReplaceDialog({ songId, returnFocus = null }) {
  closeReplaceDialog();
  const back = returnFocus || document.activeElement;
  let song;
  let jobInfo = { job: null, active: false, workers: null };
  try {
    const [songRes, jobRes] = await Promise.all([
      fetch(`/api/library/${encodeURIComponent(songId)}`, { credentials: 'same-origin' }),
      fetch(`/api/jobs/replace/${encodeURIComponent(songId)}`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    const data = await songRes.json().catch(() => ({}));
    if (!songRes.ok || !data.song) throw new Error(data.error || `HTTP ${songRes.status}`);
    song = data.song;
    if (jobRes && jobRes.ok) jobInfo = await jobRes.json();
  } catch (err) {
    showToast(`Could not open the song: ${err.message}`, 'error');
    return;
  }
  renderDialog(song, jobInfo, back);
}

function renderDialog(initial, jobInfo, back) {
  let song = initial;
  let job = showableJob(jobInfo.job);
  let someoneElseActive = !!jobInfo.active && !(job && (job.status === 'queued' || job.status === 'assigned'));
  let finishedNote = null;
  let workers = jobInfo.workers;
  let baseline = { title: squeeze(song.title), artist: squeeze(song.artist), album: squeeze(song.album), link: currentLink(song) };
  let busy = false;
  let lookup = { state: 'idle', link: null, data: null }; // idle | pending | done | bad
  let lookupTimer = null;
  let lookupSeq = 0;

  const reports = song.reports || [];
  const dialog = document.createElement('div');
  dialog.id = 'replace-dialog';
  dialog.className = 'app-modal replace-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'replace-title');
  dialog.innerHTML = `<form class="card app-modal-card replace-form" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="replace-title" class="h6 mb-0 text-truncate">${escapeHtml(t('songMenu.replaceWith', 'Replace with…'))}</h2>
      <button class="btn-text theme-secondary btn-icon btn-sm replace-close" type="button" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="card-body vstack gap-4">
      <p class="fs-sm fg-3 mb-0"><span class="fg-2 replace-song-name"></span>${initial.duration_sec ? ` · ${escapeHtml(formatDuration(initial.duration_sec))}` : ''}. Changes apply for everyone and are logged; a replaced file cannot be brought back.</p>
      ${reports.length ? `<div class="alert theme-warning fs-sm mb-0 replace-reports"><div class="min-w-0 flex-grow-1"><div class="fw-medium">Marked as broken</div><ul class="list-unstyled mb-0 mt-1">${reports.map((r) => `<li>${escapeHtml(r.reason || 'No reason given')} <span class="fs-xs">(${escapeHtml(r.mine ? 'you' : r.reported_by)})</span></li>`).join('')}</ul></div></div>` : ''}
      <div class="alert fs-sm mb-0 replace-job" role="status" aria-live="polite" hidden></div>
      <div><label class="form-label" for="replace-song-title">Title</label>
        <input class="form-control" id="replace-song-title" maxlength="300" required autocomplete="off"></div>
      <div><label class="form-label" for="replace-artist">Artist</label>
        <input class="form-control" id="replace-artist" maxlength="300" required autocomplete="off"></div>
      <div><label class="form-label" for="replace-album">Album <span class="fg-3">(optional)</span></label>
        <input class="form-control" id="replace-album" maxlength="300" autocomplete="off"></div>
      <div>
        <label class="form-label" for="replace-source">YouTube or source link</label>
        <div class="input-group">
          <input class="form-control" id="replace-source" type="url" maxlength="2048" autocomplete="off" placeholder="https://www.youtube.com/watch?v=…" aria-describedby="replace-link-note">
          <a class="btn btn-icon replace-open" target="_blank" rel="noopener noreferrer" aria-label="Open the current link in a new tab" title="Open the current link in a new tab" hidden>${OPEN_ICON}</a>
        </div>
        <div class="fs-sm mt-1 fg-3 replace-link-note" id="replace-link-note" aria-live="polite"></div>
        <div class="alert theme-warning fs-sm mb-0 mt-2 replace-link-warning" role="alert" hidden></div>
      </div>
      <div><label class="form-label" for="replace-file">Audio file <span class="fg-3">(optional, .m4a AAC or .opus)</span></label>
        <input class="form-control" type="file" id="replace-file" accept=".m4a,.opus,audio/mp4,audio/ogg">
        <div class="fs-xs fg-3 mt-1">A file is used at once, instead of downloading the link; the link then only says where it came from.</div></div>
      <div class="alert theme-danger fs-sm mb-0 replace-error" role="alert" hidden></div>
    </div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn replace-cancel" type="button">Cancel</button>
      <button class="btn-solid theme-primary replace-submit" type="submit" disabled>Save</button>
    </div>
  </form>`;
  document.body.appendChild(dialog);

  const $ = (sel) => dialog.querySelector(sel);
  const fields = { title: $('#replace-song-title'), artist: $('#replace-artist'), album: $('#replace-album'), link: $('#replace-source'), file: $('#replace-file') };
  const submit = $('.replace-submit');
  const err = $('.replace-error');
  const showError = (msg) => { err.textContent = msg; err.hidden = !msg; };

  function fill() {
    $('.replace-song-name').textContent = `${song.title}${song.artist ? ` — ${song.artist}` : ''}`;
    fields.title.value = song.title || '';
    fields.artist.value = song.artist || '';
    fields.album.value = song.album || '';
    fields.link.value = currentLink(song);
    const open = $('.replace-open');
    const href = safeHref(currentLink(song));
    open.hidden = !href;
    if (href) open.href = href; else open.removeAttribute('href');
  }

  function values() {
    return {
      title: squeeze(fields.title.value),
      artist: squeeze(fields.artist.value),
      album: squeeze(fields.album.value),
      link: fields.link.value.trim(),
      file: fields.file.files[0] || null,
    };
  }

  const linkId = (link) => youtubeIdFromUrl(link);
  // The same video in other words (a youtu.be link, an added &t=) is no change.
  const linkChanged = (v) => !!v.link && v.link !== baseline.link && !(linkId(v.link) && linkId(v.link) === (song.youtube_id || linkId(baseline.link)));
  const sameVideoTyped = (v) => !!v.link && v.link !== baseline.link && !linkChanged(v);
  const detailsChanged = (v) => v.title !== baseline.title || v.artist !== baseline.artist || v.album !== baseline.album;

  function mode(v) {
    if (v.file) return 'file';
    if (linkChanged(v)) return 'link';
    if (detailsChanged(v)) return 'details';
    return 'none';
  }

  const hasActiveJob = () => !!(job && (job.status === 'queued' || job.status === 'assigned'));

  /** What stops the button, as a message for the link note (or '' when only disabled). */
  function linkProblem(v) {
    if (lookup.link !== v.link) return null;
    if (lookup.state === 'bad') return lookup.message;
    if (lookup.state === 'done' && lookup.data.problem) return lookup.data.problem.message;
    return null;
  }

  function refresh() {
    const v = values();
    const m = mode(v);
    submit.textContent = busy ? busy : { file: 'Replace', link: 'Replace from link', details: 'Save', none: 'Save' }[m];
    const missing = !v.title || !v.artist;
    const blocked = m === 'none' || missing
      || (m === 'link' && (hasActiveJob() || someoneElseActive || !!linkProblem(v)))
      || (m === 'file' && job && job.status === 'assigned');
    submit.disabled = !!busy || !!blocked;
    for (const [el, value] of [[fields.title, v.title], [fields.artist, v.artist]]) {
      if (value) el.removeAttribute('aria-invalid'); else el.setAttribute('aria-invalid', 'true');
    }
    renderLinkNote(v, m);
    renderJob();
  }

  function renderLinkNote(v, m) {
    const note = $('.replace-link-note');
    const warning = $('.replace-link-warning');
    let text = '';
    let tone = 'fg-3';
    let warn = '';
    if (m === 'file') {
      text = v.link ? 'The file is used; this link only says where it came from.' : '';
    } else if (sameVideoTyped(v)) {
      text = 'That is the video this song already uses, so there is nothing to replace.';
    } else if (m === 'link') {
      const problem = linkProblem(v);
      if (problem) {
        text = problem;
        tone = 'replace-note-danger';
      } else if (lookup.link === v.link && lookup.state === 'pending') {
        text = 'Looking up the video…';
      } else if (lookup.link === v.link && lookup.state === 'done') {
        const d = lookup.data;
        if (d.resolved) {
          const bits = [d.title ? `“${d.title}”` : null, d.channel, d.duration_sec ? formatDuration(d.duration_sec) : 'length unknown'].filter(Boolean);
          text = `${bits.join(' · ')}. The song keeps its title, artist and album above.`;
          if (d.duration_differs) {
            warn = `This video is ${formatDuration(d.duration_sec)}, the song is ${formatDuration(d.current_duration_sec)}. That changes the song for everyone, and it cannot be undone.`;
          }
        } else {
          text = 'Could not look up this video. You can still replace from it; if the downloader cannot get it, nothing changes.';
        }
      } else if (hasActiveJob() || someoneElseActive) {
        text = 'A replacement is already in progress for this song.';
      }
    }
    note.textContent = text;
    note.className = `fs-sm mt-1 replace-link-note ${tone}`;
    warning.textContent = warn;
    warning.hidden = !warn;
  }

  function renderJob() {
    const box = $('.replace-job');
    if (finishedNote) {
      box.className = 'alert theme-success fs-sm mb-0 replace-job';
      box.textContent = finishedNote;
      box.hidden = false;
      return;
    }
    if (!job) {
      box.hidden = !someoneElseActive;
      if (someoneElseActive) {
        box.className = 'alert theme-secondary fs-sm mb-0 replace-job';
        box.textContent = 'Someone is already replacing this song from a link.';
      }
      return;
    }
    const pct = percentOf(job);
    const hint = job.status === 'queued' ? '. You can still upload a file instead.' : '';
    const statusHtml = `<div class="replace-job-status">${escapeHtml(jobStatusText(job, workers || undefined))}${escapeHtml(hint)}</div>`;
    const barHtml = pct === null ? '' : `<div class="progress mt-2" role="progressbar" aria-label="Upload progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${pct}%"></div></div>`;
    const cancelHtml = job.status === 'queued' ? '<button class="btn btn-sm mt-2 replace-job-cancel" type="button">Stop waiting</button>' : '';
    const html = `<div class="min-w-0 flex-grow-1">${statusHtml}${barHtml}${cancelHtml}</div>`;
    // Progress comes about once a second: keep the Cancel button (and focus) when nothing else changed.
    if (box.dataset.html !== html) {
      box.innerHTML = html;
      box.dataset.html = html;
    }
    box.className = `alert ${JOB_THEME[job.status] || 'theme-secondary'} fs-sm mb-0 replace-job`;
    box.hidden = false;
  }

  function scheduleLookup() {
    clearTimeout(lookupTimer);
    const v = values();
    if (v.file || !linkChanged(v)) { lookup = { state: 'idle', link: null, data: null }; lookupSeq++; return; }
    if (lookup.link === v.link) return;
    lookup = { state: 'pending', link: v.link, data: null };
    const seq = ++lookupSeq;
    lookupTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/jobs/replace/preview', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song_id: song.id, input: v.link }),
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== lookupSeq) return;
        if (res.ok) {
          if (data.problem && data.problem.code === 'BAD_INPUT') data.problem.message = 'Only a YouTube video can be downloaded. To keep this link as a label, choose a file.';
          lookup = { state: 'done', link: v.link, data };
        }
        else if (res.status === 404) lookup = { state: 'bad', link: v.link, data: null, message: data.error || 'This song is no longer in the library.' };
        else lookup = { state: 'done', link: v.link, data: { resolved: false, problem: null } };
      } catch {
        if (seq !== lookupSeq) return;
        lookup = { state: 'done', link: v.link, data: { resolved: false, problem: null } };
      }
      refresh();
    }, LOOKUP_DELAY_MS);
  }

  const onInput = () => { showError(''); scheduleLookup(); refresh(); };
  for (const el of [fields.title, fields.artist, fields.album, fields.link]) el.addEventListener('input', onInput);
  fields.file.addEventListener('change', onInput);

  async function reloadSong() {
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(song.id)}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      song = data.song;
      baseline = { title: squeeze(song.title), artist: squeeze(song.artist), album: squeeze(song.album), link: currentLink(song) };
      fill();
      refresh();
    } catch {}
  }

  // Live: this dialog's job, and how many downloaders are around.
  const offJob = onJobChange((change) => {
    if (change.workers) workers = change.workers;
    const updated = change.job;
    const mine = !!(updated && updated.replace && updated.replace.song_id === song.id);
    if (mine) {
      if (updated.status === 'done') {
        job = null;
        someoneElseActive = false;
        finishedNote = 'Replaced. Every playlist with this song now plays the new audio.';
        delete $('.replace-job').dataset.html;
        reloadSong();
      } else {
        job = showableJob(updated);
        finishedNote = null;
        someoneElseActive = false;
        lookup = { state: 'idle', link: null, data: null };
      }
    }
    refresh();
    return mine; // on screen here: no toast on top of the dialog as well
  });

  function close() {
    closeOpen = null;
    offJob();
    clearTimeout(lookupTimer);
    lookupSeq++;
    dialog.remove();
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  }
  closeOpen = close;

  $('.replace-close').addEventListener('click', close);
  $('.replace-cancel').addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
    if (e.target.closest('.replace-job-cancel')) cancelJob(e.target.closest('.replace-job-cancel'));
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    trapFocus(dialog, e);
  });

  async function cancelJob(btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      handleJobUpdate({ job: data.job });
    } catch (ex) {
      showError(ex.message);
      btn.disabled = false;
    }
  }

  async function saveDetails(v) {
    const res = await fetch(`/api/library/${encodeURIComponent(song.id)}`, {
      method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: v.title, artist: v.artist, album: v.album }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    close();
    showToast(`Saved “${data.song.title}”`, 'success');
  }

  async function replaceFromLink(v) {
    const res = await fetch('/api/jobs/replace', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: song.id, input: v.link, title: v.title, artist: v.artist, album: v.album }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code === 'replace_job_active') someoneElseActive = !hasActiveJob();
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (data.workers) workers = data.workers;
    job = data.job;
    finishedNote = null;
    // These details travel with the job now: the fields are no longer an unsaved change.
    baseline = { ...baseline, title: v.title, artist: v.artist, album: v.album };
    handleJobUpdate({ job: data.job, workers: data.workers });
  }

  async function uploadFile(v) {
    if (!/\.(m4a|opus)$/i.test(v.file.name)) throw new Error('Only .m4a (AAC) and .opus (Opus) files are accepted.');
    if (v.link && !/^https?:\/\//i.test(v.link)) throw new Error('The source link must start with http:// or https://');
    const fd = new FormData();
    fd.append('file', v.file, v.file.name);
    fd.append('title', v.title);
    fd.append('artist', v.artist);
    if (v.album) fd.append('album', v.album);
    if (v.link) {
      fd.append('source_url', v.link);
      const yt = /^https?:/i.test(v.link) ? youtubeIdFromUrl(v.link) : null;
      if (yt) fd.append('youtube_id', yt);
    }
    const res = await fetch(`/api/library/${encodeURIComponent(song.id)}/replace`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const other = data.song && data.song.id !== song.id ? ` (“${data.song.title}”${data.song.artist ? ` by ${data.song.artist}` : ''})` : '';
      throw new Error((data.error || `HTTP ${res.status}`) + other);
    }
    close();
    showToast(`Replaced the audio of “${data.song.title}”`, 'success');
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = values();
    const m = mode(v);
    showError('');
    if (submit.disabled || m === 'none') return;
    busy = { file: 'Uploading…', link: 'Queuing…', details: 'Saving…' }[m];
    refresh();
    try {
      if (m === 'file') await uploadFile(v);
      else if (m === 'link') await replaceFromLink(v);
      else await saveDetails(v);
    } catch (ex) {
      showError(`Could not ${m === 'details' ? 'save' : 'replace'}: ${ex.message}`);
    }
    busy = false;
    if (closeOpen === close) refresh();
  });

  fill();
  refresh();
  fields.title.focus();
}
