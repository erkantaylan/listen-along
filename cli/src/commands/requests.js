'use strict';

const { UsageError } = require('../errors');
const { Batch, runBatch } = require('../batch');
const { downloadAndUpload, isFatal } = require('../pipeline');
const { table } = require('../output');
const { ID_RE } = require('../youtube');
const download = require('./download');

const STATUSES = ['pending', 'fulfilled', 'all'];

function describe(r) {
  const what = [r.artist, r.title].filter(Boolean).join(' - ') || r.url || (r.youtube_id ? `yt:${r.youtube_id}` : '(empty request)');
  return `#${r.id} ${what}`;
}

/** Turn a request into a `download` input, or null if it has nothing to go on. */
function requestToInput(r) {
  const base = { request_id: r.id, label: describe(r), noPlaylist: true };
  if (r.youtube_id && ID_RE.test(r.youtube_id)) return { ...base, input: `yt:${r.youtube_id}` };
  if (r.url) return { ...base, input: r.url };
  const q = [r.artist, r.title].filter(Boolean).join(' - ');
  return q ? { ...base, input: q } : null;
}

const list = {
  name: 'list',
  summary: 'List song requests (default: pending)',
  usage: 'la requests [list] [--status pending|fulfilled|all]',
  description: 'Lists song requests made by listeners (GET /api/requests).',
  options: {
    status: { type: 'string', value: 'STATUS', desc: 'pending | fulfilled | all', default: 'pending' },
  },
  output: `Human: a table (ID, STATUS, ARTIST, TITLE, SOURCE, BY).
--json: { "requests": [ { "id", "youtube_id", "url", "title", "artist", "requested_by", "status", "created_at" } ] }`,
  examples: ['la requests', 'la requests --status all --json'],
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, 'Subcommands: list, fulfill, dismiss');
    const status = values.status || 'pending';
    if (!STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(', ')}`);
    const requests = await ctx.getApi().requests({ status });
    ctx.out.result({ requests }, () => {
      if (!requests.length) { ctx.out.print(`No ${status === 'all' ? '' : `${status} `}requests.`); return; }
      ctx.out.print(table(requests, [
        { title: 'ID', key: 'id' },
        { title: 'STATUS', key: 'status' },
        { title: 'ARTIST', key: 'artist', max: 30 },
        { title: 'TITLE', key: 'title', max: 40 },
        { title: 'SOURCE', get: (r) => (r.youtube_id ? `yt:${r.youtube_id}` : r.url || 'search'), max: 45 },
        { title: 'BY', key: 'requested_by', max: 20 },
      ]));
    });
  },
};

const fulfill = {
  name: 'fulfill',
  summary: 'Download + upload requested songs, marking each upload with its request_id',
  usage: ['la requests fulfill [options] <id>...', 'la requests fulfill [options] --all'],
  description: `For each request: if it has a youtube_id that video is downloaded; else its url is
used; else YouTube is searched for "<artist> - <title>" (same ranking as \`la download\`).
The song is then uploaded with request_id=<id> so the server can mark the request
fulfilled. Requests are not skipped based on the library: if the server already
has the song it answers 409 and the item is reported as skipped.

Same download behaviour/options as \`la download\` (m4a without re-encoding, tags,
cover, --sleep throttling, --keep, --dry-run, --ytdlp-args).`,
  options: {
    all: { type: 'boolean', desc: 'Fulfill every pending request' },
    ...download.DOWNLOAD_OPTIONS,
  },
  output: 'Same as `la download --help` (results carry "request_id").',
  examples: [
    'la requests fulfill --all',
    'la requests fulfill 12 15',
    'la requests fulfill --all --dry-run --json',
  ],
  async run(ctx, values, positionals) {
    if (!values.all && !positionals.length) throw new UsageError('Give request ids or --all', 'See `la requests fulfill --help`');
    if (values.all && positionals.length) throw new UsageError('Use either --all or request ids, not both');
    const api = ctx.getApi();
    const opts = { ...download.pipelineOptions(ctx, values), skipLibraryCheck: true };
    const batch = new Batch(ctx.out);
    const deps = { out: ctx.out, ytdlp: ctx.makeYtdlp(values['ytdlp-args']), media: ctx.makeMedia(), getApi: ctx.getApi, sleep: ctx.sleep };
    return runBatch(ctx.out, batch, async () => {
      let chosen;
      if (values.all) {
        chosen = await api.requests({ status: 'pending' });
        ctx.out.info(`${chosen.length} pending request(s)`);
      } else {
        const every = await api.requests({ status: 'all' });
        const byId = new Map(every.map((r) => [String(r.id), r]));
        chosen = [];
        for (const id of positionals) {
          const r = byId.get(String(id));
          if (!r) batch.add({ input: id, request_id: id, status: 'failed', error: 'No such request', code: 'NOT_FOUND' });
          else if (r.status && r.status !== 'pending') batch.add({ input: id, request_id: r.id, status: 'skipped', reason: `request is ${r.status}`, label: describe(r) });
          else chosen.push(r);
        }
      }
      const inputs = [];
      for (const r of chosen) {
        const input = requestToInput(r);
        if (input) inputs.push(input);
        else batch.add({ input: String(r.id), request_id: r.id, status: 'failed', error: 'Request has no youtube_id, url, title or artist', code: 'EMPTY_REQUEST', label: describe(r) });
      }
      if (inputs.length) await downloadAndUpload(deps, inputs, opts, batch);
    }, { dry_run: opts.dryRun || undefined });
  },
};

const dismiss = {
  name: 'dismiss',
  summary: 'Dismiss (reject) song requests without fulfilling them',
  usage: 'la requests dismiss <id>...',
  description: 'Calls POST /api/requests/<id>/dismiss for each id.',
  output: `--json: { "summary": { "total", "dismissed", "failed" }, "results": [ { "request_id", "status": "dismissed|failed", "error"? } ] }`,
  examples: ['la requests dismiss 7', 'la requests dismiss 7 8 9 --json'],
  async run(ctx, values, positionals) {
    if (!positionals.length) throw new UsageError('Give at least one request id');
    const api = ctx.getApi();
    const batch = new Batch(ctx.out);
    return runBatch(ctx.out, batch, async () => {
      for (const id of positionals) {
        try {
          await api.dismissRequest(id);
          batch.add({ request_id: id, label: `#${id}`, status: 'dismissed' });
        } catch (err) {
          if (isFatal(err)) throw err;
          batch.add({ request_id: id, label: `#${id}`, status: 'failed', error: err.message, code: err.code });
        }
      }
    });
  },
};

module.exports = {
  name: 'requests',
  aliases: ['req'],
  summary: 'List, fulfill or dismiss listeners\' song requests',
  usage: ['la requests [list] [--status pending|fulfilled|all]', 'la requests fulfill (--all | <id>...)', 'la requests dismiss <id>...'],
  description: 'Without a subcommand, lists pending requests (same as `la requests list`).',
  subcommands: [list, fulfill, dismiss],
  options: list.options,
  examples: [
    'la requests',
    'la requests fulfill --all',
    'la requests fulfill 12 --keep',
    'la requests dismiss 13',
  ],
  run: list.run,
  requestToInput,
};
