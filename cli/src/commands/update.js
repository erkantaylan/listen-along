'use strict';

const { UsageError, CliError, EXIT } = require('../errors');
const config = require('../config');
const update = require('../update');
const pkg = require('../../package.json');

module.exports = {
  name: 'update',
  summary: 'Update la from the server (the version it ships); --check only reports',
  usage: 'la update [--check]',
  description: `Asks the server which la it ships (GET /api/cli/latest) and, when that is
newer than this one, downloads it from the same server with your token
(GET /api/cli/bundle), checks its sha256, and replaces bin/, src/,
package.json and README.md of this install:
  ${update.installRoot()}
Other files there (test/, your own) are left alone. The swap is done with
renames; if any step fails the old files are put back. Never installs an older
or equal version. In a git checkout \`git status\` then shows the files as
changed until the next pull.

A running \`la worker\` keeps its old code until it restarts. Workers from la
0.4.0 on also update and restart themselves when the server offers a newer la
(see \`la worker --help\`).`,
  options: {
    check: { type: 'boolean', desc: 'Only say whether an update is available; change nothing' },
  },
  output: `--json: {"current","latest","update_available","updated","root"}
Exit: 0 up to date / updated / --check, 1 the update failed (old version kept)
or the server offers no updates, 3 not configured, 4 token refused, 5 server
unreachable.`,
  examples: [
    'la update --check',
    'la update',
  ],
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, 'See `la update --help`');
    const { server, token } = config.requireServer(ctx.cfg);
    const api = ctx.getApi();
    const latest = await update.fetchLatest(api);
    if (!latest) {
      throw new CliError('This server does not offer la updates (an older server, or it runs without cli/)', { code: 'NO_UPDATES', exitCode: EXIT.FAILURE });
    }
    const root = ctx.deps.installRoot || update.installRoot();
    const available = update.isNewer(latest.version, pkg.version);
    const doc = { current: pkg.version, latest: latest.version, update_available: available, updated: false, root };
    if (values.check || !available) {
      ctx.out.result(doc, () => ctx.out.print(available
        ? `la ${latest.version} is available (this is ${pkg.version}); run \`la update\``
        : `la ${pkg.version} is up to date (the server has ${latest.version})`));
      return EXIT.OK;
    }
    ctx.out.info(`Downloading la ${latest.version} from ${server}…`);
    const r = await update.performUpdate({ server, token, latest, current: pkg.version, root, fetch: ctx.deps.fetch, fs: ctx.deps.updateFs });
    doc.updated = r.updated;
    ctx.out.result(doc, () => {
      ctx.out.print(r.reason === 'already_on_disk'
        ? `la ${latest.version} is already installed in ${root}`
        : `Updated la ${pkg.version} → ${latest.version} in ${root}`);
      if (r.git) ctx.out.info('This is a git checkout: `git status` shows the files as changed until the next pull.');
      ctx.out.info('Restart a running `la worker` to use it.');
    });
    return EXIT.OK;
  },
};
