/**
 * OAuth authentication module using Passport.js
 * Supports Google OAuth 2.0 and GitHub OAuth
 */

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const db = require('./db');

/**
 * Find or create a user from OAuth profile data
 */
async function findOrCreateUser(provider, profile) {
  const providerId = profile.id;
  const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
  const name = profile.displayName || (profile.username ? profile.username : 'User');
  const avatar = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

  if (!db.isAvailable()) {
    // Return a transient user object if DB is unavailable
    return { id: `${provider}_${providerId}`, provider, provider_id: providerId, email, name, avatar_url: avatar };
  }

  // Try to find existing user
  const existing = await db.query(
    'SELECT * FROM users WHERE provider = $1 AND provider_id = $2',
    [provider, providerId]
  );

  if (existing.rows.length > 0) {
    // Update last_login and refresh profile data
    await db.query(
      `UPDATE users SET name = $1, email = $2, avatar_url = $3, last_login = $4 WHERE id = $5`,
      [name, email, avatar, Date.now(), existing.rows[0].id]
    );
    return { ...existing.rows[0], name, email, avatar_url: avatar };
  }

  // Create new user
  const result = await db.query(
    `INSERT INTO users (provider, provider_id, email, name, avatar_url, created_at, last_login)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [provider, providerId, email, name, avatar, Date.now()]
  );

  return result.rows[0];
}

/**
 * Initialize Passport strategies and serialization
 */
function init() {
  // Serialize user to session (store only ID)
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id, done) => {
    try {
      if (!db.isAvailable()) {
        return done(null, { id });
      }
      const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      if (result.rows.length === 0) {
        return done(null, false);
      }
      done(null, result.rows[0]);
    } catch (err) {
      done(err);
    }
  });

  // Google OAuth Strategy
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback'
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await findOrCreateUser('google', profile);
        done(null, user);
      } catch (err) {
        done(err);
      }
    }));
    console.log('Google OAuth strategy configured');
  } else {
    console.log('Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)');
  }

  // GitHub OAuth Strategy
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: '/auth/github/callback',
      scope: ['user:email']
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await findOrCreateUser('github', profile);
        done(null, user);
      } catch (err) {
        done(err);
      }
    }));
    console.log('GitHub OAuth strategy configured');
  } else {
    console.log('GitHub OAuth not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)');
  }
}

/**
 * Set up auth routes on the Express app
 */
function setupRoutes(app) {
  // Google OAuth
  app.get('/auth/google', passport.authenticate('google', {
    scope: ['profile', 'email']
  }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
      res.redirect('/');
    }
  );

  // GitHub OAuth
  app.get('/auth/github', passport.authenticate('github', {
    scope: ['user:email']
  }));

  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/login' }),
    (req, res) => {
      res.redirect('/');
    }
  );

  // Logout
  app.post('/auth/logout', (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
      });
    });
  });

  // Get current user
  app.get('/api/auth/user', (req, res) => {
    if (req.isAuthenticated()) {
      const user = req.user;
      res.json({
        authenticated: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatar: user.avatar_url,
          provider: user.provider
        }
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  // Login page route
  app.get('/login', (req, res) => {
    if (req.isAuthenticated()) {
      return res.redirect('/');
    }
    const path = require('path');
    const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');
    res.sendFile(path.join(frontendPath, 'login.html'));
  });
}

/**
 * Auth guard middleware - redirects unauthenticated requests to login
 */
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  // API requests get 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Page requests redirect to login
  res.redirect('/login');
}

module.exports = {
  init,
  setupRoutes,
  requireAuth,
  passport
};
