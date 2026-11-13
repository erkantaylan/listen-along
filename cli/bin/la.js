#!/usr/bin/env node
'use strict';

// `la worker` (unless this already is the worker's child process) runs under
// a tiny supervisor that restarts it after a self-update (src/supervisor.js).
// Contract kept across versions, since an older supervisor starts a newer
// child: LA_WORKER_CHILD=1 + the same arguments = run the command itself.
const argv = process.argv.slice(2);
const isChild = process.env.LA_WORKER_CHILD === '1';
const wantsHelp = argv.includes('--help') || argv.includes('-h');

if (argv[0] === 'worker' && !isChild && !wantsHelp) {
  require('../src/supervisor').runSupervisor({ argv }).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    },
  );
} else {
  const { main } = require('../src/cli');
  main(argv, { updateHint: true }).then(
    (code) => {
      process.exitCode = code;
      // The worker's child: never linger after it is done (a keep-alive
      // socket would hold up the supervisor's restart).
      if (isChild) setTimeout(() => process.exit(code), 3000).unref();
    },
    (err) => {
      process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    },
  );
}
