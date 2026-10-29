'use strict';

const { UsageError } = require('../errors');

module.exports = {
  name: 'whoami',
  summary: 'Check server + token: show who the token belongs to (GET /api/me)',
  usage: 'la whoami',
  description: `Calls GET /api/me with the configured token. Useful as a connectivity/auth check:
exit 0 = OK, 3 = not configured, 4 = token rejected, 5 = server unreachable/error.`,
  output: '--json: { "name": "...", "server": "<url>" }',
  examples: ['la whoami', 'la whoami --json', 'LA_SERVER=http://localhost:3000 LA_TOKEN=dev la whoami'],
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`);
    const api = ctx.getApi();
    const me = await api.me();
    ctx.out.result({ ...me, server: api.server }, () => ctx.out.print(`${me?.name ?? '(unknown)'} @ ${api.server}`));
  },
};
