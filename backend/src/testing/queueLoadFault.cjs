// Tests only: preloaded into a test server (node --require) to make ONE query
// fail, the load of a playlist's songs, while the file named by
// QUEUE_LOAD_FAULT_FILE exists. Every other query (the writes too) still
// reaches the database, so a test can show that a write on a playlist whose
// songs did not load changes nothing because the server refused it, not
// because the database was down.
const fs = require('fs');
const { Client } = require('pg');

const flag = process.env.QUEUE_LOAD_FAULT_FILE;
const LOAD = /FROM queue_songs WHERE playlist_id = \$1 ORDER BY sort_order/;
const query = Client.prototype.query;
Client.prototype.query = function (config, ...rest) {
  const text = typeof config === 'string' ? config : config && config.text;
  if (flag && LOAD.test(text || '') && fs.existsSync(flag)) {
    const err = new Error('queue load fault (test)');
    const cb = rest.find((a) => typeof a === 'function');
    if (cb) { process.nextTick(cb, err); return undefined; }
    return Promise.reject(err);
  }
  return query.call(this, config, ...rest);
};
