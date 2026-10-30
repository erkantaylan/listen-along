'use strict';

const os = require('os');
const config = require('../config');
const { UsageError } = require('../errors');

const KEY_LIST = Object.entries(config.KEYS)
  .map(([k, v]) => `  ${k.padEnd(11)} ${v.description} [env ${v.env}]`).join('\n');

function view(ctx) {
  const cfg = ctx.cfg;
  const entries = {};
  for (const key of Object.keys(config.KEYS)) {
    const raw = cfg.values[key];
    entries[key] = {
      value: config.KEYS[key].secret ? (raw ? config.maskSecret(raw) : null) : (raw ?? null),
      source: cfg.sources[key] || 'unset',
    };
  }
  return { file: cfg.file, values: entries };
}

const list = {
  name: 'list',
  summary: 'Show the effective configuration and where each value comes from',
  usage: 'la config list',
  description: 'Prints every key with its effective value and source (default, file, env, flag).\nThe token is masked.',
  output: '--json: { "file": "<path>", "values": { "<key>": { "value": ..., "source": "default|file|env|flag|unset" } } }',
  examples: ['la config list', 'la config list --json'],
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, 'Did you mean `la config set <key> <value>`?');
    const v = view(ctx);
    ctx.out.result(v, () => {
      ctx.out.print(`# ${v.file}`);
      for (const [k, e] of Object.entries(v.values)) ctx.out.print(`${k} = ${e.value ?? '(unset)'}   [${e.source}]`);
    });
  },
};

const set = {
  name: 'set',
  summary: 'Store a config value (file is created with mode 600)',
  usage: 'la config set <key> <value>',
  description: `Keys:\n${KEY_LIST}\n\nEnvironment variables override stored values; --server/--token flags override both.`,
  output: '--json: { "key": "...", "value": "...", "file": "<path>" } (token value masked)',
  examples: [
    'la config set server https://listen.example.com',
    'la config set token 3f9c2a...',
    'la config set keep-dir ~/Music/listen-along',
    'la config set sleep 5',
    'la config set ytdlp-args "--cookies-from-browser firefox"',
  ],
  async run(ctx, values, positionals) {
    if (positionals.length !== 2) {
      throw new UsageError('Expected exactly: la config set <key> <value>', `Keys: ${Object.keys(config.KEYS).join(', ')}`);
    }
    const key = positionals[0];
    let value = positionals[1];
    if (key === 'keep-dir') value = value.replace(/^~(?=$|\/)/, os.homedir());
    const r = config.setValue(key, value, ctx.env);
    const shown = config.KEYS[key].secret ? config.maskSecret(r.value) : r.value;
    ctx.out.result({ key, value: shown, file: r.file }, () => ctx.out.print(`Set ${key} = ${shown} in ${r.file}`));
  },
};

const get = {
  name: 'get',
  summary: 'Print one effective config value (unmasked)',
  usage: 'la config get <key>',
  description: `Prints the raw effective value (env and flags applied). Exits 1 if unset.\n\nKeys:\n${KEY_LIST}`,
  output: '--json: { "key": "...", "value": ..., "source": "..." }',
  examples: ['la config get server', 'TOKEN=$(la config get token)'],
  async run(ctx, values, positionals) {
    if (positionals.length !== 1) throw new UsageError('Expected exactly: la config get <key>');
    const key = positionals[0];
    if (!config.KEYS[key]) throw new UsageError(`Unknown config key: ${key}`, `Valid keys: ${Object.keys(config.KEYS).join(', ')}`);
    const value = ctx.cfg.values[key];
    ctx.out.result({ key, value: value ?? null, source: ctx.cfg.sources[key] || 'unset' }, () => {
      if (value !== undefined) ctx.out.print(String(value));
    });
    return value === undefined ? 1 : 0;
  },
};

const unset = {
  name: 'unset',
  summary: 'Remove a stored config value',
  usage: 'la config unset <key>',
  output: '--json: { "key": "...", "removed": true|false, "file": "<path>" }',
  examples: ['la config unset token'],
  async run(ctx, values, positionals) {
    if (positionals.length !== 1) throw new UsageError('Expected exactly: la config unset <key>');
    const r = config.unsetValue(positionals[0], ctx.env);
    ctx.out.result(r, () => ctx.out.print(r.removed ? `Removed ${r.key}` : `${r.key} was not set`));
  },
};

const pathCmd = {
  name: 'path',
  summary: 'Print the config file path',
  usage: 'la config path',
  output: '--json: { "file": "<path>" }',
  async run(ctx) {
    const file = config.configPath(ctx.env);
    ctx.out.result({ file }, () => ctx.out.print(file));
  },
};

module.exports = {
  name: 'config',
  summary: 'Get/set server URL, token and defaults (~/.config/listen-along/config.json)',
  usage: ['la config <set|get|unset|list|path> ...', 'la config            (same as `la config list`)'],
  description: `Configuration lives in ~/.config/listen-along/config.json (mode 600; override the
path with LA_CONFIG). Precedence: --server/--token flags > env vars > file > defaults.

Keys:
${KEY_LIST}`,
  subcommands: [set, get, unset, list, pathCmd],
  examples: [
    'la config set server https://listen.example.com',
    'la config set token 3f9c2a...',
    'la config list --json',
  ],
  run: list.run,
};
