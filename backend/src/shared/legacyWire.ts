// =============================================================================
// COMPATIBILITY SHIM for the lobby -> playlist rename on the wire. REMOVE IT one
// release after the rename shipped (delete this file, then let the compiler
// show every caller; each one keeps only the new name).
// =============================================================================
//
// The socket events `lobby:*` became `playlist:*` and the payload field
// `lobbyId` became `playlistId`. The web app is reloaded with the server, but a
// tab opened before a deploy keeps its old code until it reloads: for one
// release the server
//   - accepts both names from a client: every `playlist:*` handler is also
//     registered under its `lobby:*` name (onPlaylistEvent), and a payload's
//     playlist id is `playlistId`, else `lobbyId` (playlistIdOf);
//   - emits what an old tab listens to as well: every `playlist:*` event also
//     under its `lobby:*` name (emitPlaylistEvent), and every payload that
//     names a playlist carries `lobbyId` next to `playlistId` (withLegacyId,
//     also on queue:update and users:updated, whose names did not change).
// Nothing else on the wire speaks lobby: the Android app and the la CLI use
// HTTP only (no lobby names there), and the worker protocol never had any.
// Tested by shared/legacyWire.test.ts and core/playlists/legacyClients.test.ts.

/** client -> server: the new event and the old name it is also accepted under. */
export const LEGACY_CLIENT_EVENTS = {
  'playlist:create': 'lobby:create',
  'playlist:join': 'lobby:join',
  'playlist:view': 'lobby:view',
  'playlist:unview': 'lobby:unview',
  'playlist:leave': 'lobby:leave',
  'playlist:pin': 'lobby:pin',
  'playlist:rename': 'lobby:rename',
} as const;

/** server -> client: the new event and the old name it is also emitted under. */
export const LEGACY_SERVER_EVENTS = {
  'playlist:created': 'lobby:created',
  'playlist:joined': 'lobby:joined',
  'playlist:not-found': 'lobby:not-found',
  'playlist:error': 'lobby:error',
  'playlist:user-joined': 'lobby:user-joined',
  'playlist:user-left': 'lobby:user-left',
  'playlist:updated': 'lobby:updated',
  'playlist:renamed': 'lobby:renamed',
  'playlist:pinned': 'lobby:pinned',
  'playlist:closed': 'lobby:closed',
} as const;

export type PlaylistClientEvent = keyof typeof LEGACY_CLIENT_EVENTS;
export type PlaylistServerEvent = keyof typeof LEGACY_SERVER_EVENTS;

/** What registers handlers (a Socket.IO socket). */
interface Listens {
  on(event: string, handler: (...args: never[]) => void): unknown;
}
/** What emits (a socket, a room, the server). */
interface Emits {
  emit(event: string, payload?: unknown): unknown;
}

/** A client payload that names a playlist, under either name (as sent: untrusted). */
export interface PlaylistIdPayload {
  playlistId?: unknown;
  /** the name before the rename */
  lobbyId?: unknown;
}

/** The playlist id a client sent: `playlistId`, else the old `lobbyId`. Untrusted, as sent. */
export function playlistIdOf(payload: PlaylistIdPayload | null | undefined): unknown {
  if (!payload) return undefined;
  return payload.playlistId !== undefined ? payload.playlistId : payload.lobbyId;
}

/**
 * A presence context an old tab sends ({ type: 'lobby', lobbyId }) read as the
 * new one ({ type: 'playlist', playlistId }); anything else is returned as is.
 * (What the server sends back is the new shape only: an old tab shows the song
 * without its playlist link until it reloads.)
 */
export function presenceContextOf<C>(context: C): C | { type: 'playlist'; playlistId: unknown } {
  const c = context as { type?: unknown; lobbyId?: unknown } | null | undefined;
  if (c && typeof c === 'object' && c.type === 'lobby') return { type: 'playlist', playlistId: c.lobbyId };
  return context;
}

/** Register `handler` for a playlist event under its new and its old name. */
export function onPlaylistEvent(socket: Listens, event: PlaylistClientEvent, handler: (...args: never[]) => void): void {
  socket.on(event, handler);
  socket.on(LEGACY_CLIENT_EVENTS[event], handler);
}

/** A payload that names a playlist, with the old `lobbyId` next to `playlistId` (for open old tabs). */
export function withLegacyId<P extends { playlistId?: unknown }>(payload: P): P & { lobbyId?: unknown } {
  return 'playlistId' in payload ? { ...payload, lobbyId: payload.playlistId } : payload;
}

/** Emit a playlist event under its new and its old name, each with both id fields. */
export function emitPlaylistEvent(target: Emits, event: PlaylistServerEvent, payload: { playlistId?: unknown } & Record<string, unknown>): void {
  const both = withLegacyId(payload);
  target.emit(event, both);
  target.emit(LEGACY_SERVER_EVENTS[event], both);
}
