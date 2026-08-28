/**
 * On a Mac, ⌘ is the app-command modifier and Ctrl belongs to the programs
 * inside the terminal: Ctrl+W is delete-word, Ctrl+R is history search,
 * Ctrl+L is clear — treating Ctrl as an app modifier hijacks all of them
 * (Ctrl+W would close the tab and kill the shell). Elsewhere Ctrl is all
 * there is, and the same collision is the accepted platform convention.
 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().includes("MAC");

/** True when this event carries the platform's app-command modifier. */
export function isCommandModifier(e: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return IS_MAC ? e.metaKey : e.metaKey || e.ctrlKey;
}

/**
 * Tell the stylesheet which platform it is painting for.
 *
 * Only macOS puts the window's close/minimise/zoom buttons *inside* the
 * content, at the top left, so only macOS has to reserve a strip for them.
 * Windows and Linux draw them in a title bar of their own, at the right —
 * reserving that strip there left the sidebar's toggle stranded in mid-air
 * with nothing to its left.
 *
 * An attribute rather than a class: it reads as one fact with one value, and
 * `:root[data-platform="mac"]` cannot be half-applied the way two classes can.
 */
export function markPlatform(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";
  document.documentElement.dataset.shell =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
      ? "native"
      : "web";
}
