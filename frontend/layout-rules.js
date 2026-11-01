// Who takes how much width (pure, no DOM; DESIGN.md "Columns and breakpoints").
// The chat panel docks from DOCK_MIN; the library collapses to its rail first.

export const DRAWER_MAX = 768; // below this the sidebar is a drawer
export const DOCK_MIN = 1010; // from here the chat panel sits beside the page

export const SIDEBAR_RAIL = 72;
export const SIDEBAR_MIN = 200; // dragged below this, the sidebar snaps to its rail
export const SIDEBAR_MAX = 420;
export const CHAT_MIN = 280;
export const CHAT_MAX = 420;
export const MAIN_FLOOR = 416; // the page column, whatever the user chose
const COMFORTABLE_MAIN = 616; // the page column, when the sidebar is automatic
const RIGHT_RAIL = 56;

export const defaultSidebarWidth = (width) => (width >= 1440 ? 304 : 264);
export const defaultChatWidth = (width) => (width >= 1200 ? 320 : 280);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The widths at this window size. pref: 'rail' | 'expanded' | anything else
// (automatic). left / right: what the user dragged, or null. Those are wishes:
// the result never overwrites them, so the wish returns once there is room.
//   - Chat: its wish, unless that would leave the page under MAIN_FLOOR even with
//     the sidebar at its smallest for this pref.
//   - Rail by choice: 72. Expanded by choice: the wish, shrunk to MAIN_FLOOR but
//     never under SIDEBAR_MIN.
//   - Automatic: keeps the page at COMFORTABLE_MAIN. An undragged sidebar is all
//     or nothing (264 fits or it is a rail); a dragged one shrinks first.
// left / right are null where that column does not sit beside the page.
export function resolveColumns({ width, pref = null, chatDocked = false, hasSidebar = true, left = null, right = null }) {
  const docked = chatDocked && width >= DOCK_MIN;
  const sidebar = hasSidebar && width >= DRAWER_MAX;
  const smallest = !sidebar ? 0 : pref === 'expanded' ? SIDEBAR_MIN : SIDEBAR_RAIL;
  const chat = docked
    ? clamp(right ?? defaultChatWidth(width), CHAT_MIN, Math.max(CHAT_MIN, Math.min(CHAT_MAX, width - MAIN_FLOOR - smallest)))
    : null;
  const inset = docked ? chat : width >= DOCK_MIN ? RIGHT_RAIL : 0;
  const result = (rail, leftWidth) => ({
    rail,
    left: sidebar ? leftWidth : null,
    right: chat,
    main: width - (sidebar ? leftWidth : 0) - inset,
  });
  if (!sidebar) return result(false, 0);
  if (pref === 'rail') return result(true, SIDEBAR_RAIL);
  const fallback = defaultSidebarWidth(width);
  if (pref === 'expanded') return result(false, clamp(left ?? fallback, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width - inset - MAIN_FLOOR))));
  const room = width - inset - COMFORTABLE_MAIN;
  if (left == null) return room < 264 ? result(true, SIDEBAR_RAIL) : result(false, fallback);
  return room < SIDEBAR_MIN ? result(true, SIDEBAR_RAIL) : result(false, clamp(left, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, room)));
}

export const sidebarRail = (args) => resolveColumns(args).rail;
