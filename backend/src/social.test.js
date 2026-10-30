// Global chat + people panel: the pure parts (chat.js, presence.js,
// frontend/chat-format.js), then the real server (in-memory storage, no
// Postgres) over Socket.IO with two signed-in users, a second tab, an
// anonymous client (refused) and an admin. Postgres persistence: social-pg.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { io: ioClient } = require('socket.io-client');
const chat = require('./chat');
const { createPresence, viewNowPlaying } = require('./presence');

const SECRET = 'social-test-secret';
const ADMIN_PASSWORD = 'social-test-admin-pw';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-000000000b0b';

function authCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `listen_auth=${payload}.${sig}`;
}

describe('chat: message text', () => {
  it('trims, normalises newlines and strips control and bidi characters', () => {
    assert.deepEqual(chat.normalizeText('  hi\r\nthere \u0007‮ '), { text: 'hi\nthere' });
    assert.deepEqual(chat.normalizeText('a\n\n\n\n\nb'), { text: 'a\n\nb' });
  });

  it('rejects empty, non-text and too-long messages', () => {
    assert.ok(chat.normalizeText('   ').error);
    assert.ok(chat.normalizeText(42).error);
    assert.ok(chat.normalizeText(undefined).error);
    assert.ok(chat.normalizeText('x'.repeat(chat.MAX_LENGTH + 1)).error);
    assert.equal(chat.normalizeText('x'.repeat(chat.MAX_LENGTH)).text.length, chat.MAX_LENGTH);
  });

  it('keeps HTML as plain text (rendering escapes it)', () => {
    assert.deepEqual(chat.normalizeText('<img src=x onerror=alert(1)>'), { text: '<img src=x onerror=alert(1)>' });
  });
});

describe('chat: rate limit', () => {
  it('allows `limit` messages per window per user, then refuses until the window passes', () => {
    let t = 1000;
    const rl = chat.createRateLimiter({ limit: 3, windowMs: 10_000, now: () => t });
    assert.equal(rl.hit('a'), true);
    assert.equal(rl.hit('a'), true);
    assert.equal(rl.hit('a'), true);
    assert.equal(rl.hit('a'), false);
    assert.equal(rl.hit('b'), true, 'other users have their own budget');
    t += 10_001;
    assert.equal(rl.hit('a'), true);
  });
});

describe('chat: in-memory store and keyset pagination', () => {
  it('pages newest first by id, oldest-first inside a page, with hasMore', async () => {
    const store = chat.createMemoryStore();
    for (let i = 1; i <= 120; i++) await store.add({ userId: ALICE, author: { name: 'Alice' }, text: `m${i}`, createdAt: i });

    const p1 = await store.page({});
    assert.equal(p1.messages.length, chat.PAGE_SIZE);
    assert.equal(p1.messages[0].text, 'm71');
    assert.equal(p1.messages.at(-1).text, 'm120');
    assert.equal(p1.hasMore, true);

    const p2 = await store.page({ before: p1.messages[0].id });
    assert.equal(p2.messages[0].text, 'm21');
    assert.equal(p2.messages.at(-1).text, 'm70');
    assert.equal(p2.hasMore, true);

    const p3 = await store.page({ before: p2.messages[0].id });
    assert.equal(p3.messages.length, 20);
    assert.equal(p3.messages[0].text, 'm1');
    assert.equal(p3.hasMore, false);
  });

  it('is stable when messages arrive or are deleted between pages', async () => {
    const store = chat.createMemoryStore();
    for (let i = 1; i <= 10; i++) await store.add({ userId: ALICE, text: `m${i}` });
    const p1 = await store.page({ limit: 4 });
    assert.deepEqual(p1.messages.map(m => m.text), ['m7', 'm8', 'm9', 'm10']);
    await store.add({ userId: BOB, text: 'new' });
    assert.equal(await store.remove(p1.messages[0].id - 1), true); // m6
    const p2 = await store.page({ before: p1.messages[0].id, limit: 4 });
    assert.deepEqual(p2.messages.map(m => m.text), ['m2', 'm3', 'm4', 'm5']);
    assert.equal(await store.remove(9999), false);
  });

  it('caps the page size and ignores junk cursors', async () => {
    const store = chat.createMemoryStore();
    for (let i = 1; i <= 150; i++) await store.add({ userId: ALICE, text: `m${i}` });
    assert.equal((await store.page({ limit: 1000 })).messages.length, chat.MAX_PAGE_SIZE);
    assert.equal((await store.page({ before: 'drop table' })).messages.at(-1).text, 'm150');
    assert.equal(chat.parseCursor('-3'), null);
    assert.equal(chat.parseCursor('12'), 12);
  });
});

describe('chat-format (frontend): escaping and links', () => {
  let fmt;
  before(async () => {
    fmt = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'chat-format.js')).href);
  });

  it('escapes HTML so nothing can be injected', () => {
    const html = fmt.formatMessageHtml('<script>alert("x")</script> & <img src=x onerror=alert(1)>');
    assert.equal(html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;');
    assert.ok(!/<(?!\/?a[ >])/.test(html));
  });

  it('auto-links http(s) URLs safely, leaving trailing punctuation out', () => {
    const html = fmt.formatMessageHtml('see https://example.com/a?b=1&c=2. ok');
    assert.equal(html, 'see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1&amp;c=2</a>. ok');
  });

  it('never links javascript: or data: URLs and cannot break out of the attribute', () => {
    assert.equal(fmt.formatMessageHtml('javascript:alert(1)'), 'javascript:alert(1)');
    assert.equal(fmt.formatMessageHtml('data:text/html,<b>x</b>'), 'data:text/html,&lt;b&gt;x&lt;/b&gt;');
    const html = fmt.formatMessageHtml('https://x.test/"onmouseover="alert(1)');
    assert.ok(!html.includes('"onmouseover'));
  });

  it('groups people: online (playing first) and offline (recently seen first)', () => {
    const g = fmt.groupPeople([
      { id: 1, name: 'zed', online: true },
      { id: 2, name: 'amy', online: true },
      { id: 3, name: 'bob', online: true, nowPlaying: { track: { title: 't' } } },
      { id: 4, name: 'old', online: false, lastSeen: 10 },
      { id: 5, name: 'new', online: false, lastSeen: 20 },
    ]);
    assert.deepEqual(g.online.map(p => p.id), [3, 2, 1]);
    assert.deepEqual(g.offline.map(p => p.id), [5, 4]);
  });

  it('formats last seen', () => {
    const now = 10 * 86_400_000;
    assert.equal(fmt.formatLastSeen(now - 10_000, now), 'just now');
    assert.equal(fmt.formatLastSeen(now - 5 * 60_000, now), '5m ago');
    assert.equal(fmt.formatLastSeen(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(fmt.formatLastSeen(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(fmt.formatLastSeen(null, now), '');
  });
});

describe('presence: online / offline with several sockets', () => {
  it('counts a user once however many sockets they have', () => {
    let t = 100;
    const p = createPresence({ graceMs: 0, now: () => t });
    const events = [];
    p.on('online', u => events.push(['online', u]));
    p.on('offline', (u, ts) => events.push(['offline', u, ts]));

    assert.deepEqual(p.connect(ALICE, 's1'), { online: true });
    assert.deepEqual(p.connect(ALICE, 's2'), { online: false });
    assert.equal(p.isOnline(ALICE), true);
    assert.deepEqual(p.onlineUserIds(), [ALICE]);

    t = 200;
    assert.deepEqual(p.disconnect(ALICE, 's1'), { offline: false });
    assert.equal(p.isOnline(ALICE), true, 'one tab left');
    assert.deepEqual(p.disconnect(ALICE, 's2'), { offline: true });
    assert.equal(p.isOnline(ALICE), false);
    assert.equal(p.lastSeen(ALICE), 200);
    assert.deepEqual(events, [['online', ALICE], ['offline', ALICE, 200]]);
    assert.deepEqual(p.disconnect(ALICE, 's2'), { offline: false }, 'unknown socket is ignored');
  });

  it('a reload within the grace period does not flicker offline', async () => {
    const p = createPresence({ graceMs: 30 });
    const events = [];
    p.on('online', u => events.push('online'));
    p.on('offline', u => events.push('offline'));
    p.connect(BOB, 'a');
    p.disconnect(BOB, 'a');
    assert.equal(p.isOnline(BOB), true);
    p.connect(BOB, 'b');
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(events, ['online']);
    p.disconnect(BOB, 'b');
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(events, ['online', 'offline']);
    assert.equal(p.isOnline(BOB), false);
    p.close();
  });
});

describe('presence: now playing', () => {
  const report = (title, extra = {}) => ({ track: { id: 'x', title, artist: 'Artist' }, context: { type: 'library' }, playing: true, ...extra });

  it('keeps one entry per user: the last report from any tab wins', () => {
    const p = createPresence({ graceMs: 0 });
    p.connect(ALICE, 's1');
    p.connect(ALICE, 's2');
    p.setNowPlaying(ALICE, 's1', report('One'));
    p.setNowPlaying(ALICE, 's2', report('Two'));
    assert.equal(p.getNowPlaying(ALICE).track.title, 'Two');
    assert.equal(p.getNowPlaying(ALICE).socketId, 's2');
    p.setNowPlaying(ALICE, 's2', report('Two', { playing: false, position: 42 }));
    assert.equal(p.getNowPlaying(ALICE).playing, false);
    assert.equal(p.getNowPlaying(ALICE).position, 42);
  });

  it('a tab pausing never overrides another tab that is playing', () => {
    const p = createPresence({ graceMs: 0 });
    p.connect(ALICE, 's1');
    p.connect(ALICE, 's2');
    p.setNowPlaying(ALICE, 's1', report('Old'));
    p.setNowPlaying(ALICE, 's2', report('New'));
    assert.equal(p.setNowPlaying(ALICE, 's1', report('Old', { playing: false })), undefined);
    assert.equal(p.getNowPlaying(ALICE).track.title, 'New');
    assert.equal(p.getNowPlaying(ALICE).playing, true);
  });

  it('ignores reports from sockets that are not connected', () => {
    const p = createPresence({ graceMs: 0 });
    assert.equal(p.setNowPlaying(ALICE, 'ghost', report('X')), undefined);
    assert.equal(p.getNowPlaying(ALICE), null);
  });

  it('drops the entry when the reporting tab closes, or when nothing is loaded', () => {
    const p = createPresence({ graceMs: 0 });
    const seen = [];
    p.on('now-playing', (u, e) => seen.push(e && e.track.title));
    p.connect(ALICE, 's1');
    p.connect(ALICE, 's2');
    p.setNowPlaying(ALICE, 's1', report('One'));
    p.disconnect(ALICE, 's2');
    assert.equal(p.getNowPlaying(ALICE).track.title, 'One', 'another tab closing changes nothing');
    p.disconnect(ALICE, 's1');
    assert.equal(p.getNowPlaying(ALICE), null);

    p.connect(BOB, 'b1');
    p.setNowPlaying(BOB, 'b1', report('Three'));
    p.setNowPlaying(BOB, 'b1', { track: null });
    assert.equal(p.getNowPlaying(BOB), null);
    assert.deepEqual(seen, ['One', null, 'Three', null]);
  });

  it('validates and trims reports', () => {
    const p = createPresence({ graceMs: 0 });
    p.connect(ALICE, 's');
    p.setNowPlaying(ALICE, 's', { track: { title: 'T'.repeat(1000) }, context: { type: 'lobby', lobbyId: '../etc' } });
    const e = p.getNowPlaying(ALICE);
    assert.equal(e.track.title.length, 300);
    assert.equal(e.context, null);
    assert.equal(p.setNowPlaying(ALICE, 's', { track: { title: '   ' } }), null);
  });

  it('never shows a playlist the viewer cannot see: no name, no id', () => {
    const p = createPresence({ graceMs: 0 });
    p.connect(ALICE, 's');
    p.setNowPlaying(ALICE, 's', { track: { title: 'Song' }, context: { type: 'lobby', lobbyId: 'secret1' }, playing: true });
    const entry = p.getNowPlaying(ALICE);
    const lobbies = { secret1: { id: 'secret1', name: 'My Secret Mix', ownerId: ALICE, visibility: 'private' } };
    const access = require('./playlistAccess');
    const lobbyFor = viewer => id => (access.canView(lobbies[id], viewer) ? lobbies[id] : null);

    const forOwner = viewNowPlaying(entry, lobbyFor(ALICE));
    assert.equal(forOwner.context.name, 'My Secret Mix');
    const forBob = viewNowPlaying(entry, lobbyFor(BOB));
    assert.equal(forBob.track.title, 'Song');
    assert.equal(forBob.context, null);
    assert.ok(!JSON.stringify(forBob).includes('secret1'));
    assert.ok(!JSON.stringify(forBob).includes('Secret Mix'));
    assert.ok(!JSON.stringify(forBob).includes('"s"'), 'no socket id to follow either');
    assert.deepEqual(p.usersPlayingFromLobby('secret1'), [ALICE]);
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

describe('global chat and people panel against a running server', { timeout: 60_000 }, () => {
  let server;
  let base;
  let adminCookie;
  const sockets = [];

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, PORT: String(port), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD, PRESENCE_GRACE_MS: '0', FRONTEND_PATH: path.join(__dirname, '..', '..', 'frontend') };
    delete env.DATABASE_URL;
    server = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 20_000);
      server.stdout.on('data', (d) => { if (/Server running on port/.test(String(d))) { clearTimeout(timer); resolve(); } });
      server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
    });
    // Same credentials as the server, so this is a valid admin cookie there.
    const prev = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    adminCookie = `la_admin=${encodeURIComponent(require('./adminAuth').createSessionValue())}`;
    if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev;
  });

  after(() => {
    for (const s of sockets) s.disconnect();
    if (server) server.kill('SIGKILL');
  });

  function connect(user, { admin = false } = {}) {
    const cookies = [];
    if (user) cookies.push(authCookie(user));
    if (admin) cookies.push(adminCookie);
    const s = ioClient(base, { transports: ['websocket'], forceNew: true, extraHeaders: cookies.length ? { cookie: cookies.join('; ') } : {} });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  const ask = (s, event, arg) => new Promise((resolve) => s.emit(event, arg, resolve));

  // Resolves with the first payload of `event` matching `pred`, or 'timeout'.
  function next(s, event, pred = () => true, ms = 1500) {
    return new Promise((resolve) => {
      const h = (data) => { if (pred(data)) { clearTimeout(timer); s.off(event, h); resolve(data); } };
      const timer = setTimeout(() => { s.off(event, h); resolve('timeout'); }, ms);
      s.on(event, h);
    });
  }

  let alice;
  let bob;

  it('lists signed-in users with presence; anonymous sockets get nothing', async () => {
    alice = await connect(ALICE);
    alice.emit('social:hello', { name: 'Alice' });
    const bobOnline = next(alice, 'people:presence', d => d.user.id === BOB && d.user.online);
    bob = await connect(BOB);
    bob.emit('social:hello', { name: 'Bob' });
    assert.notEqual(await bobOnline, 'timeout');

    const list = await ask(alice, 'people:list');
    assert.equal(list.me, ALICE);
    assert.equal(list.isAdmin, false);
    const ids = list.people.filter(p => p.online).map(p => p.id).sort();
    assert.deepEqual(ids, [ALICE, BOB].sort());

    // Anonymous sockets are refused at the handshake.
    await assert.rejects(connect(null), /Authentication required/);
  });

  it('delivers a message live to everyone signed in, with the author', async () => {
    const atBob = next(bob, 'chat:message');
    const res = await ask(alice, 'chat:send', { text: '  hello <b>bob</b>  ' });
    assert.equal(res.ok, true);
    const msg = await atBob;
    assert.equal(msg.text, 'hello <b>bob</b>', 'stored as plain text, trimmed');
    assert.equal(msg.userId, ALICE);
    assert.equal(msg.authorName, 'Alice');
    assert.ok(msg.createdAt > 0);
  });

  it('rate limits per user (shared by all their tabs)', async () => {
    const tab2 = await connect(BOB);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await ask(i % 2 ? tab2 : bob, 'chat:send', { text: `spam ${i}` }));
    assert.equal(results.filter(r => r.ok).length, 5);
    assert.match(results[5].error, /too fast/);
    assert.ok((await ask(bob, 'chat:send', { text: 'x'.repeat(chat.MAX_LENGTH + 1) })).error);
    tab2.disconnect();
  });

  it('pages history with a keyset cursor', async () => {
    const all = await ask(alice, 'chat:history', { limit: 3 });
    assert.equal(all.messages.length, 3);
    assert.equal(all.hasMore, true);
    const older = await ask(alice, 'chat:history', { before: all.messages[0].id, limit: 100 });
    assert.ok(older.messages.every(m => m.id < all.messages[0].id));
    assert.equal(older.hasMore, false);
    assert.equal(older.messages[0].text, 'hello <b>bob</b>');
  });

  it('only an admin can delete a message, and everyone sees it go', async () => {
    const { messages } = await ask(alice, 'chat:history', {});
    const target = messages[0];
    assert.deepEqual(await ask(alice, 'chat:delete', { id: target.id }), { error: 'Only an admin can delete messages' });

    let res = await fetch(`${base}/api/chat/messages/${target.id}`, { method: 'DELETE', headers: { cookie: authCookie(ALICE) } });
    assert.equal(res.status, 401);

    const admin = await connect(BOB, { admin: true });
    assert.equal((await ask(admin, 'people:list')).isAdmin, true);
    const gone = next(alice, 'chat:deleted');
    assert.deepEqual(await ask(admin, 'chat:delete', { id: target.id }), { ok: true });
    assert.deepEqual(await gone, { id: target.id });
    assert.deepEqual(await ask(admin, 'chat:delete', { id: target.id }), { error: 'Message not found' });

    const second = messages[1];
    const gone2 = next(bob, 'chat:deleted');
    res = await fetch(`${base}/api/chat/messages/${second.id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await gone2, { id: second.id });
    admin.disconnect();
  });

  it('shows now playing to others and never leaks a private playlist', async () => {
    const mk = (name, visibility) => fetch(`${base}/api/playlists`, {
      method: 'POST', headers: { cookie: authCookie(ALICE), 'content-type': 'application/json' }, body: JSON.stringify({ name, visibility }),
    }).then(r => r.json());
    const pub = await mk('Alice Open', 'public');
    const priv = await mk('Alice Hidden Mix', 'private');

    // Public playlist: Bob sees its name.
    let atBob = next(bob, 'people:now-playing', d => d.userId === ALICE);
    alice.emit('presence:now-playing', { track: { id: 's1', title: 'Song A', artist: 'X' }, context: { type: 'lobby', lobbyId: pub.id }, playing: true });
    let np = await atBob;
    assert.equal(np.nowPlaying.track.title, 'Song A');
    assert.equal(np.nowPlaying.context.name, 'Alice Open');

    // Private playlist: Bob sees the song only; Alice sees her playlist.
    atBob = next(bob, 'people:now-playing', d => d.userId === ALICE);
    const atAlice = next(alice, 'people:now-playing', d => d.userId === ALICE);
    alice.emit('presence:now-playing', { track: { id: 's2', title: 'Song B' }, context: { type: 'lobby', lobbyId: priv.id }, playing: true });
    np = await atBob;
    assert.equal(np.nowPlaying.track.title, 'Song B');
    assert.equal(np.nowPlaying.context, null);
    assert.ok(!JSON.stringify(np).includes(priv.id));
    assert.ok(!JSON.stringify(np).includes('Hidden'));
    assert.equal((await atAlice).nowPlaying.context.name, 'Alice Hidden Mix');

    const listForBob = await ask(bob, 'people:list');
    const aliceForBob = listForBob.people.find(p => p.id === ALICE);
    assert.equal(aliceForBob.nowPlaying.track.title, 'Song B');
    assert.equal(aliceForBob.nowPlaying.context, null);
    assert.ok(!JSON.stringify(listForBob).includes(priv.id));

    // Bob cannot make Alice's private playlist show up by reporting it himself.
    const bobAtAlice = next(alice, 'people:now-playing', d => d.userId === BOB);
    bob.emit('presence:now-playing', { track: { title: 'Probe' }, context: { type: 'lobby', lobbyId: priv.id }, playing: true });
    assert.equal((await bobAtAlice).nowPlaying.context, null);

    // The public playlist going private re-redacts what others see.
    alice.emit('presence:now-playing', { track: { id: 's1', title: 'Song A' }, context: { type: 'lobby', lobbyId: pub.id }, playing: true });
    await next(bob, 'people:now-playing', d => d.userId === ALICE && d.nowPlaying && d.nowPlaying.context);
    atBob = next(bob, 'people:now-playing', d => d.userId === ALICE);
    const r = await fetch(`${base}/api/playlists/${pub.id}`, {
      method: 'PATCH', headers: { cookie: authCookie(ALICE), 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'private' }),
    });
    assert.equal(r.status, 200);
    np = await atBob;
    assert.equal(np.nowPlaying.context, null);
    assert.equal(np.nowPlaying.track.title, 'Song A');
  });

  it('a second tab keeps the user online; the last tab closing takes them offline with last seen', async () => {
    const aliceTab2 = await connect(ALICE);
    const notOffline = next(bob, 'people:presence', d => d.user.id === ALICE && !d.user.online, 400);
    alice.disconnect();
    assert.equal(await notOffline, 'timeout');
    // The tab that reported now-playing closed: the song goes away.
    const list = await ask(bob, 'people:list');
    const a = list.people.find(p => p.id === ALICE);
    assert.equal(a.online, true);
    assert.equal(a.nowPlaying, null);

    const offline = next(bob, 'people:presence', d => d.user.id === ALICE && !d.user.online);
    aliceTab2.disconnect();
    const ev = await offline;
    assert.notEqual(ev, 'timeout');
    assert.ok(ev.user.lastSeen > 0);
    const after = (await ask(bob, 'people:list')).people.find(p => p.id === ALICE);
    assert.equal(after.online, false);
    assert.ok(after.lastSeen > 0, 'offline users stay listed');
  });
});
