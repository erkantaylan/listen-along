'use strict';

const fs = require('fs');
const path = require('path');
const { CliError, EXIT } = require('./errors');

/** HTTP error from the server, carrying status and parsed JSON body. */
class ApiError extends CliError {
  constructor(message, { status, body, exitCode = EXIT.SERVER, code = 'HTTP_ERROR' } = {}) {
    super(message, { exitCode, code });
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Open a file as a Blob without reading it all into memory when possible
 * (fs.openAsBlob streams from disk lazily; Node >= 19.8).
 */
async function fileBlob(file, type) {
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(file, { type });
  return new Blob([await fs.promises.readFile(file)], { type });
}

/** Thin client for the listen-along library API. */
class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.server - base URL
   * @param {string} opts.token - bearer token
   * @param {Function} [opts.fetch] - fetch implementation (for tests)
   * @param {number} [opts.timeoutMs] - per-request timeout for non-upload calls
   */
  constructor({ server, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
    this.server = server.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(p, query) {
    const u = new URL(this.server + p);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * @param {object} [opts]
   * @param {object} [opts.json] - JSON request body (sets Content-Type)
   * @param {boolean} [opts.clientErrors] - a 4xx the request itself caused
   *   (400/403 FORBIDDEN/404/409/422) is a plain failure (exit 1, code from the
   *   server's `code`), not exit 5. 401 and account 403s stay exit 4.
   */
  async request(method, p, { query, body, json, timeoutMs = this.timeoutMs, okStatuses = [], clientErrors = false } = {}) {
    const url = this.url(p, query);
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      const reason = err.cause?.code || err.cause?.message || err.message;
      throw new ApiError(`Cannot reach server ${this.server}: ${reason}`, { code: 'UNREACHABLE' });
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, data };

    const serverMsg = (data && (data.error || data.message)) || res.statusText || 'request failed';
    const notAllowed = res.status === 403 && data?.code === 'FORBIDDEN'; // e.g. not the owner (not an auth problem)
    if (clientErrors && ([400, 404, 409, 422].includes(res.status) || notAllowed)) {
      throw new ApiError(serverMsg, {
        status: res.status, body: data, exitCode: EXIT.FAILURE, code: data?.code || `HTTP_${res.status}`,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(`Authentication failed (${res.status}): ${serverMsg}`, {
        status: res.status, body: data, exitCode: EXIT.AUTH, code: 'AUTH',
      });
    }
    throw new ApiError(`${method} ${p} failed (${res.status}): ${serverMsg}`, {
      status: res.status, body: data, exitCode: EXIT.SERVER, code: `HTTP_${res.status}`,
    });
  }

  async me() {
    return (await this.request('GET', '/api/me')).data;
  }

  /** One page of library songs. */
  async library({ q, limit, offset } = {}) {
    const { data } = await this.request('GET', '/api/library', { query: { q, limit, offset } });
    return { songs: data?.songs || [], total: data?.total ?? (data?.songs || []).length };
  }

  /** Every library song (paged). Used to build the "already have it" set. */
  async libraryAll({ q, pageSize = 500 } = {}) {
    const all = [];
    let total = Infinity;
    for (let offset = 0; offset < total; offset += pageSize) {
      const page = await this.library({ q, limit: pageSize, offset });
      all.push(...page.songs);
      total = page.total;
      if (page.songs.length === 0 || page.songs.length < pageSize) break;
    }
    return all;
  }

  /** Set of youtube_ids already in the library. */
  async libraryYoutubeIds() {
    const songs = await this.libraryAll();
    return new Set(songs.map((s) => s.youtube_id).filter(Boolean));
  }

  /**
   * Upload one m4a file.
   * @returns {{ status: 'uploaded'|'duplicate', song: object }}
   * Throws ApiError for 400/other failures.
   */
  async upload(file, fields) {
    const form = new FormData();
    const blob = await fileBlob(file, 'audio/mp4');
    form.append('file', blob, path.basename(file));
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
    }
    // Uploads can be large/slow: no fixed timeout.
    const { status, data } = await this.request('POST', '/api/library/upload', {
      body: form, timeoutMs: 0, okStatuses: [409],
    });
    if (status === 409) return { status: 'duplicate', song: data?.song || null, message: data?.error };
    return { status: 'uploaded', song: data?.song || data };
  }

  // --- Playlists (GET/POST/PATCH/DELETE /api/playlists...) ----------------

  /** Playlists the token's user can see. */
  async playlists() {
    const { data } = await this.request('GET', '/api/playlists', { clientErrors: true });
    return data?.playlists || [];
  }

  async createPlaylist({ name, visibility }) {
    return (await this.request('POST', '/api/playlists', { json: { name, visibility }, clientErrors: true })).data;
  }

  /** Rename and/or change visibility: { name?, visibility? }. */
  async updatePlaylist(id, changes) {
    return (await this.request('PATCH', `/api/playlists/${encodeURIComponent(id)}`, { json: changes, clientErrors: true })).data;
  }

  async deletePlaylist(id) {
    return (await this.request('DELETE', `/api/playlists/${encodeURIComponent(id)}`, { clientErrors: true })).data;
  }

  /** { playlist, songs: [{ position, entry_id, library_id, youtube_id, title, ... }] } */
  async playlistSongs(id) {
    return (await this.request('GET', `/api/playlists/${encodeURIComponent(id)}/songs`, { clientErrors: true })).data;
  }

  /** refs: library ids or "yt:<id>". { summary, results, song_count } */
  async addPlaylistSongs(id, refs, { allowDuplicates = false } = {}) {
    const json = { songs: refs };
    if (allowDuplicates) json.allow_duplicates = true;
    return (await this.request('POST', `/api/playlists/${encodeURIComponent(id)}/songs`, { json, clientErrors: true })).data;
  }

  /** ref: entry id, library id or "yt:<id>". { removed, song_count } */
  async removePlaylistSong(id, ref) {
    return (await this.request('DELETE', `/api/playlists/${encodeURIComponent(id)}/songs/${encodeURIComponent(ref)}`, { clientErrors: true })).data;
  }

  async movePlaylistSong(id, entryId, position) {
    return (await this.request('POST', `/api/playlists/${encodeURIComponent(id)}/songs/${encodeURIComponent(entryId)}/move`, { json: { position }, clientErrors: true })).data;
  }

  async requests({ status } = {}) {
    const { data } = await this.request('GET', '/api/requests', { query: { status } });
    return data?.requests || [];
  }

  async dismissRequest(id) {
    const { data } = await this.request('POST', `/api/requests/${encodeURIComponent(id)}/dismiss`);
    return data;
  }
}

module.exports = { ApiClient, ApiError, fileBlob };
