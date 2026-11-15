// Song requests (core): what a web user queued that is not in the library yet
// (requests.ts), the resolver that turns what they typed into a library song or
// a request (songResolver.ts), and the metadata lookups it uses: yt-dlp (search
// and playlist listing only; the server never downloads audio) and Spotify
// track pages. The download jobs, the picker and /health use ytdlp too.
export * as requests from './requests.ts';
export type { SongRequest, SongRequestRow, RequestStatus, NewRequest } from './requests.ts';
export { createResolver, MAX_PLAYLIST } from './songResolver.ts';
export type {
  Resolver, ResolverDeps, ResolveArgs, Resolved, ResolvedItem, ProposedRequest, ResolverLibrary, ResolverYtdlp, ResolverSpotify,
} from './songResolver.ts';
// A chosen-videos list from the web's pick dialog (POST /api/jobs, socket queue:add).
export { cleanPicks, MAX_PICKS } from './picks.ts';
export * as ytdlp from './ytdlp.ts';
export type { PlaylistEntry, PlaylistEntries, SearchHit, YtdlpError } from './ytdlp.ts';
export * as spotify from './spotify.ts';
export type { SpotifyLink, SpotifyTrack } from './spotify.ts';
