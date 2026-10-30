'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError, UsageError, EXIT } = require('./errors');

/**
 * Settable config keys. `env` names the overriding environment variable.
 * `parse` validates/normalises a raw string from `la config set`.
 */
const KEYS = {
  server: {
    env: 'LA_SERVER',
    description: 'Base URL of the listen-along server, e.g. https://listen.example.com',
    parse: (v) => {
      let u;
      try { u = new URL(v); } catch { throw new UsageError(`Invalid server URL: ${v}`, 'Use a full URL such as https://listen.example.com'); }
      if (!/^https?:$/.test(u.protocol)) throw new UsageError(`Server URL must be http(s): ${v}`);
      return v.replace(/\/+$/, '');
    },
  },
  token: {
    env: 'LA_TOKEN',
    secret: true,
    description: 'API token (sent as "Authorization: Bearer <token>")',
    parse: (v) => {
      if (!v.trim()) throw new UsageError('Token must not be empty');
      return v.trim();
    },
  },
  'keep-dir': {
    env: 'LA_KEEP_DIR',
    description: 'Where `--keep` stores local copies (default ~/Music/listen-along)',
    parse: (v) => v,
  },
  sleep: {
    env: 'LA_SLEEP',
    description: 'Default seconds to wait between YouTube downloads (default 3)',
    parse: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`sleep must be a non-negative number, got: ${v}`);
      return n;
    },
  },
  'ytdlp-args': {
    env: 'LA_YTDLP_ARGS',
    description: 'Extra arguments always passed to yt-dlp (shell-style string)',
    parse: (v) => v,
  },
};

const DEFAULTS = {
  'keep-dir': path.join(os.homedir(), 'Music', 'listen-along'),
  sleep: 3,
  'ytdlp-args': '',
};

/** Resolve the config file path (LA_CONFIG > $XDG_CONFIG_HOME > ~/.config). */
function configPath(env = process.env) {
  if (env.LA_CONFIG) return env.LA_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'listen-along', 'config.json');
}

/** Read the raw stored config file ({} if missing). */
function readFile(env = process.env) {
  const file = configPath(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new CliError(`Cannot read config file ${file}: ${err.message}`, { code: 'CONFIG_READ' });
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    throw new CliError(`Config file ${file} is not valid JSON: ${err.message}`, {
      code: 'CONFIG_READ',
      hint: `Fix or delete ${file}`,
    });
  }
}

/** Write the stored config with mode 600 (dir 700). */
function writeFile(data, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function assertKey(key) {
  if (!KEYS[key]) {
    throw new UsageError(`Unknown config key: ${key}`, `Valid keys: ${Object.keys(KEYS).join(', ')}`);
  }
}

function setValue(key, value, env = process.env) {
  assertKey(key);
  const data = readFile(env);
  data[key] = KEYS[key].parse(String(value));
  const file = writeFile(data, env);
  return { key, value: data[key], file };
}

function unsetValue(key, env = process.env) {
  assertKey(key);
  const data = readFile(env);
  const existed = key in data;
  delete data[key];
  const file = writeFile(data, env);
  return { key, removed: existed, file };
}

/**
 * Effective config: defaults < file < env vars < CLI flags.
 * Returns { values, sources } where sources[key] is 'default'|'file'|'env'|'flag'.
 * @param {object} [flags] - { server, token } from command-line options
 */
function load(env = process.env, flags = {}) {
  const file = readFile(env);
  const values = {};
  const sources = {};
  for (const key of Object.keys(KEYS)) {
    if (key in DEFAULTS) { values[key] = DEFAULTS[key]; sources[key] = 'default'; }
    if (file[key] !== undefined && file[key] !== '') { values[key] = file[key]; sources[key] = 'file'; }
    const envVal = env[KEYS[key].env];
    if (envVal !== undefined && envVal !== '') { values[key] = KEYS[key].parse(envVal); sources[key] = 'env'; }
    if (flags[key] !== undefined && flags[key] !== '') { values[key] = KEYS[key].parse(String(flags[key])); sources[key] = 'flag'; }
  }
  return { values, sources, file: configPath(env) };
}

/** Throw a CONFIG error unless server and token are both known. */
function requireServer(cfg) {
  const missing = ['server', 'token'].filter((k) => !cfg.values[k]);
  if (missing.length) {
    throw new CliError(`Not configured: missing ${missing.join(' and ')}`, {
      exitCode: EXIT.CONFIG,
      code: 'NOT_CONFIGURED',
      hint: 'Run `la config set server <url>` and `la config set token <token>` (or set LA_SERVER / LA_TOKEN).',
    });
  }
  return { server: cfg.values.server, token: cfg.values.token };
}

function maskSecret(v) {
  if (!v) return v;
  const s = String(v);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

module.exports = { KEYS, DEFAULTS, configPath, readFile, writeFile, setValue, unsetValue, load, requireServer, maskSecret };
