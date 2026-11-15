// Who takes how much width (pure, no DOM; DESIGN.md "Columns and breakpoints").
// The chat panel docks from DOCK_MIN; the library collapses to its rail first.

export const DRAWER_MAX = 768; // below this the sidebar is a drawer
export const DOCK_MIN = 1010; // from here the chat panel sits beside the page
export const RAIL_MAX = 1100; // up to here an automatic sidebar is the rail, chat docked or not

export const SIDEBAR_RAIL = 72;
export const SIDEBAR_MIN = 200; // dragged below this, the sidebar snaps to its rail
export const SIDEBAR_MAX = 420;
export const CHAT_MIN = 280;
export const CHAT_MAX = 420;
export const MAIN_FLOOR = 416; // the page column, whatever the user chose
const COMFORTABLE_MAIN = 616; // the page column, when the sidebar is automatic
const RIGHT_RAIL = 56;

export const defaultSidebarWidth = (width: number): number => (width >= 1440 ? 304 : 264);
export const defaultChatWidth = (width: number): number => (width >= 1200 ? 320 : 280);

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

// The widths at this window size. pref: 'rail' | 'expanded' | anything else
// (automatic). left / right: what the user dragged, or null. Those are wishes:
// the result never overwrites them, so the wish returns once there is room.
//   - Chat: its wish, unless that would leave the page under MAIN_FLOOR even with
//     the sidebar at its smallest for this pref.
//   - Rail by choice: 72. Expanded by choice: the wish, shrunk to MAIN_FLOOR but
//     never under SIDEBAR_MIN.
//   - Automatic: the rail up to RAIL_MAX; above that it keeps the page at
//     COMFORTABLE_MAIN (so with the chat docked the rail reaches further). An
//     undragged sidebar is all or nothing (264 fits or it is a rail); a dragged
//     one shrinks first.
// left / right are null where that column does not sit beside the page.
export interface ColumnsInput {
  width: number;
  pref?: string | null;
  chatDocked?: boolean;
  hasSidebar?: boolean;
  left?: number | null;
  right?: number | null;
}

export interface Columns {
  rail: boolean;
  left: number | null;
  right: number | null;
  main: number;
}

export function resolveColumns({ width, pref = null, chatDocked = false, hasSidebar = true, left = null, right = null }: ColumnsInput): Columns {
  const docked = chatDocked && width >= DOCK_MIN;
  const sidebar = hasSidebar && width >= DRAWER_MAX;
  const smallest = !sidebar ? 0 : pref === 'expanded' ? SIDEBAR_MIN : SIDEBAR_RAIL;
  const chat = docked
    ? clamp(right ?? defaultChatWidth(width), CHAT_MIN, Math.max(CHAT_MIN, Math.min(CHAT_MAX, width - MAIN_FLOOR - smallest)))
    : null;
  const inset = chat !== null ? chat : width >= DOCK_MIN ? RIGHT_RAIL : 0; // chat is a number exactly when docked
  const result = (rail: boolean, leftWidth: number): Columns => ({
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
  const narrow = width <= RAIL_MAX;
  if (left == null) return narrow || room < 264 ? result(true, SIDEBAR_RAIL) : result(false, fallback);
  return narrow || room < SIDEBAR_MIN ? result(true, SIDEBAR_RAIL) : result(false, clamp(left, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, room)));
}

export const sidebarRail = (args: ColumnsInput): boolean => resolveColumns(args).rail;
