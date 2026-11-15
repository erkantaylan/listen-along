/**
 * Which listen-along account a central sign-in lands on. Runs at the OIDC
 * callback, after openid-client validated the id_token. In this order:
 *
 *   a. the user whose users.oidc_sub is this sub;
 *   b. upstream_identities: the user holding one of the listed upstream
 *      accounts, in user_providers or in the legacy users.provider/provider_id
 *      columns. Provider slugs go through OIDC_PROVIDER_MAP (google, github by
 *      default; anything unmapped is ignored). If any matching user is already
 *      linked to ANOTHER sub, the sign-in is refused (`link_conflict`: a
 *      takeover attempt or a duplicate central account; the owner sorts it
 *      out) instead of falling through to a new account. Several unlinked
 *      users: the earliest created is linked and the others are logged for the
 *      owner to merge by hand (rows are never merged here);
 *   c. email, only when the token says email_verified === true (the boolean)
 *      and exactly ONE unlinked user has that address from GOOGLE
 *      (user_providers.email of a google row, or users.email of a legacy
 *      google user; case-insensitive). Legacy logins stored GitHub addresses
 *      whether GitHub had verified them or not, so those never count;
 *   e. otherwise a new `approved` user, unless registrations are closed.
 *
 * (There is no rule d: an old `listen_auth` cookie at the callback has no say
 * in linking. It is cleared, nothing else.)
 *
 * A found or linked user who is denied / rejected is refused (the link is kept,
 * so the ban sticks to that central identity). Everything runs in one
 * transaction behind a per-sub advisory lock, and a link only stamps a row
 * whose oidc_sub is still NULL (unique index on users.oidc_sub): two callbacks
 * at once cannot create two users, nor link one sub to two users or one user
 * to two subs.
 */

const { isBlocked } = require('./userAuth');

const MAX_UPSTREAM = 20;

/** upstream_identities -> [{ provider, providerId }] mapped to listen-along names; junk dropped. */
function parseUpstream(claim, providerMap) {
  if (!Array.isArray(claim)) return [];
  const out = [];
  const seen = new Set();
  for (const item of claim.slice(0, MAX_UPSTREAM)) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.provider === 'string' ? item.provider.trim().toLowerCase() : '';
    let id = item.id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) id = String(id);
    if (!slug || typeof id !== 'string' || !id || id.length > 255) continue;
    const provider = Object.prototype.hasOwnProperty.call(providerMap, slug) ? providerMap[slug] : null;
    if (!provider) continue;
    const key = `${provider}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, providerId: id });
  }
  return out;
}

/** The name the IdP knows the person by, or null. */
function centralName(claims) {
  for (const v of [claims.name, claims.preferred_username]) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 255);
  }
  return null;
}

function centralEmail(claims) {
  return typeof claims.email === 'string' && claims.email.trim() && claims.email.length <= 255 ? claims.email.trim() : null;
}

const USER_COLS = 'id, status, name, display_name, email, created_at, oidc_sub';
const short = (s) => String(s).slice(0, 8);

/**
 * @param db          db module (getClient)
 * @param claims      validated id_token claims
 * @param registrationsOpen () => Promise<boolean>
 * @param providerMap OIDC_PROVIDER_MAP
 * @returns {{ outcome: 'ok'|'refused', rule: 'a'|'b'|'c'|'e', created?: boolean,
 *   user?: object, reason?: 'account_disabled'|'registrations_closed'|'link_conflict' }}
 *   Logging the decision is the caller's job (one greppable line per sign-in).
 */
async function linkCentralIdentity({ db, claims, registrationsOpen, providerMap, logger = console }) {
  const sub = claims.sub;
  const upstream = parseUpstream(claims.upstream_identities, providerMap);
  const email = centralEmail(claims);
  const emailVerified = claims.email_verified === true;
  const name = centralName(claims);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Serialize callbacks for the same sub (a double callback, two tabs).
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('listen-along:oidc-link:' || $1, 0))", [sub]);

    let user = null;
    let rule = null;
    let created = false;
    const refuse = async (reason, r = rule) => {
      await client.query('ROLLBACK');
      return { outcome: 'refused', rule: r, reason };
    };

    // a. already linked
    {
      const r = await client.query(`SELECT ${USER_COLS} FROM users WHERE oidc_sub = $1`, [sub]);
      if (r.rows[0]) { user = r.rows[0]; rule = 'a'; }
    }

    // Stamp oidc_sub on a still-unlinked user; null when someone else got it first.
    const link = async (id) => {
      const r = await client.query(
        `UPDATE users SET oidc_sub = $1, updated_at = $2 WHERE id = $3 AND oidc_sub IS NULL RETURNING ${USER_COLS}`,
        [sub, Date.now(), id]
      );
      return r.rows[0] || null;
    };

    // b and c may lose a race to another sub linking the same row; then look again.
    for (let attempt = 0; !user && attempt < 3; attempt++) {
      // b. upstream identities
      if (upstream.length) {
        const r = await client.query(
          `WITH ids(provider, provider_id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
           SELECT u.id, u.created_at, u.oidc_sub FROM users u
           WHERE EXISTS (SELECT 1 FROM user_providers up JOIN ids ON up.provider = ids.provider AND up.provider_id = ids.provider_id
                         WHERE up.user_id = u.id)
              OR EXISTS (SELECT 1 FROM ids WHERE ids.provider = u.provider AND ids.provider_id = u.provider_id)
           ORDER BY u.created_at ASC, u.id ASC`,
          [upstream.map((x) => x.provider), upstream.map((x) => x.providerId)]
        );
        const taken = r.rows.filter((x) => x.oidc_sub !== null);
        if (taken.length) {
          logger.warn(`central-login: REFUSED rule=b sub=${short(sub)}… link_conflict: its upstream accounts belong to user(s) ${taken.map((x) => x.id).join(', ')} already linked to another central identity (sub ${taken.map((x) => short(x.oidc_sub) + '…').join(', ')}); a takeover attempt or a duplicate central account, check by hand`);
          return refuse('link_conflict', 'b');
        }
        if (r.rows.length) {
          if (r.rows.length > 1) {
            logger.warn(`central-login: sub=${short(sub)}… upstream accounts match ${r.rows.length} users; linking the earliest ${r.rows[0].id}, merge by hand: ${r.rows.slice(1).map((x) => x.id).join(', ')}`);
          }
          user = await link(r.rows[0].id);
          if (user) { rule = 'b'; break; }
          continue; // lost a race: the next pass sees it linked and refuses
        }
      }
      // c. verified email, Google-sourced, exactly one candidate
      if (email && emailVerified) {
        const r = await client.query(
          `SELECT u.id FROM users u
           WHERE u.oidc_sub IS NULL AND (
             (u.provider = 'google' AND lower(u.email) = lower($1))
             OR EXISTS (SELECT 1 FROM user_providers up
                        WHERE up.user_id = u.id AND up.provider = 'google' AND lower(up.email) = lower($1)))
           LIMIT 2`,
          [email]
        );
        if (r.rows.length === 1) {
          user = await link(r.rows[0].id);
          if (user) { rule = 'c'; break; }
          continue;
        }
        if (r.rows.length > 1) logger.log(`central-login: sub=${short(sub)}… verified email matches several unlinked users; not linking by email`);
      }
      break;
    }

    // e. a new account
    if (!user) {
      if (!(await registrationsOpen())) return refuse('registrations_closed', 'e');
      const now = Date.now();
      const r = await client.query(
        `INSERT INTO users (provider, provider_id, oidc_sub, email, name, status, created_at, updated_at)
         VALUES ('oidc', $1, $2, $3, $4, 'approved', $5, $5) RETURNING ${USER_COLS}`,
        // The address only when the IdP vouches for it: if central login is
        // ever turned off, the old Google flow links accounts by email.
        [sub, sub, emailVerified ? email : null, name, now]
      );
      user = r.rows[0];
      rule = 'e';
      created = true;
    } else if (name && user.name !== name) {
      // Keep a name the person chose on their profile; follow the IdP otherwise.
      if (!user.display_name) {
        await client.query('UPDATE users SET name = $1 WHERE id = $2', [name, user.id]);
        user = { ...user, name };
      } else if (user.display_name === user.name) {
        await client.query('UPDATE users SET name = $1, display_name = $1 WHERE id = $2', [name, user.id]);
        user = { ...user, name, display_name: name };
      }
    }

    await client.query('COMMIT');

    if (isBlocked(user.status)) return { outcome: 'refused', rule, reason: 'account_disabled', user };
    return { outcome: 'ok', rule, created, user };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { linkCentralIdentity, parseUpstream, centralName };
