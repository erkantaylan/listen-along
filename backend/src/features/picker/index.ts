// The web's "pick the video" lookups (picker.ts): built by index.js and handed
// to the job routes (POST /api/jobs/picks) and the resolver (titles). The
// chosen-videos list that comes back is checked by core/requests (cleanPicks,
// MAX_PICKS) wherever it arrives (POST /api/jobs, socket queue:add); yt-dlp and
// Spotify are core/requests' too.
export { createPicker, SEARCH_COUNT } from './picker.ts';
export type { Picker, PickerDeps, PickAnswer, PickError, PickVideo, MarkedVideo, KnownVideo } from './picker.ts';
