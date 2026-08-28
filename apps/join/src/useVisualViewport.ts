import { useEffect } from "react";

/**
 * Pin the app to the *visual* viewport so the soft keyboard shrinks the page
 * instead of covering it.
 *
 * On iOS the layout viewport keeps its height when the keyboard slides up;
 * anything pinned to its bottom — the key toolbar — ends up underneath the
 * keys. `window.visualViewport` reports the height that is actually visible,
 * so we project it onto a CSS variable the layout consumes, and the terminal's
 * own ResizeObserver does the rest (rescale + tmux-style viewport report).
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      // The keyboard can scroll the layout viewport; pull it back so the
      // header stays where the height calculation assumes it is.
      window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vvh");
    };
  }, []);
}
