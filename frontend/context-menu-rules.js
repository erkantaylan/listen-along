// The context menu's pure geometry (no DOM), unit tested in
// backend/src/context-menu-rules.test.js. context-menu.js measures and applies.

/**
 * Where a submenu box goes: to the right of its menu, overlapping it by 2px;
 * flipped to the left when it would cross the viewport's right edge; then
 * kept inside the viewport (margin) both ways. Its top lines up with the
 * parent item (8px above it, for the box's padding).
 * parent: the menu's rect { left, right }; size: the submenu's { width, height };
 * itemTop: the parent item's top; viewport: { width, height }.
 * Returns { left, top, side: 'right' | 'left' }.
 */
export function submenuPosition({ parent, size, itemTop, viewport, margin = 8 }) {
  const { width, height } = size;
  let left = parent.right - 2;
  let side = 'right';
  if (left + width > viewport.width - margin) { left = parent.left - width + 2; side = 'left'; }
  left = Math.max(margin, Math.min(left, viewport.width - margin - width));
  const top = Math.max(margin, Math.min(itemTop - 8, viewport.height - margin - height));
  return { left: Math.round(left), top: Math.round(top), side };
}
