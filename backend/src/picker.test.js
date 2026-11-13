// The "pick the video" step: picker.js with fakes (cache, library marking,
// bad input), the resolver's chosen videos, and against the real server on
// Postgres (testcontainers) with a stand-in yt-dlp and oEmbed:
//   - POST /api/jobs/picks: who may ask, shapes, cache, rate limit
//   - POST /api/jobs { picks } and socket queue:add { picks }: the chosen video
//     is what the job / request carries, and what a worker is sent
//   - both without picks: exactly what they did before
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { cookieFor, startServer, requester } = require('./testServer');
const { createPicker, cleanPicks, MAX_PICKS, SEARCH_COUNT } = require('./picker');
const { createResolver } = require('./songResolver');
const { parseSpotifyUrl } = require('./spotify');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : typeof WebSocket !== 'function' ? 'no global WebSocket (Node >= 22)' : false;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(25);
  }
}

const vid = (n) => `video${String(n).padStart(6, '0')}`;
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

describe('picker (fakes)', () => {
  const librarySong = { id: '11111111-1111-4111-8111-111111111111', youtube_id: vid(3), title: 'In Library', artist: 'Band' };

  function make(over = {}) {
    const calls = { search: [], playlist: [], preview: [], spotify: [], oembed: [] };
    let clock = 1000;
    const songs = over.songs || [librarySong];
    const library = {
      isYoutubeId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v),
      getByYoutubeId: async (id) => songs.find((s) => s.youtube_id === id) || null,
      getByYoutubeIds: async (ids) => new Map(songs.filter((s) => ids.includes(s.youtube_id)).map((s) => [s.youtube_id, s])),
      findBestTextMatch: async () => null,
      findByTitleArtist: async () => null,
      toPublic: (s) => ({ id: s.id, title: s.title }),
      ...over.library,
    };
    const ytdlp = {
      searchYoutubeMany: async (query, count) => {
        calls.search.push([query, count]);
        return [1, 2, 3, 4, 5].map((n) => ({ id: vid(n), title: `Hit ${n}`, duration: 100 + n, channel: 'Ch' }));
      },
      getPlaylistEntries: async (url) => { calls.playlist.push(url); return [7, 3, 8].map((n) => ({ id: vid(n), title: `Entry ${n}`, duration: 0, channel: null })); },
      previewVideo: async (id) => { calls.preview.push(id); return { title: 'Previewed', channel: 'Chan', duration_sec: 61 }; },
      getOembed: async (id) => { calls.oembed.push(id); return { title: `Oembed ${id}`, channel: 'Chan' }; },
      ...over.ytdlp,
    };
    const spotify = { parseSpotifyUrl, getTrack: async (url) => { calls.spotify.push(url); return { name: 'Song', artist: 'Band' }; }, ...over.spotify };
    const picker = createPicker({ library, ytdlp, spotify, cacheMs: 1000, now: () => clock });
    return { picker, calls, advance: (ms) => { clock += ms; } };
  }

  it('search text: the first results, the library\'s marked', async () => {
    const { picker, calls } = make();
    const r = await picker.lookup('  some   song ');
    assert.equal(r.kind, 'search');
    assert.equal(r.query, 'some song');
    assert.deepEqual(calls.search, [['some song', SEARCH_COUNT]]);
    assert.equal(r.results.length, 5);
    assert.deepEqual(r.results[0], { youtube_id: vid(1), title: 'Hit 1', channel: 'Ch', duration_sec: 101, in_library: null });
    assert.deepEqual(r.results[2].in_library, { id: librarySong.id, title: 'In Library', artist: 'Band' });
  });

  it('the same search does not go to YouTube again until the cache expires', async () => {
    const { picker, calls, advance } = make();
    await picker.lookup('Some Song');
    await picker.lookup('some song');
    await picker.search('SOME SONG');
    assert.equal(calls.search.length, 1);
    advance(999);
    await picker.lookup('some song');
    assert.equal(calls.search.length, 1);
    advance(2);
    await picker.lookup('some song');
    assert.equal(calls.search.length, 2);
  });

  it('two lookups at once share one search', async () => {
    const { picker, calls } = make();
    await Promise.all([picker.lookup('twice'), picker.lookup('twice')]);
    assert.equal(calls.search.length, 1);
  });

  it('library marking is fresh on every answer, also from the cache', async () => {
    const songs = [];
    const { picker } = make({ songs });
    assert.equal((await picker.lookup('x')).results[0].in_library, null);
    songs.push({ id: 'new', youtube_id: vid(1), title: 'Now here', artist: '' });
    assert.deepEqual((await picker.lookup('x')).results[0].in_library, { id: 'new', title: 'Now here', artist: null });
  });

  it('a failed search is a 502 and is not kept', async () => {
    let fail = true;
    const { picker } = make({ ytdlp: { searchYoutubeMany: async () => { if (fail) throw new Error('bot check'); return []; } } });
    await assert.rejects(picker.lookup('x'), (err) => err.status === 502 && err.code === 'LOOKUP_FAILED' && /bot check/.test(err.message));
    fail = false;
    assert.deepEqual(await picker.lookup('x'), { kind: 'search', query: 'x', results: [] });
  });

  it('bad input is a 400', async () => {
    const { picker, calls } = make();
    for (const input of ['', '   ', null, 'https://soundcloud.com/a/b', 'https://open.spotify.com/album/x', 'x'.repeat(501)]) {
      await assert.rejects(picker.lookup(input), (err) => err.status === 400 && err.code === 'BAD_INPUT', String(input).slice(0, 30));
    }
    for (const query of ['', '  ', undefined, 42, 'x'.repeat(501)]) {
      await assert.rejects(picker.search(query), (err) => err.status === 400 && err.code === 'BAD_INPUT');
    }
    assert.equal(calls.search.length, 0);
  });

  it('a video link: that one video; the library\'s own is the answer', async () => {
    const { picker, calls } = make();
    const r = await picker.lookup(`https://youtu.be/${vid(9)}?t=3`);
    assert.deepEqual(r, { kind: 'video', results: [{ youtube_id: vid(9), title: 'Previewed', channel: 'Chan', duration_sec: 61, in_library: null }] });
    await picker.lookup(watch(vid(9)));
    assert.deepEqual(calls.preview, [vid(9)], 'looked up once');
    assert.deepEqual(await picker.lookup(watch(vid(3))), { kind: 'library', song: { id: librarySong.id, title: 'In Library' } });
  });

  it('a video that cannot be looked up is still offered, and asked again next time', async () => {
    const { picker, calls } = make({ ytdlp: { previewVideo: async (id) => { calls.preview.push(id); return null; } } });
    const r = await picker.lookup(watch(vid(9)));
    assert.deepEqual(r.results, [{ youtube_id: vid(9), title: null, channel: null, duration_sec: null, in_library: null }]);
    await picker.lookup(watch(vid(9)));
    assert.equal(calls.preview.length, 2);
    assert.equal(picker.known(vid(9)), null);
  });

  it('a playlist link: its videos, capped, with the total', async () => {
    const many = Array.from({ length: MAX_PICKS + 20 }, (_, i) => ({ id: vid(i), title: `E${i}`, duration: 10 }));
    const { picker, calls } = make({ ytdlp: { getPlaylistEntries: async (url) => { calls.playlist.push(url); return many; } } });
    const r = await picker.lookup('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc');
    assert.equal(r.kind, 'playlist');
    assert.equal(r.total, MAX_PICKS + 20);
    assert.equal(r.results.length, MAX_PICKS);
    assert.equal(r.results[3].in_library.id, librarySong.id);
    await picker.lookup('https://www.youtube.com/playlist?list=PLabc');
    assert.deepEqual(calls.playlist, ['https://www.youtube.com/playlist?list=PLabc']);
    assert.equal(picker.known(vid(MAX_PICKS - 1)).title, `E${MAX_PICKS - 1}`);
    assert.equal(picker.known(vid(MAX_PICKS)), null, 'what cannot be picked is not remembered');
  });

  it('a Spotify track is a search for "artist - title"', async () => {
    const { picker, calls } = make();
    const r = await picker.lookup('https://open.spotify.com/track/abc');
    assert.equal(r.kind, 'search');
    assert.equal(r.query, 'Band - Song');
    assert.deepEqual(calls.search, [['Band - Song', SEARCH_COUNT]]);
    const broken = make({ spotify: { getTrack: async () => { throw new Error('gone'); } } });
    await assert.rejects(broken.picker.lookup('https://open.spotify.com/track/abc'), (err) => err.status === 400 && /Spotify/.test(err.message));
  });

  it('search() is always a search, whatever the text looks like', async () => {
    const { picker, calls } = make();
    const r = await picker.search(watch(vid(3)));
    assert.equal(r.kind, 'search');
    assert.deepEqual(calls.search, [[watch(vid(3)), SEARCH_COUNT]]);
    assert.equal(calls.preview.length, 0);
  });

  describe('matchLibrary (a playlist\'s add-song box)', () => {
    it('the top hit in the library is the answer; a lower one is only marked', async () => {
      const top = make({ songs: [{ ...librarySong, youtube_id: vid(1) }] });
      assert.equal((await top.picker.lookup('x', { matchLibrary: true })).kind, 'library');
      assert.equal((await top.picker.lookup('x')).kind, 'search', 'the Download box still asks');
      const third = make();
      assert.equal((await third.picker.lookup('x', { matchLibrary: true })).kind, 'search');
    });
    it('then a library text match, also when the search failed', async () => {
      const m = make({ library: { findBestTextMatch: async () => librarySong } });
      assert.deepEqual(await m.picker.lookup('in lib', { matchLibrary: true }), { kind: 'library', song: { id: librarySong.id, title: 'In Library' } });
      const failing = make({ library: { findBestTextMatch: async () => librarySong }, ytdlp: { searchYoutubeMany: async () => { throw new Error('x'); } } });
      assert.equal((await failing.picker.lookup('in lib', { matchLibrary: true })).kind, 'library');
    });
    it('a Spotify track the library has by title and artist', async () => {
      const m = make({ library: { findByTitleArtist: async (title, artist) => (title === 'Song' && artist === 'Band' ? librarySong : null) } });
      assert.equal((await m.picker.lookup('https://open.spotify.com/track/abc', { matchLibrary: true })).kind, 'library');
      assert.equal(m.calls.search.length, 0);
      assert.equal((await m.picker.lookup('https://open.spotify.com/track/abc')).kind, 'search');
    });
  });

  it('remembers what it said about each video', async () => {
    const { picker } = make();
    assert.equal(picker.known(vid(2)), null);
    await picker.lookup('x');
    assert.deepEqual(picker.known(vid(2)), { title: 'Hit 2', channel: 'Ch', duration_sec: 102 });
  });
});

describe('picker.titles (chosen videos)', () => {
  const fake = (getOembed) => createPicker({
    library: { getByYoutubeIds: async () => new Map() },
    ytdlp: { searchYoutubeMany: async () => [{ id: vid(1), title: 'Looked up', duration: 10 }], getOembed },
    spotify: { parseSpotifyUrl },
  });

  it('what a lookup said, without asking anyone', async () => {
    const picker = fake(async () => { throw new Error('not needed'); });
    await picker.search('x');
    assert.deepEqual([...await picker.titles([vid(1), vid(1)])], [[vid(1), 'Looked up']]);
  });
  it('a video it no longer knows gets its title from oEmbed, and is remembered', async () => {
    const asked = [];
    const picker = fake(async (id) => { asked.push(id); return id === vid(3) ? null : { title: `Oembed ${id}`, channel: 'C' }; });
    await picker.search('x');
    const titles = await picker.titles([vid(1), vid(2), vid(3)]);
    assert.deepEqual([...titles], [[vid(1), 'Looked up'], [vid(2), `Oembed ${vid(2)}`]]);
    assert.deepEqual(asked, [vid(2), vid(3)]);
    await picker.titles([vid(2)]);
    assert.deepEqual(asked, [vid(2), vid(3)], 'asked once');
  });
  it('asks a few at a time', async () => {
    let running = 0;
    let most = 0;
    const picker = fake(async (id) => { most = Math.max(most, ++running); await tick(5); running--; return { title: id }; });
    const titles = await picker.titles(Array.from({ length: 20 }, (_, i) => vid(100 + i)), { concurrency: 3 });
    assert.equal(titles.size, 20);
    assert.equal(most, 3);
  });
  it('gives up when the budget is spent: the rest has no title', async () => {
    let asked = 0;
    const picker = fake(async (id) => { asked++; if (id === vid(200)) return { title: 'Quick' }; await tick(400); return { title: 'Late' }; });
    const started = Date.now();
    const titles = await picker.titles([vid(200), vid(201), vid(202), vid(203)], { concurrency: 1, budgetMs: 60 });
    assert.ok(Date.now() - started < 350, 'did not wait for the slow one');
    assert.deepEqual([...titles], [[vid(200), 'Quick']]);
    await tick(450);
    assert.equal(asked, 2, 'nothing more is asked after giving up');
  });
  it('a failing oEmbed is no title, not an error', async () => {
    const picker = fake(async () => { throw new Error('down'); });
    assert.equal((await picker.titles([vid(5)])).size, 0);
  });
});

describe('cleanPicks', () => {
  it('takes 1 to MAX_PICKS video ids, each once', () => {
    assert.deepEqual(cleanPicks([vid(1)]), [vid(1)]);
    assert.deepEqual(cleanPicks([vid(1), vid(2), vid(1)]), [vid(1), vid(2)]);
    assert.equal(cleanPicks(Array.from({ length: MAX_PICKS }, (_, i) => vid(i))).length, MAX_PICKS);
  });
  it('refuses anything else', () => {
    for (const bad of [null, undefined, '', vid(1), {}, [], [vid(1), 'short'], [42], [null], [`${vid(1)}x`], [watch(vid(1))],
      Array.from({ length: MAX_PICKS + 1 }, (_, i) => vid(i))]) {
      assert.equal(cleanPicks(bad), null, String(JSON.stringify(bad)).slice(0, 40));
    }
  });
});

describe('songResolver: chosen videos', () => {
  const song = { id: 's1', youtube_id: vid(1), title: 'Have it' };
  const resolver = (over = {}) => createResolver({
    library: { getByYoutubeId: async (id) => (id === vid(1) ? song : null), youtubeUrl: watch },
    ytdlp: {
      getOembed: async () => ({ title: 'From oEmbed' }),
      searchYoutube: async () => { throw new Error('a chosen video is never searched for'); },
      getPlaylistEntries: async () => { throw new Error('no listing'); },
    },
    spotify: { parseSpotifyUrl },
    ...over,
  });

  const titled = (map) => async (ids) => new Map(ids.filter((id) => map[id]).map((id) => [id, map[id]]));

  it('one video: the library song, or a request for exactly it', async () => {
    assert.deepEqual(await resolver().resolve({ picks: [vid(1)] }), { type: 'library', song });
    assert.deepEqual(await resolver({ videoTitles: titled({ [vid(2)]: 'Server title' }) }).resolve({ picks: [vid(2)] }),
      { type: 'request', request: { youtubeId: vid(2), url: watch(vid(2)), title: 'Server title', artist: null } });
  });
  it('titles are asked only for videos the library does not have', async () => {
    const asked = [];
    await resolver({ videoTitles: async (ids) => { asked.push(...ids); return new Map(); } }).resolve({ picks: [vid(1), vid(2)] });
    assert.deepEqual(asked, [vid(2)]);
  });
  it('several: answered like a playlist, in order; a title nobody has stays empty', async () => {
    const r = await resolver({ videoTitles: titled({ [vid(3)]: 'Three' }) }).resolve({ picks: [vid(2), vid(1), vid(3)] });
    assert.equal(r.type, 'playlist');
    assert.equal(r.total, 3);
    assert.deepEqual(r.items.map((x) => x.type), ['request', 'library', 'request']);
    assert.deepEqual(r.items[0].request, { youtubeId: vid(2), url: watch(vid(2)), title: null, artist: null });
    assert.equal(r.items[2].request.title, 'Three');
  });
});

describe('pick the video on Postgres', { skip, timeout: 240_000 }, () => {
  let container;
  let dbUrl;
  let pg;
  let srv;
  let req;
  let tmp;
  let stubDir;
  let callLog;
  const ids = {};
  const cookies = {};
  const playlists = {};
  const workers = [];
  const sockets = [];
  let token;
  let librarySong;

  // The stand-in yt-dlp: "ytsearchN:<query>" gives N results r<query hash>…,
  // "none…" nothing, "fail…" an error, "libfirst…" the library's video first,
  // an id starting with "known" itself; a playlist gives three videos.
  const STUB = `#!${process.execPath}
const fs = require('fs');
const target = process.argv[process.argv.length - 1];
fs.appendFileSync(${JSON.stringify('__LOG__')}, target + '\\n');
const out = (entries) => process.stdout.write(JSON.stringify({ entries }));
const m = /^ytsearch(\\d+):(.*)$/.exec(target);
if (!m) {
  if (!/list=PLtest/.test(target)) process.exit(1);
  out(['listvideo01', 'inlibrary01', 'listvideo03'].map((id, i) => ({ id, title: 'Entry ' + (i + 1), duration: 100 + i, channel: 'List Ch' })));
} else {
  const n = Number(m[1]);
  const q = m[2];
  if (/^fail/.test(q)) { process.stderr.write('ERROR: Sign in to confirm you are not a bot'); process.exit(1); }
  if (/^none/.test(q)) out([]);
  else if (/^known[A-Za-z0-9_-]{6}$/.test(q)) out([{ id: q, title: 'Search ' + q, duration: 60, channel: 'Ch' }]);
  else {
    const tag = q.replace(/[^a-z]/gi, '').toLowerCase().slice(0, 4).padEnd(4, 'x');
    const all = [1, 2, 3, 4, 5].map((i) => ({ id: 'result' + tag + i, title: 'Result ' + i + ' for ' + q, duration: 200 + i, channel: 'Channel ' + i }));
    if (/^libfirst/.test(q)) all.unshift({ id: 'inlibrary01', title: 'The one we have', duration: 180, channel: 'Ch' });
    out(all.slice(0, n));
  }
}
`;

  const ytCalls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter((line) => line && line !== '--version') : []);
  const picks = (who, body) => req('POST', '/api/jobs/picks', { cookie: who ? cookies[who] : undefined, body });
  const createJobs = (who, body) => req('POST', '/api/jobs', { cookie: cookies[who], body });

  async function boot() {
    srv = await startServer({
      DATABASE_URL: dbUrl, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      WORKER_HEARTBEAT_MS: '60000', WORKER_OUTDATED_NUDGE_MS: '0',
      PATH: `${stubDir}:${process.env.PATH}`, NODE_OPTIONS: `--require ${path.join(stubDir, 'oembed-stub.cjs')}`,
    });
    req = requester(srv.base);
  }

  function connectWorker(name) {
    const ws = new WebSocket(srv.base.replace(/^http/, 'ws') + '/api/workers/connect');
    const w = { ws, name, jobs: [], closed: null };
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'job') w.jobs.push(msg.job);
      if (msg.type === 'welcome') w.id = msg.worker.id;
    });
    ws.addEventListener('close', (ev) => { w.closed = ev.code; });
    // An old worker: la 0.2, no capabilities beyond the first protocol.
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      type: 'hello', protocol: 1, token, name, hostname: `${name}.lan`, platform: 'linux', arch: 'x64',
      cli_version: '0.2.0', node_version: '24.0.0', ytdlp_version: '2026.10.26',
    })));
    workers.push(w);
    return until(() => w.id && w, `${name} welcome`);
  }

  function socketFor(who) {
    const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: cookies[who] } });
    sockets.push(s);
    s.seen = [];
    s.onAny((event, data) => s.seen.push([event, data]));
    return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
  }
  const nextEvent = (s, names, from = 0) => until(() => s.seen.slice(from).find(([e]) => names.includes(e)), names.join('/'));
  async function joined(who, lobbyId) {
    const s = await socketFor(who);
    s.emit('lobby:join', { lobbyId, username: who });
    assert.equal((await nextEvent(s, ['lobby:joined', 'lobby:not-found', 'lobby:error']))[0], 'lobby:joined');
    return s;
  }
  const requestsFor = async (lobbyId) => (await pg.query('SELECT * FROM song_requests WHERE lobby_id = $1 ORDER BY created_at', [lobbyId])).rows;
  const jobRows = async (where, params) => (await pg.query(`SELECT * FROM download_jobs WHERE ${where} ORDER BY created_at, id`, params)).rows;
  const queueOf = async (who, id) => (await req('GET', `/api/playlists/${id}/songs`, { cookie: cookies[who] })).body.songs;

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_picks').withUsername('test').withPassword('test').start();
    dbUrl = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-picks-'));
    stubDir = path.join(tmp, 'stub');
    fs.mkdirSync(stubDir);
    callLog = path.join(tmp, 'yt-dlp-calls.log');
    fs.writeFileSync(path.join(stubDir, 'yt-dlp'), STUB.replace('__LOG__', callLog), { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, 'oembed-stub.cjs'), `
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://www.youtube.com/oembed')) {
    const id = decodeURIComponent(String(url)).split('v=')[1];
    if (!id.startsWith('known')) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ title: 'Oembed ' + id, author_name: 'Channel' }), { status: 200 });
  }
  if (/ytimg\\.com/.test(String(url))) return new Response('', { status: 404 });
  return real(url, opts);
};`);
    await boot();
    const { Client } = require('pg');
    pg = new Client({ connectionString: dbUrl });
    await pg.connect();
    for (const key of ['alice', 'bob', 'pending']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [key, key, key[0].toUpperCase() + key.slice(1), key === 'pending' ? 'pending' : 'approved']
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    const t = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'x' } });
    assert.equal(t.status, 201, t.text);
    token = t.body.token;
    for (const [key, who, visibility] of [['pub', 'alice', 'public'], ['priv', 'alice', 'private']]) {
      const r = await req('POST', '/api/playlists', { cookie: cookies[who], body: { name: key, visibility } });
      assert.equal(r.status, 201, r.text);
      playlists[key] = r.body.id;
    }
    librarySong = (await pg.query(
      `INSERT INTO library_songs (youtube_id, title, artist, duration_sec, file_path, sha256, uploaded_by)
       VALUES ('inlibrary01', 'Quokka Anthem', 'The Band', 180, '/nowhere/x.m4a', $1, 'test') RETURNING *`, ['a'.repeat(64)]
    )).rows[0];
  });

  after(async () => {
    for (const s of sockets) s.close();
    for (const w of workers) { try { w.ws.close(); } catch {} }
    if (pg) await pg.end().catch(() => {});
    if (srv) await srv.stop();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('POST /api/jobs/picks', () => {
    it('is for approved web accounts only', async () => {
      assert.equal((await picks(null, { input: 'a song' })).status, 401);
      const pending = await picks('pending', { input: 'a song' });
      assert.equal(pending.status, 403);
      assert.equal(pending.body.code, 'ACCOUNT_PENDING');
      const cli = await req('POST', '/api/jobs/picks', { headers: { authorization: `Bearer ${token}` }, body: { input: 'a song' } });
      assert.equal(cli.status, 401, 'a CLI token is not a web account');
      assert.equal(ytCalls().length, 0, 'nothing was looked up');
    });

    it('search text: five results with title, channel and length', async () => {
      const r = await picks('alice', { input: 'alpha song' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.kind, 'search');
      assert.equal(r.body.query, 'alpha song');
      assert.equal(r.body.results.length, 5);
      assert.deepEqual(r.body.results[0], { youtube_id: 'resultalph1', title: 'Result 1 for alpha song', channel: 'Channel 1', duration_sec: 201, in_library: null });
      assert.deepEqual(ytCalls(), ['ytsearch5:alpha song']);
    });

    it('the same search again, by anyone, does not reach YouTube', async () => {
      const before = ytCalls().length;
      assert.equal((await picks('alice', { input: 'alpha song' })).body.results.length, 5);
      assert.equal((await picks('bob', { input: '  ALPHA   song ' })).body.results.length, 5);
      assert.equal((await picks('bob', { query: 'Alpha Song' })).body.results.length, 5);
      assert.equal(ytCalls().length, before);
    });

    it('marks a result the library already has', async () => {
      const r = await picks('alice', { input: 'libfirst tune' });
      assert.equal(r.body.kind, 'search', 'the Download box asks even then');
      assert.deepEqual(r.body.results[0].in_library, { id: librarySong.id, title: 'Quokka Anthem', artist: 'The Band' });
      assert.equal(r.body.results[1].in_library, null);
    });

    it('match_library: what the library has is the answer, no dialog', async () => {
      const top = await picks('alice', { input: 'libfirst tune', match_library: true });
      assert.equal(top.body.kind, 'library');
      assert.equal(top.body.song.id, librarySong.id);
      const text = await picks('alice', { input: 'quokka', match_library: true });
      assert.equal(text.body.kind, 'library', 'a library text match');
      assert.equal(text.body.song.id, librarySong.id);
      assert.equal((await picks('alice', { input: 'quokka' })).body.kind, 'search');
      assert.equal((await picks('alice', { input: 'beta song', match_library: true })).body.kind, 'search');
    });

    it('a video link: that one video; the library\'s own short-circuits', async () => {
      const r = await picks('alice', { input: 'https://youtu.be/knownvid001' });
      assert.deepEqual(r.body, { kind: 'video', results: [{ youtube_id: 'knownvid001', title: 'Oembed knownvid001', channel: 'Channel', duration_sec: 60, in_library: null }] });
      const unknown = await picks('alice', { input: 'https://www.youtube.com/watch?v=failvideo01' });
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.body.results, [{ youtube_id: 'failvideo01', title: null, channel: null, duration_sec: null, in_library: null }]);
      const have = await picks('alice', { input: 'https://www.youtube.com/watch?v=inlibrary01' });
      assert.equal(have.body.kind, 'library');
      assert.equal(have.body.song.id, librarySong.id);
    });

    it('a playlist link: its videos, listed once', async () => {
      const calls = ytCalls().length;
      const r = await picks('alice', { input: 'https://www.youtube.com/playlist?list=PLtest1' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.kind, 'playlist');
      assert.equal(r.body.total, 3);
      assert.deepEqual(r.body.results.map((v) => v.youtube_id), ['listvideo01', 'inlibrary01', 'listvideo03']);
      assert.equal(r.body.results[1].in_library.id, librarySong.id);
      assert.equal(r.body.results[0].channel, 'List Ch');
      await picks('alice', { input: 'https://www.youtube.com/watch?v=knownvid001&list=PLtest1' });
      assert.deepEqual(ytCalls().slice(calls), ['https://www.youtube.com/playlist?list=PLtest1'], 'one listing, no search per video');
    });

    it('query is always a search (a playlist item\'s other versions)', async () => {
      const r = await picks('alice', { query: 'Entry 1' });
      assert.equal(r.body.kind, 'search');
      assert.equal(r.body.results.length, 5);
      assert.equal((await picks('alice', { query: 'https://youtu.be/knownvid001' })).body.kind, 'search');
    });

    it('no results, bad input, a failing search', async () => {
      const none = await picks('alice', { input: 'none of this' });
      assert.equal(none.status, 200);
      assert.deepEqual(none.body.results, []);
      for (const body of [{}, { input: '' }, { input: 42 }, { input: 'https://soundcloud.com/a/b' }, { query: '' }, { query: ['x'] }, { input: 'x'.repeat(600) }]) {
        const r = await picks('alice', body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
        assert.equal(r.body.code, 'BAD_INPUT');
      }
      const before = ytCalls().length;
      const failed = await picks('alice', { input: 'fail please' });
      assert.equal(failed.status, 502);
      assert.equal(failed.body.code, 'LOOKUP_FAILED');
      assert.match(failed.body.error, /search failed/);
      assert.equal((await picks('alice', { input: 'fail please' })).status, 502);
      assert.equal(ytCalls().length, before + 2, 'a failure is not cached');
    });
  });

  describe('POST /api/jobs', () => {
    it('picks: a video job for exactly the chosen video, with the server\'s title', async () => {
      const worker = await connectWorker('old-worker');
      const r = await createJobs('alice', { picks: ['resultalph3'], title: 'Client title', input: 'ignored' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.jobs.length, 1);
      assert.deepEqual(r.body.existing, []);
      const job = r.body.jobs[0];
      assert.equal(job.kind, 'video');
      assert.equal(job.source, 'web');
      assert.equal(job.input, watch('resultalph3'));
      assert.equal(job.title, 'Result 3 for alpha song');
      const sent = await until(() => worker.jobs.find((j) => j.id === job.id), 'the job at the worker');
      assert.equal(sent.kind, 'video');
      assert.equal(sent.input, watch('resultalph3'));
      assert.equal(sent.no_playlist, true);
      worker.ws.close();
      await until(async () => (await req('GET', '/api/workers', { cookie: cookies.alice })).body.online === 0, 'no workers online');
    });

    it('picks: a video the server never looked up still works; no title when oEmbed has none either', async () => {
      const r = await createJobs('alice', { picks: ['neverseen01'] });
      assert.equal(r.status, 201);
      assert.equal(r.body.jobs[0].input, watch('neverseen01'));
      assert.equal(r.body.jobs[0].title, null);
    });

    it('picks: a failure part way keeps and dispatches what was queued, and names the rest', async () => {
      await pg.query(`CREATE FUNCTION refuse_job() RETURNS trigger AS $$ BEGIN
        IF NEW.input LIKE '%refuseme002%' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await pg.query('CREATE TRIGGER refuse_job BEFORE INSERT ON download_jobs FOR EACH ROW EXECUTE FUNCTION refuse_job()');
      // An idle worker with nothing else waiting: it gets the job only if this request dispatches.
      await pg.query("UPDATE download_jobs SET status = 'cancelled' WHERE status = 'queued'");
      const worker = await connectWorker('part-way-worker');
      try {
        const r = await createJobs('alice', { picks: ['refuseme001', 'inlibrary01', 'refuseme002', 'refuseme003'] });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual(r.body.jobs.map((j) => j.input), [watch('refuseme001')]);
        assert.deepEqual(r.body.existing.map((s) => s.id), [librarySong.id]);
        assert.deepEqual(r.body.failed, ['refuseme002', 'refuseme003']);
        assert.match(r.body.error, /2 of 4 could not be queued/);
        const sent = await until(() => worker.jobs.find((j) => j.id === r.body.jobs[0].id), 'the queued job at the worker');
        assert.equal(sent.input, watch('refuseme001'));
        assert.deepEqual((await jobRows("input LIKE '%refuseme%'", [])).map((j) => j.input), [watch('refuseme001')]);
        // Nothing at all could be queued: a plain failure, safe to retry whole.
        const none = await createJobs('alice', { picks: ['refuseme002'] });
        assert.equal(none.status, 500);
        assert.equal(none.body.jobs, undefined);
      } finally {
        await pg.query('DROP TRIGGER refuse_job ON download_jobs');
        await pg.query('DROP FUNCTION refuse_job()');
        worker.ws.close();
        await until(async () => (await req('GET', '/api/workers', { cookie: cookies.alice })).body.online === 0, 'no workers online');
      }
    });

    it('picks: a video that already has a waiting job gets another one (no dedupe, as for pasted links)', async () => {
      const first = await createJobs('alice', { picks: ['twicevideo1'] });
      const second = await createJobs('alice', { picks: ['twicevideo1'] });
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.notEqual(first.body.jobs[0].id, second.body.jobs[0].id);
      const rows = await jobRows('input = $1', [watch('twicevideo1')]);
      assert.deepEqual(rows.map((j) => j.status), ['queued', 'queued']);
      const pasted = await createJobs('alice', { input: watch('twicevideo1') });
      assert.equal(pasted.status, 201, 'the same without picks');
    });

    it('picks: several videos are one job each; the library\'s go straight to the playlist', async () => {
      const r = await createJobs('alice', { picks: ['listvideo01', 'inlibrary01', 'listvideo03', 'listvideo01'], playlist_id: playlists.priv });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(r.body.jobs.map((j) => [j.kind, j.input, j.title, j.playlist_id]), [
        ['video', watch('listvideo01'), 'Entry 1', playlists.priv],
        ['video', watch('listvideo03'), 'Entry 3', playlists.priv],
      ]);
      assert.deepEqual(r.body.existing.map((s) => s.id), [librarySong.id]);
      assert.equal(r.body.added_to_playlist, 1);
      assert.equal(r.body.playlist_id, playlists.priv);
      assert.deepEqual((await queueOf('alice', playlists.priv)).map((s) => s.library_id), [librarySong.id]);
      const only = await createJobs('alice', { picks: ['inlibrary01'] });
      assert.equal(only.status, 200, 'nothing to download');
      assert.deepEqual(only.body.jobs, []);
      assert.equal(only.body.added_to_playlist, 0);
    });

    it('picks: someone else\'s private playlist does not exist', async () => {
      const before = (await jobRows('requested_by_user_id = $1', [ids.bob])).length;
      const r = await createJobs('bob', { picks: ['resultalph1'], playlist_id: playlists.priv });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, 'PLAYLIST_NOT_FOUND');
      assert.equal((await jobRows('requested_by_user_id = $1', [ids.bob])).length, before);
    });

    it('picks: anything but 1 to 100 video ids is refused, and nothing is queued', async () => {
      const before = (await jobRows('TRUE', [])).length;
      for (const bad of [[], 'resultalph1', ['short'], [watch('resultalph1')], [null], {}, null, Array.from({ length: MAX_PICKS + 1 }, (_, i) => vid(i))]) {
        const r = await createJobs('alice', { picks: bad, input: 'a perfectly fine search' });
        assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
        assert.equal(r.body.code, 'BAD_INPUT');
      }
      assert.equal((await jobRows('TRUE', [])).length, before);
    });

    it('without picks: as before, the text goes to the downloader', async () => {
      const calls = ytCalls().length;
      const search = await createJobs('alice', { input: 'gamma  song' });
      assert.equal(search.status, 201);
      assert.equal(search.body.jobs, undefined);
      assert.equal(search.body.job.kind, 'search');
      assert.equal(search.body.job.input, 'gamma song');
      assert.equal(search.body.job.title, 'gamma song');
      const list = await createJobs('alice', { input: 'https://www.youtube.com/playlist?list=PLtest1' });
      assert.equal(list.body.job.kind, 'playlist');
      assert.equal(list.body.job.input, 'https://www.youtube.com/playlist?list=PLtest1');
      const video = await createJobs('alice', { input: 'https://youtu.be/knownvid002' });
      assert.equal(video.body.job.kind, 'video');
      assert.equal(video.body.job.title, null);
      const have = await createJobs('alice', { input: 'https://youtu.be/inlibrary01' });
      assert.equal(have.status, 200);
      assert.equal(have.body.job, null);
      assert.equal(have.body.existing.id, librarySong.id);
      assert.equal(ytCalls().length, calls, 'the server looks nothing up');
    });
  });

  describe('socket queue:add', () => {
    it('picks: a request (and its job) for exactly the chosen video', async () => {
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, picks: ['resultalph4'], title: 'Client title', query: 'ignored', addedBy: 'Mallory' });
      const [, data] = await nextEvent(s, ['queue:requested', 'queue:error'], from);
      assert.equal(data.created, true, JSON.stringify(data));
      assert.equal(data.request.youtube_id, 'resultalph4');
      assert.equal(data.request.title, 'Result 4 for alpha song', 'the server\'s own title');
      assert.equal(data.request.requested_by, 'Alice');
      assert.equal(s.seen.slice(from).some(([e]) => e === 'queue:adding'), false, 'nothing was looked up');
      const rows = await requestsFor(playlists.pub);
      assert.deepEqual(rows.map((r) => [r.youtube_id, r.url]), [['resultalph4', watch('resultalph4')]]);
      const [job] = await until(async () => { const j = await jobRows('request_id = $1', [rows[0].id]); return j.length && j; }, 'the request job');
      assert.equal(job.kind, 'video');
      assert.equal(job.input, watch('resultalph4'));
      assert.equal(job.source, 'request');
    });

    it('picks: a video the library has is added right away', async () => {
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, picks: ['inlibrary01'] });
      const [, data] = await nextEvent(s, ['queue:update', 'queue:error', 'queue:requested'], from);
      assert.equal(data.songs.length, 1, JSON.stringify(data));
      assert.equal(data.songs[0].title.startsWith('Quokka Anthem'), true);
      assert.equal((await requestsFor(playlists.pub)).length, 1, 'no new request');
    });

    it('picks: several are answered like a playlist link', async () => {
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, picks: ['listvideo01', 'inlibrary01', 'listvideo03'] });
      const [, data] = await nextEvent(s, ['queue:adding', 'queue:error'], from);
      assert.match(data.status, /added 1 song, 2 not in the library yet \(requested\)/);
      const rows = await requestsFor(playlists.pub);
      assert.deepEqual(rows.map((r) => [r.youtube_id, r.title]).slice(1), [['listvideo01', 'Entry 1'], ['listvideo03', 'Entry 3']]);
      const jobs = await until(async () => { const j = await jobRows('request_id = ANY($1::uuid[])', [rows.slice(1).map((r) => r.id)]); return j.length === 2 && j; }, 'two request jobs');
      assert.deepEqual(jobs.map((j) => [j.kind, j.input]).sort(), [['video', watch('listvideo01')], ['video', watch('listvideo03')]]);
    });

    it('picks: a video with an open request in this playlist is not requested twice; another playlist gets its own', async () => {
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, picks: ['resultalph4'] });
      const [, data] = await nextEvent(s, ['queue:requested', 'queue:error'], from);
      assert.equal(data.created, false, JSON.stringify(data));
      assert.match(data.message, /already requested/);
      const mine = (await requestsFor(playlists.pub)).filter((r) => r.youtube_id === 'resultalph4');
      assert.equal(mine.length, 1);
      assert.equal((await jobRows('request_id = $1', [mine[0].id])).length, 1, 'no second job');

      const made = await req('POST', '/api/playlists', { cookie: cookies.alice, body: { name: 'other' } });
      assert.equal(made.status, 201, made.text);
      const p = await joined('alice', made.body.id);
      const fromP = p.seen.length;
      p.emit('queue:add', { lobbyId: made.body.id, picks: ['resultalph4'] });
      const [, other] = await nextEvent(p, ['queue:requested', 'queue:error'], fromP);
      assert.equal(other.created, true);
      const theirs = (await requestsFor(made.body.id)).filter((r) => r.youtube_id === 'resultalph4');
      assert.equal(theirs.length, 1);
      await until(async () => (await jobRows('request_id = $1', [theirs[0].id])).length === 1, 'its own job');
      assert.equal((await jobRows('input = $1 AND status = $2', [watch('resultalph4'), 'queued'])).length, 2, 'two waiting jobs for one video');
    });

    it('picks: a bad selection is refused; another user\'s private playlist does not exist', async () => {
      const s = await joined('alice', playlists.pub);
      const before = (await requestsFor(playlists.pub)).length;
      for (const bad of [[], ['short'], 'resultalph1', [watch('resultalph1')], Array.from({ length: MAX_PICKS + 1 }, (_, i) => vid(i))]) {
        const from = s.seen.length;
        s.emit('queue:add', { lobbyId: playlists.pub, picks: bad, query: 'delta song' });
        const [event, data] = await nextEvent(s, ['queue:error', 'queue:requested', 'queue:update'], from);
        assert.equal(event, 'queue:error', JSON.stringify(bad).slice(0, 40));
        assert.match(data.message, /selection/);
      }
      assert.equal((await requestsFor(playlists.pub)).length, before);

      const bob = await socketFor('bob');
      const from = bob.seen.length;
      bob.emit('queue:add', { lobbyId: playlists.priv, picks: ['resultalph5'] });
      const [event, data] = await nextEvent(bob, ['queue:error', 'queue:requested', 'queue:update'], from);
      assert.equal(event, 'queue:error');
      assert.equal(data.message, 'Playlist not found');
      assert.equal((await requestsFor(playlists.priv)).length, 0);
    });

    it('without picks: as before, the server takes the first result', async () => {
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, query: 'epsilon song' });
      const [, data] = await nextEvent(s, ['queue:requested', 'queue:error'], from);
      assert.equal(data.request.youtube_id, 'resultepsi1');
      assert.equal(data.request.title, 'Result 1 for epsilon song');
      assert.equal(s.seen.slice(from).some(([e, d]) => e === 'queue:adding' && /Looking it up/.test(d.status)), true);
      assert.ok(ytCalls().includes('ytsearch1:epsilon song'));
    });
  });

  describe('a chosen video the server no longer knows (restart between lookup and confirm)', () => {
    it('several picks get their titles from oEmbed, for jobs and for requests', async () => {
      await srv.stop();
      await boot();
      const r = await createJobs('alice', { picks: ['knownvid101', 'neverseen02', 'knownvid102'] });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(r.body.jobs.map((j) => [j.input, j.title]), [
        [watch('knownvid101'), 'Oembed knownvid101'], [watch('neverseen02'), null], [watch('knownvid102'), 'Oembed knownvid102'],
      ]);
      const s = await joined('alice', playlists.pub);
      const from = s.seen.length;
      s.emit('queue:add', { lobbyId: playlists.pub, picks: ['knownvid103', 'knownvid104'] });
      const [, data] = await nextEvent(s, ['queue:adding', 'queue:error'], from);
      assert.match(data.status, /2 not in the library yet \(requested\)/);
      const rows = (await requestsFor(playlists.pub)).filter((x) => /^knownvid10[34]$/.test(x.youtube_id));
      assert.deepEqual(rows.map((x) => [x.youtube_id, x.title]), [['knownvid103', 'Oembed knownvid103'], ['knownvid104', 'Oembed knownvid104']]);
    });
  });

  describe('rate limit', () => {
    it('30 lookups a minute per client, cached or not', async () => {
      await srv.stop();
      await boot();
      for (let i = 0; i < 30; i++) {
        const r = await picks('alice', { input: 'alpha song' });
        assert.equal(r.status, 200, `lookup ${i + 1}: ${r.text}`);
      }
      const r = await picks('alice', { input: 'alpha song' });
      assert.equal(r.status, 429);
      assert.match(r.body.error, /Too many searches/);
      assert.equal((await picks('bob', { query: 'alpha song' })).status, 429, 'the limit is per client address, not per account');
      assert.equal((await createJobs('alice', { picks: ['resultalph2'] })).status, 201, 'queuing is not held up');
    });
  });
});
