import { eventChordId, matchBinding } from "../../shortcuts";

type CloseClaim = () => boolean;

let claim: CloseClaim | null = null;

/**
 * Give the front explorer its chance at a close request. True means it
 * closed a file and nothing else should act on this one.
 *
 * The keydown route below is one caller. The other is any place that closes
 * the active tab without a keydown — on macOS the "Close Tab" menu item owns
 * ⌘W and the key never reaches this webview, so that route has to ask too.
 */
export function runFileCloseClaim(): boolean {
  return claim ? claim() : false;
}

/**
 * Claim ⌘W for one explorer. The returned function gives it back, and gives
 * back nothing if another explorer has claimed it since — otherwise a tab
 * losing focus would silently disown the tab that just took over.
 */
export function claimFileCloseKey(fn: CloseClaim): () => void {
  claim = fn;
  return () => {
    if (claim === fn) claim = null;
  };
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      // Whatever key `close-tab` answers on right now, not the ⌘W it ships
      // with: this listener exists to get in front of the app-wide handler
      // on that command's key, so a hand-written `w` here would go on
      // pre-empting an old key and stop pre-empting the new one — the
      // explorer would then close its whole tab, open files and all, which
      // is the exact loss this file was written to prevent.
      if (matchBinding("close-tab", eventChordId(e)) !== 0) return;
      if (!runFileCloseClaim()) return;
      // Claimed: stop the window-level handler, which sits on this same
      // target and would otherwise close the tab as well.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    },
    { capture: true }
  );
}
