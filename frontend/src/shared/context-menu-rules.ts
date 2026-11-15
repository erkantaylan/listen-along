// The context menu's pure geometry (no DOM), unit tested in
// context-menu-rules.test.ts. context-menu.ts measures and applies.

/**
 * Where a submenu box goes: to the right of its menu, overlapping it by 2px;
 * flipped to the left when it would cross the viewport's right edge; then
 * kept inside the viewport (margin) both ways. Its top lines up with the
 * parent item (8px above it, for the box's padding).
 * parent: the menu's rect { left, right }; size: the submenu's { width, height };
 * itemTop: the parent item's top; viewport: { width, height }.
 * Returns { left, top, side: 'right' | 'left' }.
 */
export interface SubmenuPlacement {
  left: number;
  top: number;
  side: 'right' | 'left';
}

export function submenuPosition({ parent, size, itemTop, viewport, margin = 8 }: {
  parent: { left: number; right: number };
  size: { width: number; height: number };
  itemTop: number;
  viewport: { width: number; height: number };
  margin?: number;
}): SubmenuPlacement {
  const { width, height } = size;
  let left = parent.right - 2;
  let side: SubmenuPlacement['side'] = 'right';
  if (left + width > viewport.width - margin) { left = parent.left - width + 2; side = 'left'; }
  left = Math.max(margin, Math.min(left, viewport.width - margin - width));
  const top = Math.max(margin, Math.min(itemTop - 8, viewport.height - margin - height));
  return { left: Math.round(left), top: Math.round(top), side };
}
