/**
 * Who may see and change a playlist (internally a "lobby"). Pure functions so
 * every HTTP route and socket handler asks the same questions, and so the
 * rules are unit tested (playlist-access.test.js).
 *
 *   public  playlist: every logged-in user can see it and edit it (add,
 *                     remove, reorder, clear songs, rename, pin).
 *   private playlist: only its owner can see it. To everyone else it does not
 *                     exist: callers answer "not found", never "forbidden".
 *   manage  (switch public <-> private, delete): the owner only.
 *
 * Ownerless playlists (legacy rows, or created while not logged in) are always
 * public: editable by every logged-in user, never switchable to private, and
 * deletable only by an admin (dashboard).
 *
 * `userId` is the users.id from the signed listen_auth cookie (null when not
 * logged in). A user who is not logged in can see nothing.
 */

function isOwner(lobby, userId) {
  return !!lobby && !!userId && !!lobby.ownerId && lobby.ownerId === userId;
}

function isPrivate(lobby) {
  return !!lobby && lobby.visibility === 'private';
}

function canView(lobby, userId) {
  if (!lobby || !userId) return false;
  return !isPrivate(lobby) || isOwner(lobby, userId);
}

// Same as canView under the current rules (public: everyone, private: owner),
// kept separate so call sites say what they mean.
function canEdit(lobby, userId) {
  return canView(lobby, userId);
}

function canManage(lobby, userId) {
  return isOwner(lobby, userId);
}

// Admins (dashboard) can delete public playlists, including ownerless ones.
// Private playlists stay invisible to them too.
function canAdminDelete(lobby) {
  return !!lobby && !isPrivate(lobby);
}

module.exports = { isOwner, isPrivate, canView, canEdit, canManage, canAdminDelete };
