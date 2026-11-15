// The library's converted parts so far (the rest is still library.js and friends,
// CommonJS, until the core moves here): the silence measurements behind the web
// player's "Skip silence".
export { createSilenceScanner, measureFile, parseSilencedetect, edgeSilence, SILENCE_NOISE_DB, SILENCE_MIN_S } from './silence.ts';
export type { SilenceScanner, SilenceStats, EdgeSilence } from './silence.ts';
export { createSilenceRouter, silenceOf } from './silenceRoutes.ts';
export type { SongSilence } from './silenceRoutes.ts';
