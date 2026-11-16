/**
 * Playlist membership over Socket.IO (the web app). A socket is a *member* of
 * at most one playlist (listed as a listener, its now-playing shown) and may
 * *view* one other (in its room for queue updates, not listed):
 *
 *   lobby:create   { name?, visibility?, asViewer? }  -> lobby:created
 *   lobby:join     { lobbyId }                        -> lobby:joined + queue:update | lobby:not-found
 *   lobby:view     { lobbyId }                        -> lobby:joined { viewing } + queue:update | lobby:not-found
 *   lobby:unview, lobby:leave { lobbyId }
 *   user:update    (name / emoji from the account)    -> users:updated
 *   listener:now-playing { track }                    -> users:updated
 *   lobby:pin      { lobbyId, pinned }                -> lobby:pinned (the old shared flag)
 *   lobby:rename   { lobbyId, name }                  -> lobby:renamed
 *
 * (The events and `lobbyId`, the playlist's id, keep their old names on the wire.)
 * Private playlists are lobby:not-found to everyone but their owner
 * (visiblePlaylist / editablePlaylist, playlistAccess.ts); never trust an id the
 * client sends. register() returns visiblePlaylist / editablePlaylist for the
 * queue handlers and what to do on disconnect.
 */

import * as access from './playlistAccess.ts';
import type * as playlistStore from './playlist.ts';
import type { Listener, PlaylistWithUsers } from './playlist.ts';
import type { OwnerNames } from './playlistRoutes.ts';
import type { Queue, QueueSong } from '../queue/index.ts';
import type { AppSocket, Playlist } from '../../shared/types.ts';
import type { IncomingHttpHeaders } from 'node:http';

/** What the handlers use of the Socket.IO server (the real one fits). */
export interface PlaylistIo {
  to(room: string): { emit(event: string, payload?: unknown): unknown };
}

export interface PlaylistSocketsDeps {
  io: PlaylistIo;
  /** playlist.ts */
  playlist: typeof playlistStore;
  /** queue.ts */
  getQueueAsync: (playlistId: string) => Promise<Queue>;
  adminAuth: { isAdmin(req: { headers: IncomingHttpHeaders }): boolean };
  getSocial: () => { lobbyChanged(playlistId: string): void } | null;
  /** playlistRoutes' (one cache) */
  ownerNames: OwnerNames;
  notifyPlaylistsChanged: (playlist: Playlist, opts?: { everyone?: boolean }) => void;
  emitUnavailableSongs: (target: { emit(event: string, payload?: unknown): unknown }, songs: QueueSong[]) => Promise<void> | void;
}

/** The connection's account helpers (app/sockets.ts). */
export interface PlaylistSocketContext {
  /** from the handshake, never the client */
  userId: string;
  /** joins APP_ROOM when it is */
  isApproved: () => Promise<boolean>;
  displayName: (clientName: unknown) => Promise<string>;
  displayEmoji: (clientEmoji: unknown) => Promise<string | null>;
  refusePending: (event?: string) => void;
}

/** What register() hands to the queue handlers and the disconnect. */
export interface PlaylistConnection {
  visiblePlaylist: (playlistId: unknown) => Promise<PlaylistWithUsers | null>;
  editablePlaylist: (playlistId: unknown) => Promise<PlaylistWithUsers | null>;
  disconnected: () => void;
}

export interface PlaylistSockets {
  register(socket: AppSocket, ctx: PlaylistSocketContext): PlaylistConnection;
}

/** A client's playlist event (every field as sent). */
interface PlaylistPayload {
  lobbyId?: unknown;
  username?: unknown;
  emoji?: unknown;
  name?: unknown;
  visibility?: unknown;
  asViewer?: unknown;
  pinned?: unknown;
  track?: unknown;
}

export function createPlaylistSockets({ io, playlist, getQueueAsync, adminAuth, getSocial, ownerNames, notifyPlaylistsChanged, emitUnavailableSongs }: PlaylistSocketsDeps): PlaylistSockets {
  function handleLeave(socket: AppSocket, playlistId: string) {
    const user = playlist.getPlaylistUsers(playlistId).find(u => u.socketId === socket.id);
    // leavePlaylist is async but removes the user synchronously; the rest is the
    // last-activity write.
    Promise.resolve(playlist.leavePlaylist(playlistId, socket.id)).catch(() => {});
    socket.leave(playlistId);
    if (user) {
      socket.to(playlistId).emit('lobby:user-left', {
        lobbyId: playlistId,
        user,
        users: playlist.getPlaylistUsers(playlistId)
      });
      console.log(`User ${user.username} left lobby ${playlistId}`);
    }
  }

  /**
   * The playlist handlers of one connection.
   */
  function register(socket: AppSocket, { userId, isApproved, displayName, displayEmoji, refusePending }: PlaylistSocketContext): PlaylistConnection {
    // A socket is a *member* of at most one playlist (currentPlaylist: listed as a
    // listener, now-playing) and may additionally *view* one other playlist
    // (viewingPlaylist: in its Socket.IO room for queue updates and adding
    // songs, but not listed). The web app keeps the member playlist on the one it
    // is playing from while the user browses other playlists.
    let currentPlaylist: string | null = null;
    let viewingPlaylist: string | null = null;

    // The playlist if this socket may see it, else null (callers answer as if
    // it did not exist, so private playlists cannot be probed).
    const visiblePlaylist = async (playlistId: unknown): Promise<PlaylistWithUsers | null> => {
      if (!playlistId || typeof playlistId !== 'string') return null;
      if (!(await isApproved())) return null;
      const l = await playlist.getPlaylistAsync(playlistId);
      return access.canView(l, userId) ? l! : null;
    };
    // Mutations: the socket must be in the playlist's room and allowed to edit.
    const editablePlaylist = async (playlistId: unknown): Promise<PlaylistWithUsers | null> => {
      if (!verifyMembership(playlistId)) return null;
      if (!(await isApproved())) return null;
      const l = await playlist.getPlaylistAsync(playlistId);
      return access.canEdit(l, userId) ? l! : null;
    };
    const visibleTo = (l: Playlist) => access.canView(l, userId);

    const stopViewing = () => {
      if (viewingPlaylist && viewingPlaylist !== currentPlaylist) socket.leave(viewingPlaylist);
      viewingPlaylist = null;
    };

    // The playlist was deleted or went private under this socket: drop it.
    socket.data.evict = (playlistId: string) => {
      if (currentPlaylist === playlistId) {
        handleLeave(socket, playlistId);
        currentPlaylist = null;
      }
      if (viewingPlaylist === playlistId) viewingPlaylist = null;
      socket.leave(playlistId);
    };

    // lobby:joined + the queue for a playlist this socket is already in.
    const sendPlaylistState = async (playlistId: string, { viewing = false, user = null }: { viewing?: boolean; user?: Listener | null } = {}) => {
      const data = await playlist.getPlaylistAsync(playlistId);
      const names = data ? await ownerNames([data.ownerId]) : new Map<string, string | null>();
      socket.emit('lobby:joined', {
        lobbyId: playlistId,
        viewing,
        name: data ? data.name : null,
        pinned: data ? (data.pinned || false) : false,
        visibility: data ? data.visibility : 'public',
        ownerId: data ? data.ownerId : null,
        ownerName: data ? ((data.ownerId && names.get(data.ownerId)) || data.ownerName || null) : null,
        isOwner: access.isOwner(data, userId),
        canEdit: access.canEdit(data, userId),
        user,
        users: playlist.getPlaylistUsers(playlistId)
      });
      let queue;
      try {
        queue = await getQueueAsync(playlistId);
      } catch (err) {
        // Its songs could not be loaded: an error, never an empty playlist.
        socket.emit('lobby:error', { message: 'This playlist could not be loaded, try again', code: 'QUEUE_UNAVAILABLE' });
        console.error(`Playlist ${playlistId}: songs not loaded:`, (err as Error).message);
        return;
      }
      socket.emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
      emitUnavailableSongs(socket, queue.getSongs());
    };

    // Verify socket is actually in the playlist's room before allowing operations
    const verifyMembership = (playlistId: unknown): playlistId is string => {
      if (!playlistId) return false;
      return socket.rooms.has(playlistId as string);
    };

    // Create a playlist owned by this (logged-in) socket. visibility:
    // 'public' (default) or 'private'. asViewer: keep the current member playlist
    // (the one being played from) and only view the new one.
    socket.on('lobby:create', async ({ username, emoji, name, visibility, asViewer }: PlaylistPayload = {}) => {
      if (!(await isApproved())) return refusePending();
      const shownName = await displayName(username);
      const shownEmoji = await displayEmoji(emoji);
      const vis = visibility === undefined ? 'public' : visibility;
      if (!playlist.VISIBILITIES.includes(vis as string)) {
        socket.emit('lobby:error', { message: "Visibility must be 'public' or 'private'" });
        return;
      }

      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (trimmedName.length > 50) {
        socket.emit('lobby:error', { message: 'Name must be 50 characters or less' });
        return;
      }
      if (trimmedName && playlist.isNameTaken(trimmedName, null, visibleTo)) {
        socket.emit('lobby:error', { message: 'A playlist with that name already exists' });
        return;
      }

      const created = await playlist.createPlaylistAsync(userId, null, trimmedName || null, vis, shownName);
      const viewOnly = !!asViewer && !!currentPlaylist;
      let user: Listener | null = null;
      stopViewing();
      if (viewOnly) {
        viewingPlaylist = created.id;
      } else {
        if (currentPlaylist) handleLeave(socket, currentPlaylist);
        // It was just created.
        const result = (await playlist.joinPlaylistAsync(created.id, socket.id, shownName, shownEmoji))!;
        user = result.user;
        currentPlaylist = created.id;
      }
      socket.join(created.id);

      notifyPlaylistsChanged(created);
      socket.emit('lobby:created', {
        lobbyId: created.id,
        viewing: viewOnly,
        name: created.name,
        visibility: created.visibility,
        ownerId: created.ownerId,
        ownerName: created.ownerName,
        isOwner: true,
        pinned: created.pinned || false,
        user,
        users: playlist.getPlaylistUsers(created.id)
      });

      console.log(`Playlist ${created.id} (${created.visibility}) created by ${shownName}${created.name ? ` name="${created.name}"` : ''}`);
    });

    // Handle joining a playlist's room
    socket.on('lobby:join', async ({ lobbyId: playlistId, username, emoji }: PlaylistPayload = {}) => {
      if (!(await isApproved())) return refusePending();

      // Missing and hidden (someone else's private) playlists look the same.
      const data = await visiblePlaylist(playlistId);
      if (!data) {
        socket.emit('lobby:not-found', { lobbyId: playlistId });
        return;
      }
      // visiblePlaylist accepts strings only.
      const id = playlistId as string;

      // Already a member (e.g. opening the page of the playlist being played
      // from): just resend its state, without leaving and re-adding.
      if (currentPlaylist === id && playlist.getPlaylistUsers(id).some(u => u.socketId === socket.id)) {
        await sendPlaylistState(id);
        return;
      }

      if (currentPlaylist) handleLeave(socket, currentPlaylist);
      if (viewingPlaylist === id) viewingPlaylist = null; // viewer becomes member

      const shownName = await displayName(username);
      const result = await playlist.joinPlaylistAsync(id, socket.id, shownName, await displayEmoji(emoji));
      if (!result) {
        socket.emit('lobby:error', { message: 'Failed to join lobby' });
        return;
      }
      currentPlaylist = id;

      // Notify existing members BEFORE joining the room
      // This ensures the joining user cannot receive their own join notification
      socket.to(id).emit('lobby:user-joined', {
        lobbyId: id,
        user: result.user,
        users: playlist.getPlaylistUsers(id)
      });

      // Now join the Socket.IO room
      socket.join(id);

      // Send joined confirmation + the current queue to the user
      console.log(`User ${shownName} joined lobby ${id}`);
      await sendPlaylistState(id, { user: result.user });
    });

    // Look at a playlist without becoming a member of it: join its room (queue,
    // listener updates; adding songs works) but stay listed in, and keep
    // now-playing in, the member playlist. Replaces any previous view.
    socket.on('lobby:view', async ({ lobbyId: playlistId }: PlaylistPayload = {}) => {
      if (!playlistId) return;
      if (!(await isApproved())) return refusePending();
      const data = await visiblePlaylist(playlistId);
      if (!data) {
        socket.emit('lobby:not-found', { lobbyId: playlistId });
        return;
      }
      const id = playlistId as string;
      if (id === currentPlaylist) {
        stopViewing();
        await sendPlaylistState(id);
        return;
      }
      if (viewingPlaylist !== id) {
        stopViewing();
        viewingPlaylist = id;
        socket.join(id);
      }
      await sendPlaylistState(id, { viewing: true });
    });

    socket.on('lobby:unview', () => {
      stopViewing();
    });

    socket.on('lobby:leave', ({ lobbyId: playlistId }: PlaylistPayload = {}) => {
      if (playlistId && playlistId === viewingPlaylist) {
        stopViewing();
        return;
      }
      if (playlistId) {
        // Left as the client named it (a room it is not in is a no-op).
        handleLeave(socket, playlistId as string);
      }
      currentPlaylist = null;
    });

    // Update user profile (name/emoji)
    // The name/emoji come from the account (the profile page saves them with
    // PUT /api/profile, then the client sends this); only without a database
    // is the client's own name taken.
    socket.on('user:update', async ({ lobbyId: sent, username, emoji }: PlaylistPayload = {}) => {
      if (sent && sent !== currentPlaylist) return;
      const playlistId = currentPlaylist;
      if (!playlistId) return;
      if (!(await isApproved())) return;

      const user = playlist.updateUser(playlistId, socket.id, { username: await displayName(username), emoji: await displayEmoji(emoji) });
      if (user) {
        // Broadcast updated user list to all in the playlist
        io.to(playlistId).emit('users:updated', {
          lobbyId: playlistId,
          users: playlist.getPlaylistUsers(playlistId)
        });
      }
    });

    // Report what this listener is playing (shown next to queue items). Listening
    // along with a user is features/listen-along (presence:now-playing).
    socket.on('listener:now-playing', async ({ lobbyId: sent, track: sentTrack }: PlaylistPayload = {}) => {
      if (sent && sent !== currentPlaylist) return;
      const playlistId = currentPlaylist;
      if (!playlistId) return;
      if (!(await isApproved())) return;

      // Only a title and an https thumbnail, both bounded, reach other users.
      const t = sentTrack as { title?: unknown; thumbnail?: unknown } | null | undefined;
      const track = t && typeof t === 'object' ? {
        title: typeof t.title === 'string' ? t.title.slice(0, 300) : '',
        thumbnail: typeof t.thumbnail === 'string' && /^https:\/\//i.test(t.thumbnail) ? t.thumbnail.slice(0, 1000) : null
      } : null;
      const user = playlist.setUserCurrentTrack(playlistId, socket.id, track);
      if (user) {
        io.to(playlistId).emit('users:updated', {
          lobbyId: playlistId,
          users: playlist.getPlaylistUsers(playlistId)
        });
      }
    });

    // Pin/unpin a playlist (the old shared flag)
    socket.on('lobby:pin', async ({ lobbyId: sent, pinned }: PlaylistPayload = {}) => {
      const playlistId = sent || currentPlaylist;
      if (!playlistId) return;

      // editablePlaylist accepts only a room this socket is in (a string).
      const result = (await editablePlaylist(playlistId)) ? await playlist.pinPlaylist(playlistId as string, !!pinned) : null;
      if (!result) {
        socket.emit('lobby:error', { message: 'Playlist not found' });
        return;
      }

      // Broadcast pin state to all users in the playlist
      io.to(playlistId as string).emit('lobby:pinned', {
        lobbyId: playlistId,
        pinned: !!pinned
      });

      console.log(`Lobby ${playlistId} ${pinned ? 'pinned' : 'unpinned'}`)
    });

    // Rename a playlist
    socket.on('lobby:rename', async ({ lobbyId: sent, name }: PlaylistPayload = {}) => {
      const playlistId = sent || currentPlaylist;
      if (!playlistId) return;

      const l = await editablePlaylist(playlistId);
      if (l && !access.canRename(l, userId, { admin: adminAuth.isAdmin({ headers: socket.handshake.headers }) })) {
        socket.emit('lobby:error', { message: 'Only the owner can rename' });
        return;
      }
      // editablePlaylist found it: the id is a string.
      const result = l ? await playlist.renamePlaylist(playlistId as string, name, visibleTo) : null;
      if (!result) {
        socket.emit('lobby:error', { message: 'Playlist not found' });
        return;
      }
      if (result.error !== undefined) {
        socket.emit('lobby:error', { message: result.error });
        return;
      }

      // Broadcast rename to all users in the playlist
      io.to(playlistId as string).emit('lobby:renamed', {
        lobbyId: playlistId,
        name: result.playlist.name
      });
      const social = getSocial();
      if (social) social.lobbyChanged(playlistId as string);
      notifyPlaylistsChanged(result.playlist);

      console.log(`Lobby ${playlistId} renamed to "${result.playlist.name}"`);
    });

    return {
      visiblePlaylist,
      editablePlaylist,
      disconnected: () => {
        if (currentPlaylist) {
          handleLeave(socket, currentPlaylist);
        }
      },
    };
  }

  return { register };
}
