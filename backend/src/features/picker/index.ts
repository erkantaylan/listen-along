// The web's "pick the video" lookups (picker.ts): built by index.js and handed
// to jobRoutes.js (POST /api/jobs/picks) and the resolver (titles). cleanPicks
// and MAX_PICKS check a chosen-videos list wherever one arrives (jobRoutes.js,
// queueSockets.js). yt-dlp itself (ytdlp.js) stays with the core: the resolver
// and the download jobs use it too.
export { createPicker, cleanPicks, MAX_PICKS, SEARCH_COUNT } from './picker.ts';
export type { Picker, PickerDeps, PickAnswer, PickError, PickVideo, MarkedVideo, KnownVideo } from './picker.ts';
