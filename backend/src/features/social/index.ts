// The global chat and the people panel (social.ts), the chat stores (chat.ts)
// and presence (presence.ts). main.ts builds presence at once and social in
// start(), once it knows whether there is a database; app/sockets.ts attaches
// social per connection; listen-along gets presence and social.nameOf.
export { createSocial, isEligible } from './social.ts';
export type { Social, SocialDeps, SocialIo, SocialSocket, Person } from './social.ts';
export * as chat from './chat.ts';
export type { ChatMessage, ChatStore, RateLimiter } from './chat.ts';
export { createPresence, viewNowPlaying, normalizeReport } from './presence.ts';
export type { Presence, NowPlayingEntry, NowPlayingView, PlayContext } from './presence.ts';
