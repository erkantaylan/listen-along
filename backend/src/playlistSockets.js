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
 * Private playlists are lobby:not-found to everyone but their owner
 * (visibleLobby / editableLobby, playlistAccess.js); never trust an id the
 * client sends. register() returns visibleLobby / editableLobby for the
 * queue handlers and what to do on disconnect.
 */

const access = require('./playlistAccess');

/**
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {typeof import('./lobby')} deps.lobby
 * @param {(lobbyId: string) => Promise<object>} deps.getQueueAsync - queue.js
 * @param {{ isAdmin: (req: { headers: object }) => boolean }} deps.adminAuth
 * @param {() => ({ lobbyChanged: (lobbyId: string) => void }|null)} deps.getSocial
 * @param {(ids: string[]) => Promise<Map<string, string|null>>} deps.ownerNames - playlistRoutes.js (one cache)
 * @param {(l: object, opts?: { everyone?: boolean }) => void} deps.notifyPlaylistsChanged
 * @param {(target: { emit: Function }, songs: object[]) => Promise<void>} deps.emitUnavailableSongs
 */
function createPlaylistSockets({ io, lobby, getQueueAsync, adminAuth, getSocial, ownerNames, notifyPlaylistsChanged, emitUnavailableSongs }) {
  function handleLeave(socket, lobbyId) {
    const user = lobby.getLobbyUsers(lobbyId).find(u => u.socketId === socket.id);
    // leaveLobby is async but removes the user synchronously; the rest is the
    // last-activity write.
    Promise.resolve(lobby.leaveLobby(lobbyId, socket.id)).catch(() => {});
    socket.leave(lobbyId);
    if (user) {
      socket.to(lobbyId).emit('lobby:user-left', {
        lobbyId,
        user,
        users: lobby.getLobbyUsers(lobbyId)
      });
      console.log(`User ${user.username} left lobby ${lobbyId}`);
    }
  }

  /**
   * The playlist handlers of one connection.
   * @param {import('socket.io').Socket} socket
   * @param {object} ctx
   * @param {string} ctx.userId - from the handshake, never the client
   * @param {() => Promise<boolean>} ctx.isApproved - joins APP_ROOM when it is
   * @param {(clientName: unknown) => Promise<string>} ctx.displayName
   * @param {(clientEmoji: unknown) => Promise<string|null>} ctx.displayEmoji
   * @param {(event?: string) => void} ctx.refusePending
   * @returns {{ visibleLobby: Function, editableLobby: Function, disconnected: () => void }}
   */
  function register(socket, { userId, isApproved, displayName, displayEmoji, refusePending }) {
    // A socket is a *member* of at most one lobby (currentLobby: listed as a
    // listener, now-playing) and may additionally *view* one other lobby
    // (viewingLobby: in its Socket.IO room for queue updates and adding
    // songs, but not listed). The web app keeps the member lobby on the one it
    // is playing from while the user browses other lobbies.
    let currentLobby = null;
    let viewingLobby = null;

    // The playlist if this socket may see it, else null (callers answer as if
    // it did not exist, so private playlists cannot be probed).
    const visibleLobby = async (lobbyId) => {
      if (!lobbyId || typeof lobbyId !== 'string') return null;
      if (!(await isApproved())) return null;
      const l = await lobby.getLobbyAsync(lobbyId);
      return access.canView(l, userId) ? l : null;
    };
    // Mutations: the socket must be in the playlist's room and allowed to edit.
    const editableLobby = async (lobbyId) => {
      if (!verifyLobbyMembership(lobbyId)) return null;
      if (!(await isApproved())) return null;
      const l = await lobby.getLobbyAsync(lobbyId);
      return access.canEdit(l, userId) ? l : null;
    };
    const visibleTo = (l) => access.canView(l, userId);

    const stopViewing = () => {
      if (viewingLobby && viewingLobby !== currentLobby) socket.leave(viewingLobby);
      viewingLobby = null;
    };

    // The playlist was deleted or went private under this socket: drop it.
    socket.data.evict = (lobbyId) => {
      if (currentLobby === lobbyId) {
        handleLeave(socket, lobbyId);
        currentLobby = null;
      }
      if (viewingLobby === lobbyId) viewingLobby = null;
      socket.leave(lobbyId);
    };

    // lobby:joined + the queue for a lobby this socket is already in.
    const sendLobbyState = async (lobbyId, { viewing = false, user = null } = {}) => {
      const lobbyData = await lobby.getLobbyAsync(lobbyId);
      const names = lobbyData ? await ownerNames([lobbyData.ownerId]) : new Map();
      socket.emit('lobby:joined', {
        lobbyId,
        viewing,
        name: lobbyData ? lobbyData.name : null,
        pinned: lobbyData ? (lobbyData.pinned || false) : false,
        visibility: lobbyData ? lobbyData.visibility : 'public',
        ownerId: lobbyData ? lobbyData.ownerId : null,
        ownerName: lobbyData ? ((lobbyData.ownerId && names.get(lobbyData.ownerId)) || lobbyData.ownerName || null) : null,
        isOwner: access.isOwner(lobbyData, userId),
        canEdit: access.canEdit(lobbyData, userId),
        user,
        users: lobby.getLobbyUsers(lobbyId)
      });
      const queue = await getQueueAsync(lobbyId);
      socket.emit('queue:update', { lobbyId, songs: queue.getSongs() });
      emitUnavailableSongs(socket, queue.getSongs());
    };

    // Verify socket is actually in the lobby before allowing operations
    const verifyLobbyMembership = (lobbyId) => {
      if (!lobbyId) return false;
      return socket.rooms.has(lobbyId);
    };

    // Create a playlist owned by this (logged-in) socket. visibility:
    // 'public' (default) or 'private'. asViewer: keep the current member lobby
    // (the one being played from) and only view the new one.
    socket.on('lobby:create', async ({ username, emoji, name, visibility, asViewer } = {}) => {
      if (!(await isApproved())) return refusePending();
      const shownName = await displayName(username);
      const shownEmoji = await displayEmoji(emoji);
      const vis = visibility === undefined ? 'public' : visibility;
      if (!lobby.VISIBILITIES.includes(vis)) {
        socket.emit('lobby:error', { message: "Visibility must be 'public' or 'private'" });
        return;
      }

      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (trimmedName.length > 50) {
        socket.emit('lobby:error', { message: 'Name must be 50 characters or less' });
        return;
      }
      if (trimmedName && lobby.isNameTaken(trimmedName, null, visibleTo)) {
        socket.emit('lobby:error', { message: 'A playlist with that name already exists' });
        return;
      }

      const newLobby = await lobby.createLobbyAsync(userId, null, trimmedName || null, vis, shownName);
      const viewOnly = !!asViewer && !!currentLobby;
      let user = null;
      stopViewing();
      if (viewOnly) {
        viewingLobby = newLobby.id;
      } else {
        if (currentLobby) handleLeave(socket, currentLobby);
        const result = await lobby.joinLobbyAsync(newLobby.id, socket.id, shownName, shownEmoji);
        user = result.user;
        currentLobby = newLobby.id;
      }
      socket.join(newLobby.id);

      notifyPlaylistsChanged(newLobby);
      socket.emit('lobby:created', {
        lobbyId: newLobby.id,
        viewing: viewOnly,
        name: newLobby.name,
        visibility: newLobby.visibility,
        ownerId: newLobby.ownerId,
        ownerName: newLobby.ownerName,
        isOwner: true,
        pinned: newLobby.pinned || false,
        user,
        users: lobby.getLobbyUsers(newLobby.id)
      });

      console.log(`Playlist ${newLobby.id} (${newLobby.visibility}) created by ${shownName}${newLobby.name ? ` name="${newLobby.name}"` : ''}`);
    });

    // Handle joining a lobby room (integrates with lobby system)
    socket.on('lobby:join', async ({ lobbyId, username, emoji } = {}) => {
      if (!(await isApproved())) return refusePending();

      // Missing and hidden (someone else's private) playlists look the same.
      const lobbyData = await visibleLobby(lobbyId);
      if (!lobbyData) {
        socket.emit('lobby:not-found', { lobbyId });
        return;
      }

      // Already a member (e.g. opening the page of the lobby being played
      // from): just resend its state, without leaving and re-adding.
      if (currentLobby === lobbyId && lobby.getLobbyUsers(lobbyId).some(u => u.socketId === socket.id)) {
        await sendLobbyState(lobbyId);
        return;
      }

      if (currentLobby) handleLeave(socket, currentLobby);
      if (viewingLobby === lobbyId) viewingLobby = null; // viewer becomes member

      const shownName = await displayName(username);
      const result = await lobby.joinLobbyAsync(lobbyId, socket.id, shownName, await displayEmoji(emoji));
      if (!result) {
        socket.emit('lobby:error', { message: 'Failed to join lobby' });
        return;
      }
      currentLobby = lobbyId;

      // Notify existing members BEFORE joining the room
      // This ensures the joining user cannot receive their own join notification
      socket.to(lobbyId).emit('lobby:user-joined', {
        lobbyId,
        user: result.user,
        users: lobby.getLobbyUsers(lobbyId)
      });

      // Now join the Socket.IO room
      socket.join(lobbyId);

      // Send joined confirmation + the current queue to the user
      console.log(`User ${shownName} joined lobby ${lobbyId}`);
      await sendLobbyState(lobbyId, { user: result.user });
    });

    // Look at a lobby without becoming a member of it: join its room (queue,
    // listener updates; adding songs works) but stay listed in, and keep
    // now-playing in, the member lobby. Replaces any previous view.
    socket.on('lobby:view', async ({ lobbyId } = {}) => {
      if (!lobbyId) return;
      if (!(await isApproved())) return refusePending();
      const lobbyData = await visibleLobby(lobbyId);
      if (!lobbyData) {
        socket.emit('lobby:not-found', { lobbyId });
        return;
      }
      if (lobbyId === currentLobby) {
        stopViewing();
        await sendLobbyState(lobbyId);
        return;
      }
      if (viewingLobby !== lobbyId) {
        stopViewing();
        viewingLobby = lobbyId;
        socket.join(lobbyId);
      }
      await sendLobbyState(lobbyId, { viewing: true });
    });

    socket.on('lobby:unview', () => {
      stopViewing();
    });

    socket.on('lobby:leave', ({ lobbyId } = {}) => {
      if (lobbyId && lobbyId === viewingLobby) {
        stopViewing();
        return;
      }
      if (lobbyId) {
        handleLeave(socket, lobbyId);
      }
      currentLobby = null;
    });

    // Update user profile (name/emoji)
    // The name/emoji come from the account (the profile page saves them with
    // PUT /api/profile, then the client sends this); only without a database
    // is the client's own name taken.
    socket.on('user:update', async ({ lobbyId, username, emoji } = {}) => {
      if (lobbyId && lobbyId !== currentLobby) return;
      lobbyId = currentLobby;
      if (!lobbyId) return;
      if (!(await isApproved())) return;

      const user = lobby.updateUser(lobbyId, socket.id, { username: await displayName(username), emoji: await displayEmoji(emoji) });
      if (user) {
        // Broadcast updated user list to all in lobby
        io.to(lobbyId).emit('users:updated', {
          lobbyId,
          users: lobby.getLobbyUsers(lobbyId)
        });
      }
    });

    // Report what this listener is playing (shown next to queue items). Listening
    // along with a user is features/listen-along (presence:now-playing).
    socket.on('listener:now-playing', async ({ lobbyId, track } = {}) => {
      if (lobbyId && lobbyId !== currentLobby) return;
      lobbyId = currentLobby;
      if (!lobbyId) return;
      if (!(await isApproved())) return;

      // Only a title and an https thumbnail, both bounded, reach other users.
      const clean = track && typeof track === 'object' ? {
        title: typeof track.title === 'string' ? track.title.slice(0, 300) : '',
        thumbnail: typeof track.thumbnail === 'string' && /^https:\/\//i.test(track.thumbnail) ? track.thumbnail.slice(0, 1000) : null
      } : null;
      track = clean;
      const user = lobby.setUserCurrentTrack(lobbyId, socket.id, track);
      if (user) {
        io.to(lobbyId).emit('users:updated', {
          lobbyId,
          users: lobby.getLobbyUsers(lobbyId)
        });
      }
    });

    // Pin/unpin lobby (make persistent)
    socket.on('lobby:pin', async ({ lobbyId, pinned } = {}) => {
      if (!lobbyId) lobbyId = currentLobby;
      if (!lobbyId) return;

      const result = (await editableLobby(lobbyId)) ? await lobby.pinLobby(lobbyId, !!pinned) : null;
      if (!result) {
        socket.emit('lobby:error', { message: 'Playlist not found' });
        return;
      }

      // Broadcast pin state to all users in the lobby
      io.to(lobbyId).emit('lobby:pinned', {
        lobbyId,
        pinned: !!pinned
      });

      console.log(`Lobby ${lobbyId} ${pinned ? 'pinned' : 'unpinned'}`)
    });

    // Rename lobby
    socket.on('lobby:rename', async ({ lobbyId, name } = {}) => {
      if (!lobbyId) lobbyId = currentLobby;
      if (!lobbyId) return;

      const l = await editableLobby(lobbyId);
      if (l && !access.canRename(l, userId, { admin: adminAuth.isAdmin({ headers: socket.handshake.headers }) })) {
        socket.emit('lobby:error', { message: 'Only the owner can rename' });
        return;
      }
      const result = l ? await lobby.renameLobby(lobbyId, name, visibleTo) : null;
      if (!result) {
        socket.emit('lobby:error', { message: 'Playlist not found' });
        return;
      }
      if (result.error) {
        socket.emit('lobby:error', { message: result.error });
        return;
      }

      // Broadcast rename to all users in the lobby
      io.to(lobbyId).emit('lobby:renamed', {
        lobbyId,
        name: result.lobby.name
      });
      const social = getSocial();
      if (social) social.lobbyChanged(lobbyId);
      notifyPlaylistsChanged(result.lobby);

      console.log(`Lobby ${lobbyId} renamed to "${result.lobby.name}"`);
    });

    return {
      visibleLobby,
      editableLobby,
      disconnected: () => {
        if (currentLobby) {
          handleLeave(socket, currentLobby);
        }
      },
    };
  }

  return { register };
}

module.exports = { createPlaylistSockets };
