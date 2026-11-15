// presence.js moved to features/social/presence.ts; require('./presence') now
// finds this folder. Only social.test.js still requires that path: it also
// covers frontend/chat-format.js and moves with the frontend conversion.
// Delete this folder once that test imports features/social.
module.exports = require('../features/social/presence.ts');
