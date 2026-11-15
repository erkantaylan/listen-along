// db.js moved to shared/db.ts; require('./db') now finds this folder. Only
// queue-rows.test.js still requires that path: it also covers frontend files
// and moves with the frontend conversion. Delete this folder once that test
// requires shared/db.ts. The same object: tests replace its functions.
module.exports = require('../shared/db.ts');
