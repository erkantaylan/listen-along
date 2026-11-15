// A fake OpenID Connect provider for tests (not a test file itself): discovery,
// JWKS, authorize (signs in whoever the test says, no page), token
// (authorization_code with PKCE S256 checked, refresh_token with rotation) and
// end-session. ID tokens are signed with jose (RS256). Shaped like authentik:
// the issuer has a path, claims ride in the id_token.
//
//   const idp = await startFakeIssuer();
//   idp.user = { sub, email, email_verified, name, upstream_identities, roles };
//   idp.tamper = { aud: 'other' }   // the next id_token only
//   idp.disable(sub) / idp.down = 'http503' | 'reset' | false
//
// Control is in-process: the app under test runs as a child process and talks
// to this over HTTP.
//
// Also a local development IdP (no authentik needed), from backend/:
//   node src/fakeOidcIssuer.js [--port 9400] [--sub dev-1] [--email dev@example.com] [--name "Dev User"]
// Every sign-in is that one user, at once (no page). It prints the variables
// for the app; plain http, so the app must not run with NODE_ENV=production.
const http = require('node:http');
const crypto = require('node:crypto');

const b64sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rand = () => crypto.randomBytes(24).toString('base64url');

async function startFakeIssuer({ clientId = 'listen-along', slug = 'listen-along', port = 0 } = {}) {
  const jose = await import('jose');
  const keys = await jose.generateKeyPair('RS256', { extractable: true });
  const otherKeys = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  const idp = {
    clientId,
    user: null,
    tamper: null,           // one-shot changes to the next id_token
    down: false,            // 'http503' | 'reset': the token endpoint fails
    refreshDelayMs: 0,
    refreshError: null,     // e.g. 'invalid_client': the next refreshes fail with it
    metadataOverride: null, // (md) => md, for malformed-discovery tests
    redirectMatch: true,    // false: the token endpoint does not compare redirect_uri with the code's (as authentik)
    registeredRedirects: null, // a Set: authorize refuses any other redirect_uri (the client's registered list); null = any
    disabled: new Set(),
    codes: new Map(),
    refreshTokens: new Map(), // token -> { sub, claims, active }
    calls: { authorize: 0, token: 0, refresh: 0, endSession: [] },
    lastTokenError: null,
    authorizeRequests: [],
    disable(sub) { this.disabled.add(sub); },
    enable(sub) { this.disabled.delete(sub); },
    reset() {
      this.user = null; this.tamper = null; this.down = false; this.refreshDelayMs = 0; this.refreshError = null;
      this.metadataOverride = null; this.redirectMatch = true; this.registeredRedirects = null; this.disabled.clear();
    },
  };

  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error', error_description: String(err && err.message) }));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `/application/o/${slug}/`;
  idp.origin = origin;
  idp.issuer = origin + base;

  function metadata() {
    const md = {
      issuer: idp.issuer,
      authorization_endpoint: `${origin}/application/o/authorize/`,
      token_endpoint: `${origin}/application/o/token/`,
      userinfo_endpoint: `${origin}/application/o/userinfo/`,
      end_session_endpoint: `${origin}${base}end-session/`,
      jwks_uri: `${origin}${base}jwks/`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['plain', 'S256'],
      scopes_supported: ['openid', 'email', 'profile', 'offline_access', 'entitlements', 'upstream'],
    };
    return idp.metadataOverride ? idp.metadataOverride(md) : md;
  }

  async function idToken(claims, { nonce } = {}) {
    // One-shot; with `forSub`, only for that user's next token (so a refresh
    // of someone else's session in between does not use it up).
    let t = idp.tamper || {};
    if (t.forSub && t.forSub !== claims.sub) t = {};
    else idp.tamper = null;
    const now = Math.floor(Date.now() / 1000);
    const payload = { ...claims, nonce, auth_time: now };
    if (t.nonce !== undefined) payload.nonce = t.nonce;
    if (nonce === undefined && t.nonce === undefined) delete payload.nonce;
    if (t.sub) payload.sub = t.sub;
    if (t.azp !== undefined) payload.azp = t.azp;
    const full = {
      ...payload, iss: t.iss || idp.issuer, aud: t.aud || clientId,
      iat: t.exp ? t.exp - 600 : now, exp: t.exp || now + 600,
    };
    if (t.alg === 'none') {
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(full)}.`;
    }
    if (t.alg === 'HS256') {
      // The classic confusion attack: HMAC keyed with something public.
      return new jose.SignJWT(full).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode(clientId.padEnd(32, '-')));
    }
    const key = t.key === 'other' ? otherKeys.privateKey : keys.privateKey;
    return new jose.SignJWT(full).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
  }

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  async function readForm(req) {
    let body = '';
    for await (const chunk of req) body += chunk;
    return new URLSearchParams(body);
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const p = url.pathname;

    if (p === `${base}.well-known/openid-configuration`) return json(res, 200, metadata());
    if (p === `${base}jwks/`) return json(res, 200, { keys: [jwk] });

    if (p === '/application/o/authorize/') {
      idp.calls.authorize++;
      const q = url.searchParams;
      idp.authorizeRequests.push(Object.fromEntries(q));
      const redirect = q.get('redirect_uri');
      if (q.get('client_id') !== clientId || !redirect) return json(res, 400, { error: 'invalid_client' });
      // An unregistered redirect gets an error page, never a redirect with a code.
      if (idp.registeredRedirects && !idp.registeredRedirects.has(redirect)) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri' });
      const back = new URL(redirect);
      if (!idp.user) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', q.get('state') || '');
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      }
      const code = rand();
      idp.codes.set(code, {
        claims: { ...idp.user }, redirect, challenge: q.get('code_challenge'), nonce: q.get('nonce') || undefined,
        scope: q.get('scope'), at: Date.now(),
      });
      back.searchParams.set('code', code);
      if (q.has('state')) back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }

    if (p === '/application/o/token/' && req.method === 'POST') {
      idp.calls.token++;
      const form = await readForm(req);
      if (idp.down === 'reset') { req.socket.destroy(); return; }
      if (idp.down === 'http503') return json(res, 503, { error: 'temporarily_unavailable' });
      if (form.get('client_id') !== clientId) return json(res, 401, { error: 'invalid_client' });
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const c = idp.codes.get(form.get('code'));
        idp.codes.delete(form.get('code'));
        if (!c) { idp.lastTokenError = 'unknown code'; return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' }); }
        // RFC 6749 4.1.3. authentik (2026.8) does not do this: it only checks
        // that redirect_uri is registered (idp.redirectMatch = false).
        if (idp.redirectMatch && form.get('redirect_uri') !== c.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
        const verifier = form.get('code_verifier') || '';
        if (b64sha256(verifier) !== c.challenge) {
          idp.lastTokenError = 'PKCE verification failed';
          return json(res, 400, { error: 'invalid_grant', error_description: idp.lastTokenError });
        }
        const refresh = rand();
        idp.refreshTokens.set(refresh, { sub: c.claims.sub, claims: c.claims, active: true });
        return json(res, 200, {
          access_token: rand(), token_type: 'Bearer', expires_in: 600, scope: c.scope,
          id_token: await idToken(c.claims, { nonce: c.nonce }), refresh_token: refresh,
        });
      }
      if (grant === 'refresh_token') {
        idp.calls.refresh++;
        if (idp.refreshDelayMs) await new Promise((r) => setTimeout(r, idp.refreshDelayMs));
        if (idp.refreshError) return json(res, idp.refreshError === 'invalid_client' ? 401 : 400, { error: idp.refreshError });
        const old = form.get('refresh_token');
        const rec = idp.refreshTokens.get(old);
        if (!rec || !rec.active) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token unknown or used' });
        if (idp.disabled.has(rec.sub)) return json(res, 400, { error: 'invalid_grant', error_description: 'user inactive' });
        rec.active = false; // rotation: every refresh token works once
        const next = rand();
        idp.refreshTokens.set(next, { ...rec, active: true });
        const { nonce, ...claims } = rec.claims;
        return json(res, 200, {
          access_token: rand(), token_type: 'Bearer', expires_in: 600,
          id_token: await idToken(claims), refresh_token: next,
        });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p === `${base}end-session/`) {
      idp.calls.endSession.push(Object.fromEntries(url.searchParams));
      const to = url.searchParams.get('post_logout_redirect_uri');
      if (to) { res.writeHead(302, { location: to }); return res.end(); }
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not_found' });
  }

  idp.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return idp;
}

module.exports = { startFakeIssuer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const port = Number(opt('port', '9400'));
  startFakeIssuer({ port }).then((idp) => {
    idp.user = {
      sub: opt('sub', 'dev-1'),
      email: opt('email', 'dev@example.com'),
      email_verified: true,
      name: opt('name', 'Dev User'),
    };
    console.log(`fake OpenID provider: ${idp.issuer} (every sign-in is ${idp.user.name}, sub ${idp.user.sub})`);
    console.log('Run listen-along with:');
    console.log(`  NODE_ENV=development OIDC_ISSUER=${idp.issuer} OIDC_CLIENT_ID=${idp.clientId} BASE_URL=http://localhost:3000 SESSION_SECRET=dev npm run dev`);
    const stop = () => idp.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    console.error(`fake OpenID provider: ${err.message}`);
    process.exit(1);
  });
}
