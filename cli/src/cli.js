'use strict';

const { parseArgs } = require('util');
const { Output } = require('./output');
const { EXIT, CliError, UsageError } = require('./errors');
const config = require('./config');
const { ApiClient } = require('./api');
const { YtDlp } = require('./ytdlp');
const { Media } = require('./media');
const { splitArgs } = require('./proc');
const pkg = require('../package.json');

/** Options accepted by every command. */
const GLOBAL_OPTIONS = {
  json: { type: 'boolean', desc: 'Machine-readable output: one JSON document on stdout; errors as JSON on stderr' },
  quiet: { type: 'boolean', short: 'q', desc: 'No progress messages on stderr' },
  verbose: { type: 'boolean', short: 'v', desc: 'Extra diagnostics on stderr (incl. live yt-dlp output)' },
  server: { type: 'string', value: 'URL', desc: 'Server base URL for this call (overrides LA_SERVER and config)' },
  token: { type: 'string', value: 'TOKEN', desc: 'API token for this call (overrides LA_TOKEN and config)' },
  help: { type: 'boolean', short: 'h', desc: 'Show help for this command' },
};

const COMMANDS = [
  require('./commands/config'),
  require('./commands/whoami'),
  require('./commands/download'),
  require('./commands/upload'),
  require('./commands/requests'),
  require('./commands/library'),
];

const EXIT_CODES_TEXT = `Exit codes:
  0  success (batch: every item uploaded/skipped/dismissed)
  1  failure (batch: at least one item failed; see summary)
  2  usage error (unknown command/option, bad argument)
  3  not configured (server or token missing)
  4  authentication failed (server returned 401/403)
  5  server error or server unreachable
  6  missing dependency (yt-dlp, ffmpeg or ffprobe not installed)`;

function rootHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return `la ${pkg.version} — command-line client for a listen-along music library server

Downloads songs from YouTube with yt-dlp on this machine (as AAC m4a, no
re-encoding, with title/artist/cover tags) and uploads them to the server's
library; uploads local audio files; fulfills listeners' song requests.

Usage:
  la <command> [options] [arguments]
  la <command> --help        detailed help and examples for a command

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join('\n')}

Global options (accepted by every command):
${formatOptions(GLOBAL_OPTIONS)}
  -V, --version         Print the CLI version

Configuration (precedence: flag > environment > config file):
  LA_SERVER, LA_TOKEN   server URL and API token
  LA_KEEP_DIR           local copy directory for --keep (default ~/Music/listen-along)
  LA_SLEEP              seconds between YouTube downloads (default 3)
  LA_YTDLP_ARGS         extra yt-dlp arguments
  LA_CONFIG             config file path (default ~/.config/listen-along/config.json)
  LA_YTDLP_BIN, LA_FFMPEG_BIN, LA_FFPROBE_BIN   tool paths

Output: results go to stdout, progress/warnings/errors to stderr. With
--json, stdout is exactly one JSON document.

${EXIT_CODES_TEXT}

Examples:
  la config set server https://listen.example.com
  la config set token 3f9c...
  la whoami
  la download "Daft Punk - Digital Love"
  la download https://www.youtube.com/playlist?list=PL... --sleep 5
  la upload ~/Music/album/ --artist "Some Band"
  la requests fulfill --all --json
  la library "daft punk"
`;
}

function formatOptions(options) {
  const rows = Object.entries(options).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.type === 'string' ? ` <${o.value || 'VALUE'}>` : ''}`;
    return [flag, o.desc + (o.default !== undefined ? ` (default: ${o.default})` : '')];
  });
  const w = Math.max(20, ...rows.map((r) => r[0].length));
  return rows.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`).join('\n');
}

/** Help text for a command spec (or a subcommand spec). */
function commandHelp(cmd, parent) {
  const full = parent ? `${parent.name} ${cmd.name}` : cmd.name;
  let s = `la ${full} — ${cmd.summary}\n\nUsage:\n${[].concat(cmd.usage).map((u) => `  ${u}`).join('\n')}\n`;
  if (cmd.description) s += `\n${cmd.description.trim()}\n`;
  if (cmd.subcommands) {
    const w = Math.max(...cmd.subcommands.map((c) => c.name.length));
    s += `\nSubcommands:\n${cmd.subcommands.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`).join('\n')}\n`;
    s += `\nRun \`la ${full} <subcommand> --help\` for details.\n`;
  }
  if (cmd.options && Object.keys(cmd.options).length) s += `\nOptions:\n${formatOptions(cmd.options)}\n`;
  s += `\nGlobal options:\n${formatOptions(GLOBAL_OPTIONS)}\n`;
  if (cmd.output) s += `\nOutput:\n${cmd.output.trim().split('\n').map((l) => `  ${l}`).join('\n')}\n`;
  if (cmd.examples) s += `\nExamples:\n${cmd.examples.map((e) => `  ${e}`).join('\n')}\n`;
  return s;
}

function parse(cmd, argv) {
  const options = {};
  for (const [name, o] of Object.entries({ ...GLOBAL_OPTIONS, ...(cmd.options || {}) })) {
    options[name] = { type: o.type };
    if (o.short) options[name].short = o.short;
    if (o.multiple) options[name].multiple = true;
  }
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message.replace(/\. To specify a positional argument.*$/s, ''), `See \`la ${cmd.fullName || cmd.name} --help\``);
  }
}

/**
 * Build the per-invocation context handed to commands. Heavy collaborators
 * (API client, yt-dlp, ffmpeg) are created lazily and can be injected by tests.
 */
function makeContext({ env, values, out, deps }) {
  const flags = { server: values.server, token: values.token };
  let cfg;
  const ctx = {
    env,
    out,
    deps,
    get cfg() {
      if (!cfg) cfg = config.load(env, flags);
      return cfg;
    },
    getApi() {
      const { server, token } = config.requireServer(ctx.cfg);
      return deps.api ? deps.api({ server, token }) : new ApiClient({ server, token, fetch: deps.fetch });
    },
    ytdlpArgs(extra) {
      return [...splitArgs(ctx.cfg.values['ytdlp-args']), ...splitArgs(extra || [])];
    },
    makeYtdlp(extra) {
      const opts = { extraArgs: ctx.ytdlpArgs(extra), env, onStderr: out.verbose ? (d) => out.stderr.write(d) : undefined };
      return deps.ytdlp ? deps.ytdlp(opts) : new YtDlp(opts);
    },
    makeMedia() {
      return deps.media ? deps.media({ env }) : new Media({ env });
    },
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  return ctx;
}

/**
 * Entry point. Never calls process.exit; returns the exit code.
 * @param {string[]} argv - arguments after the program name
 * @param {object} [io] - { env, stdout, stderr, deps } (injectable for tests)
 */
async function main(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const deps = io.deps || {};
  const wantsJson = argv.includes('--json');
  let out = new Output({ stdout, stderr, json: wantsJson });

  try {
    const first = argv[0];
    if (!first || first === '--help' || first === '-h' || first === 'help') {
      const target = first === 'help' && argv[1] ? COMMANDS.find((c) => c.name === argv[1]) : null;
      stdout.write(target ? commandHelp(target) : rootHelp());
      return EXIT.OK;
    }
    if (first === '--version' || first === '-V') {
      out.result({ version: pkg.version }, () => out.print(pkg.version));
      return EXIT.OK;
    }
    let cmd = COMMANDS.find((c) => c.name === first || (c.aliases || []).includes(first));
    if (!cmd) {
      throw new UsageError(`Unknown command: ${first}`, `Commands: ${COMMANDS.map((c) => c.name).join(', ')}. Run \`la --help\`.`);
    }
    let rest = argv.slice(1);
    let parent = null;
    if (cmd.subcommands) {
      const sub = cmd.subcommands.find((s) => s.name === rest[0]);
      if (sub) {
        parent = cmd;
        cmd = { ...sub, fullName: `${parent.name} ${sub.name}` };
        rest = rest.slice(1);
      } else if (rest[0] && !rest[0].startsWith('-') && !cmd.run) {
        throw new UsageError(`Unknown subcommand: ${cmd.name} ${rest[0]}`, `Subcommands: ${cmd.subcommands.map((s) => s.name).join(', ')}`);
      }
    }
    const { values, positionals } = parse(cmd, rest);
    out = new Output({ stdout, stderr, json: !!values.json, quiet: !!values.quiet, verbose: !!values.verbose });
    if (values.help || !cmd.run) {
      stdout.write(commandHelp(cmd, parent));
      return values.help ? EXIT.OK : EXIT.USAGE;
    }
    const ctx = makeContext({ env, values, out, deps });
    const code = await cmd.run(ctx, values, positionals);
    return code ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CliError) {
      out.error(err);
      return err.exitCode;
    }
    out.error({ code: 'INTERNAL', message: err && err.stack ? (out.verbose ? err.stack : err.message) : String(err) });
    return EXIT.FAILURE;
  }
}

module.exports = { main, commandHelp, rootHelp, COMMANDS, GLOBAL_OPTIONS };
