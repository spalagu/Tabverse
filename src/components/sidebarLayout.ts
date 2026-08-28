/** Geometry for the sidebar's viewport-fixed footer menu. */
export const FOOT_MENU_WIDTH = 210;
export const FOOT_MENU_GAP = 8;

export interface FooterTriggerRect {
  left: number;
  top: number;
}

export interface FooterMenuPosition {
  left: number;
  bottom: number;
}

/**
 * Anchor the footer menu above its trigger and keep its rectangle in the
 * viewport. The footer trigger sits at the sidebar's left edge, so the menu
 * opens to its right rather than using a context-menu's usual right anchor.
 */
export function footerMenuPosition(
  trigger: FooterTriggerRect,
  viewportWidth: number,
  viewportHeight: number
): FooterMenuPosition {
  const minLeft = FOOT_MENU_GAP;
  const maxLeft = Math.max(
    minLeft,
    viewportWidth - FOOT_MENU_WIDTH - FOOT_MENU_GAP
  );
  const left = Math.min(Math.max(trigger.left, minLeft), maxLeft);
  const bottom = Math.max(
    FOOT_MENU_GAP,
    viewportHeight - trigger.top + FOOT_MENU_GAP
  );
  return { left, bottom };
}
