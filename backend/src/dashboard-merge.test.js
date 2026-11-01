// /admin moved into /dashboard: the old URL redirects, the page is a data-free
// shell with its own login, every admin API stays behind the admin cookie, and
// without ADMIN_PASSWORD all of it is 404.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, requester, adminCookie, cookieFor } = require('./testServer');

const ADMIN_APIS = [
  ['GET', '/api/admin/workers'], ['GET', '/api/admin/jobs'], ['POST', '/api/admin/jobs/x/cancel'], ['POST', '/api/admin/jobs/x/retry'],
  ['GET', '/api/admin/tokens'], ['POST', '/api/admin/tokens/x/revoke'],
  ['POST', '/api/admin/library/reports/1/dismiss'], ['POST', '/api/admin/library/x/reports/dismiss'], ['DELETE', '/api/admin/library/x'],
  ['GET', '/api/dashboard/stats'], ['GET', '/api/dashboard/users'],
  ['PUT', '/api/dashboard/users/x/approve'], ['PUT', '/api/dashboard/users/x/reject'], ['DELETE', '/api/dashboard/lobbies/x'],
];

describe('dashboard with admin enabled', () => {
  let srv; let req;
  before(async () => { srv = await startServer(); req = requester(srv.base); });
  after(() => srv.stop());

  it('/admin redirects to /dashboard, ignoring the query', async () => {
    for (const url of ['/admin', '/admin?next=https://evil.example/', '/ADMIN']) {
      const r = await req('GET', url);
      assert.equal(r.status, 301, url);
      assert.equal(r.headers.get('location'), '/dashboard', url);
    }
  });

  it('the old admin files are gone', async () => {
    for (const url of ['/admin.html', '/admin.js']) {
      assert.notEqual((await req('GET', url, { cookie: cookieFor('someone') })).status, 200, url);
    }
  });

  it('/dashboard is the same shell for everyone: login form, no admin data', async () => {
    const anon = await req('GET', '/dashboard');
    const user = await req('GET', '/dashboard', { cookie: cookieFor('someone') });
    const admin = await req('GET', '/dashboard', { cookie: adminCookie() });
    assert.equal(anon.status, 200);
    assert.equal(anon.text, user.text);
    assert.equal(anon.text, admin.text, 'nothing in the HTML depends on being an admin');
    assert.match(anon.text, /id="adm-login"/);
    assert.doesNotMatch(anon.text, /la_[a-f0-9]{8}/);
    assert.equal(anon.headers.get('set-cookie'), null);
  });

  it('every admin API refuses anonymous visitors and user logins', async () => {
    for (const [method, url] of ADMIN_APIS) {
      assert.equal((await req(method, url)).status, 401, `${method} ${url}`);
      assert.equal((await req(method, url, { cookie: cookieFor('someone') })).status, 401, `${method} ${url} with a user login`);
    }
  });

  it('status tells the page which state to show; only an admin is authenticated', async () => {
    assert.deepEqual((await req('GET', '/api/admin/status')).body, { enabled: true, authenticated: false });
    assert.deepEqual((await req('GET', '/api/admin/status', { cookie: cookieFor('someone') })).body, { enabled: true, authenticated: false });
    assert.deepEqual((await req('GET', '/api/admin/status', { cookie: adminCookie() })).body, { enabled: true, authenticated: true });
  });
});

describe('dashboard without ADMIN_PASSWORD', () => {
  let srv; let req;
  before(async () => { srv = await startServer({ ADMIN_PASSWORD: '' }); req = requester(srv.base); });
  after(() => srv.stop());

  it('the page and every admin API are 404', async () => {
    assert.equal((await req('GET', '/dashboard')).status, 404);
    const old = await req('GET', '/admin');
    assert.equal(old.headers.get('location'), '/dashboard', 'which is then the 404');
    for (const [method, url] of ADMIN_APIS) assert.equal((await req(method, url)).status, 404, `${method} ${url}`);
  });
});
