/**
 * Who may see and change a playlist. Pure functions so every HTTP route and
 * socket handler asks the same questions, and so the rules are unit tested
 * (playlistAccess.test.ts).
 *
 *   public  playlist: every logged-in user can see it and edit it (add,
 *                     remove, reorder, clear songs, pin).
 *   private playlist: only its owner can see it. To everyone else it does not
 *                     exist: callers answer "not found", never "forbidden".
 *   manage  (rename, switch public <-> private, delete): the owner only.
 *
 * Ownerless playlists (legacy rows, or created while not logged in) are always
 * public: editable by every logged-in user, never switchable to private, and
 * renamable / deletable only by an admin (admin cookie).
 *
 * `userId` is the signed-in users.id (auth/userAuth.ts; null when not
 * logged in). A user who is not logged in can see nothing.
 */
import type { Playlist } from '../../shared/types.ts';

/** What the rules read of a playlist. */
export type AccessPlaylist = Pick<Playlist, 'ownerId' | 'visibility'>;
type Maybe = AccessPlaylist | null | undefined;

export function isOwner(playlist: Maybe, userId: string | null | undefined): boolean {
  return !!playlist && !!userId && !!playlist.ownerId && playlist.ownerId === userId;
}

export function isPrivate(playlist: Maybe): boolean {
  return !!playlist && playlist.visibility === 'private';
}

export function canView(playlist: Maybe, userId: string | null | undefined): boolean {
  if (!playlist || !userId) return false;
  return !isPrivate(playlist) || isOwner(playlist, userId);
}

// Same as canView under the current rules (public: everyone, private: owner),
// kept separate so call sites say what they mean.
export function canEdit(playlist: Maybe, userId: string | null | undefined): boolean {
  return canView(playlist, userId);
}

export function canManage(playlist: Maybe, userId: string | null | undefined): boolean {
  return isOwner(playlist, userId);
}

// Admins (dashboard) can delete public playlists, including ownerless ones.
// Private playlists stay invisible to them too.
export function canAdminDelete(playlist: Maybe): boolean {
  return !!playlist && !isPrivate(playlist);
}

// Rename is owner-only. An ownerless (legacy) public playlist has no owner, so
// only an admin may rename it.
export function canRename(playlist: Maybe, userId: string | null | undefined, { admin = false }: { admin?: boolean } = {}): boolean {
  if (canManage(playlist, userId)) return true;
  return !!admin && !!playlist && !playlist.ownerId && !isPrivate(playlist);
}

// --- Viewers -------------------------------------------------------------
// HTTP callers are "viewers": { userId, legacy }. A web session or a CLI
// token owned by a user is that user (userId set). A legacy CLI token (made
// before tokens had owners, api_tokens.user_id NULL) has no user: it acts like
// an anonymous logged-in member that can see and edit public playlists only,
// never manages anything, and creates ownerless (hence public) playlists.

/** Who calls a playlist route (playlistRoutes requireViewer). */
export interface Viewer {
  userId: string | null;
  legacy: boolean;
}

export function viewerCanView(playlist: Maybe, viewer: Viewer | null | undefined): boolean {
  if (!viewer) return false;
  if (viewer.legacy) return !!playlist && !isPrivate(playlist);
  return canView(playlist, viewer.userId);
}

export function viewerCanEdit(playlist: Maybe, viewer: Viewer | null | undefined): boolean {
  return viewerCanView(playlist, viewer);
}

export function viewerCanManage(playlist: Maybe, viewer: Viewer | null | undefined): boolean {
  return !!viewer && !viewer.legacy && canManage(playlist, viewer.userId);
}

export function viewerCanRename(playlist: Maybe, viewer: Viewer | null | undefined, { admin = false }: { admin?: boolean } = {}): boolean {
  if (viewerCanManage(playlist, viewer)) return true;
  return !!viewer && viewerCanView(playlist, viewer) && canRename(playlist, null, { admin });
}
