// Artists: GET /api/artists and /api/artists/:key/songs (artists.ts), mounted
// by index.js; credits split into artists by artistCredits.ts.
export { createArtistRouter } from './artists.ts';
export type { ArtistSummary, ArtistSongs } from './artists.ts';
