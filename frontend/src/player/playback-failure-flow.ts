// The state behind "a song failed to play": which songs are greyed, the failure
// streak, and the automatic reports waiting to be sent. No DOM and no network of
// its own: everything it needs to ask is injected, so the whole flow (error ->
// verdict -> grey / hold -> proof -> send, with a replace, a retry or another
// song in between) is tested in playback-failure-flow.test.ts.
// playback-failures.js wires it to the <audio> element. Decisions are
// playback-failure-rules.ts.
//
// Two things keep a good song from being reported:
// - Every await can be overtaken. Each key has a generation, bumped when the
//   song plays, is replaced or is cleared; a verdict or a held report from an
//   older generation is thrown away. So is a verdict about a file the player
//   no longer holds for that song (a new version was loaded meanwhile).
// - A held report needs proof at the moment it is sent, asked from the server
//   past the browser cache: the song that plays now is served (a control: a
//   cached song can sound while the server's storage is gone), and the held
//   song still answers with the same fault. Anything else drops the report.
//
// All of this is only a first filter that saves pointless requests. The server
// checks the song itself before it stores an automatic report (backend
// songVerify.js) and may refuse; a refusal is final for this page load, the
// song just stays greyed.
//
// Everything here belongs to the signed-in account: when that changes (logout,
// another login without a reload) the greyed set, the streak and the held
// reports are dropped, so nothing is ever filed under another account.
import { MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED, STREAK_LIMIT, failureCause, failureAction, isServed, sameFault, settleReports, trackKeys } from './playback-failure-rules.ts';
import type { BytesVerdict, FailureAction, FailureCause, ProbeAnswer } from './playback-failure-rules.ts';
import type { Track } from '../shared/types.ts';

// A track as the flow sees it, whatever trackKeys can key (the player's Track).
export type FailureTrack = Partial<Track>;

export interface FailureFlowDeps<T extends FailureTrack> {
  online: () => boolean;
  probe: (src: string) => Promise<ProbeAnswer>;
  canPlay: (mime: string | null | undefined) => boolean;
  confirm: (q: { src: string; mime: string | null | undefined; errorCode: number; position: number }) => Promise<BytesVerdict | null>;
  current?: () => { keys: string[]; src: string } | null;
  user?: () => string | null;
  hasReport: (track: T) => boolean;
  report: (track: T) => Promise<boolean>;
  changed: () => void;
}

/** failure(): thrown away, or what was decided. */
export type FailureResult =
  | { stale: true }
  | { stale: false; cause: FailureCause; action: FailureAction; onlyNotInLibrary: boolean };

interface HeldReport<T> {
  keys: string[];
  track: T;
  src: string;
  cause: FailureCause;
  version: string | null | undefined;
  stamp: string;
}

/**
 * deps:
 *   online():            navigator.onLine
 *   probe(src):          the url asked again with cache 'no-store' ->
 *                        { status, code?, mime?, version? } | { failed: true }
 *   canPlay(mime):       this browser says "probably" to that format
 *   confirm({ src, mime, errorCode, position }): the whole file fetched and
 *                        played from memory -> 'undecodable' | 'decodes' | 'incomplete'
 *   current():           what the player holds now: { keys, src } | null
 *                        (src: what the <audio> element really loaded)
 *   user():              the signed-in account's id, or null
 *   hasReport(track):    the song has an open report already
 *   report(track):       file the automatic report -> true when the server
 *                        stored it, false when it refused or it was not needed
 *   changed():           the greyed set changed (lists re-render)
 */
export function createFailureFlow<T extends FailureTrack>(deps: FailureFlowDeps<T>) {
  const failed = new Set<string>();       // keys of songs that failed here
  const tried = new Set<string>();        // keys already put up for a report in this page load
  const generation = new Map<string, number>();   // key -> number
  let held: HeldReport<T>[] = [];         // { keys, track, src, cause, version, stamp }
  let streak = 0;
  let streakCauses: FailureCause[] = [];
  let user = deps.user ? deps.user() : null;

  function reset(): void {
    const any = failed.size > 0;
    failed.clear();
    tried.clear();
    for (const key of generation.keys()) generation.set(key, (generation.get(key) as number) + 1); // pending verdicts go stale
    held = [];
    streak = 0;
    streakCauses = [];
    if (any) deps.changed();
  }

  // Another account than the one all this was collected for: start empty.
  function sameUser(): boolean {
    const now = deps.user ? deps.user() : null;
    if (now === user) return true;
    user = now;
    reset();
    return false;
  }

  const stampOf = (keys: readonly string[]) => keys.map((key) => generation.get(key) || 0).join(',');
  const bump = (keys: readonly string[]) => { for (const key of keys) generation.set(key, (generation.get(key) || 0) + 1); };

  // The player moved on to another file of the same song (its audio was replaced).
  function otherVersionLoaded(keys: readonly string[], src: string): boolean {
    const now = deps.current ? deps.current() : null;
    return !!now && !!now.src && now.src !== src && (now.keys || []).some((key) => keys.includes(key));
  }

  function isFailed(track: FailureTrack | null | undefined): boolean {
    return failed.size > 0 && trackKeys(track).some((key) => failed.has(key));
  }

  /** The song is worth playing again (replaced, or it reached the library). forget: it may be reported anew. */
  function clear(keys: readonly string[], { forget = false }: { forget?: boolean } = {}): void {
    bump(keys);
    let any = false;
    for (const key of keys) {
      any = failed.delete(key) || any;
      if (forget) tried.delete(key);
    }
    held = held.filter((item) => !item.keys.some((key) => keys.includes(key)));
    if (any) deps.changed();
  }

  /**
   * The <audio> element raised an error for `track`, loaded from `src`.
   * driven: a driver steers playback (listening along).
   * Resolves to { stale: true } or { stale: false, cause, action, onlyNotInLibrary };
   *   stale: the song played, was replaced or was reloaded while the cause was
   *   looked up: nothing was greyed, nothing is to be done.
   */
  async function failure({ track, src, errorCode = 0, position = 0, driven = false }: {
    track: T;
    src: string;
    errorCode?: number;
    position?: number;
    driven?: boolean;
  }): Promise<FailureResult> {
    sameUser();
    const owner = user;
    const keys = trackKeys(track);
    const stamp = stampOf(keys);
    const count = driven ? 0 : ++streak;

    const online = deps.online();
    const answer = online ? await deps.probe(src) : null;
    const canPlay = isServed(answer) && deps.canPlay(answer.mime);
    const mediaFault = errorCode === MEDIA_ERR_DECODE || errorCode === MEDIA_ERR_SRC_NOT_SUPPORTED;
    const bytes = canPlay && mediaFault ? await deps.confirm({ src, mime: answer.mime, errorCode, position }) : null;
    const cause = failureCause({ online, errorCode, probe: answer, canPlay, bytes });

    if (!sameUser() || owner !== user) return { stale: true };
    if (stampOf(keys) !== stamp || otherVersionLoaded(keys, src)) {
      if (!driven && streak > 0) streak -= 1;
      return { stale: true };
    }

    const action = failureAction({
      cause,
      streak: count,
      driven,
      tried: keys.some((key) => tried.has(key)),
      reported: deps.hasReport(track),
    });
    for (const key of keys) failed.add(key);
    if (!driven) streakCauses.push(cause);
    const onlyNotInLibrary = streakCauses.length > 0 && streakCauses.every((c) => c === 'not-in-library');
    if (action.report) {
      for (const key of keys) tried.add(key);
      held.push({ keys, track, src, cause, version: answer && answer.version, stamp });
    }
    if (action.stop) {
      held = settleReports(held, 'stopped').held;
      streak = 0;
      streakCauses = [];
    }
    deps.changed();
    return { stale: false, cause, action, onlyNotInLibrary };
  }

  /**
   * `track`, loaded from `src`, is sounding. Its grey goes, and the held
   * reports are settled.
   * Resolves to the tracks that were reported.
   */
  async function played({ track, src }: { track: T; src: string }): Promise<T[]> {
    sameUser();
    const owner = user;
    streak = 0;
    streakCauses = [];
    const keys = trackKeys(track);
    bump(keys);
    let any = false;
    for (const key of keys) any = failed.delete(key) || any;
    if (any) deps.changed();

    const { send } = settleReports(held, 'played', keys);
    held = [];
    if (!send.length) return [];
    // The control: is the song that plays now served by the server now?
    if (!isServed(await deps.probe(src))) return [];
    const sent: T[] = [];
    for (const item of send) {
      const again = await deps.probe(item.src);
      if (!sameUser() || owner !== user) return sent;
      if (!sameFault(item.cause, item.version, again)) continue;
      if (stampOf(item.keys) !== item.stamp || otherVersionLoaded(item.keys, item.src)) continue;
      if (deps.hasReport(item.track)) continue;
      try {
        // The server has the last word: false = it did not find the song broken.
        if (await deps.report(item.track)) sent.push(item.track);
      } catch { /* not sent: it is tried again in another session */ }
    }
    return sent;
  }

  return { isFailed, clear, reset, failure, played, STREAK_LIMIT };
}
