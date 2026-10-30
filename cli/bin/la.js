#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
