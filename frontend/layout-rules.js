// Who takes how much width (pure, no DOM; DESIGN.md "Columns and breakpoints").
// The chat panel docks from DOCK_MIN; the library collapses to its rail first.

export const DRAWER_MAX = 768; // below this the sidebar is a drawer
export const DOCK_MIN = 1010; // from here the chat panel sits beside the page

const SIDEBAR = 264;
const RIGHT_RAIL = 56;
const COMFORTABLE_MAIN = 616;
const chatWidth = (width) => (width >= 1200 ? 320 : 280);

// Is the sidebar a rail at this width? pref: 'rail' | 'expanded' | anything else
// (automatic: a rail once the expanded sidebar would leave the page column below
// COMFORTABLE_MAIN). 'expanded' is always safe for the 416px floor: at DOCK_MIN
// it leaves 1010 - 264 - 280 = 466.
export function sidebarRail({ width, pref = null, chatDocked = false }) {
  if (width < DRAWER_MAX) return false;
  if (pref === 'rail') return true;
  if (pref === 'expanded') return false;
  const docked = chatDocked && width >= DOCK_MIN;
  const right = docked ? chatWidth(width) : width >= DOCK_MIN ? RIGHT_RAIL : 0;
  return width - SIDEBAR - right < COMFORTABLE_MAIN;
}
