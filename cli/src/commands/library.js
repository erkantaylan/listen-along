'use strict';

const { UsageError } = require('../errors');
const { table, formatDuration } = require('../output');

function int(name, v, min) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}, got: ${v}`);
  return n;
}

module.exports = {
  name: 'library',
  aliases: ['lib', 'ls'],
  summary: 'List or search songs in the server library',
  usage: 'la library [options] [search words...]',
  description: `Lists library songs (GET /api/library). Search words are joined into the q= query
(the server matches them against title/artist/album). Paged with --limit/--offset;
--all fetches every page.`,
  options: {
    limit: { type: 'string', value: 'N', desc: 'Page size', default: 50 },
    offset: { type: 'string', value: 'N', desc: 'Skip the first N matches', default: 0 },
    all: { type: 'boolean', desc: 'Fetch all matching songs (ignores --limit/--offset)' },
  },
  output: `Human: a table (ID, YOUTUBE_ID, ARTIST, TITLE, ALBUM, LENGTH) and "N of TOTAL".
--json: { "songs": [ { "id", "youtube_id", "title", "artist", "album", "duration_sec",
          "uploaded_by", "created_at" } ], "total": N, "limit", "offset" }`,
  examples: [
    'la library',
    'la library daft punk',
    'la library --all --json',
    'la library --limit 20 --offset 40',
  ],
  async run(ctx, values, positionals) {
    const q = positionals.join(' ').trim() || undefined;
    const limit = int('limit', values.limit, 1) ?? 50;
    const offset = int('offset', values.offset, 0) ?? 0;
    const api = ctx.getApi();
    let songs;
    let total;
    if (values.all) {
      songs = await api.libraryAll({ q });
      total = songs.length;
    } else {
      ({ songs, total } = await api.library({ q, limit, offset }));
    }
    const doc = { songs, total, ...(values.all ? {} : { limit, offset }), ...(q ? { q } : {}) };
    ctx.out.result(doc, () => {
      if (!songs.length) { ctx.out.print(q ? `No songs match "${q}".` : 'Library is empty.'); return; }
      ctx.out.print(table(songs, [
        { title: 'ID', key: 'id' },
        { title: 'YOUTUBE_ID', key: 'youtube_id' },
        { title: 'ARTIST', key: 'artist', max: 28 },
        { title: 'TITLE', key: 'title', max: 40 },
        { title: 'ALBUM', key: 'album', max: 28 },
        { title: 'LENGTH', get: (s) => formatDuration(s.duration_sec) },
      ]));
      const from = values.all ? 1 : offset + 1;
      ctx.out.print(`\n${from}-${from + songs.length - 1} of ${total}`);
    });
  },
};
