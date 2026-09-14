import { useLayoutEffect, type RefObject } from "react";

/** Measure real content, not a guessed height. Keyboard handling stays local
 * to these menus and never consumes text editing commands in the workbench. */
export function useSidebarMenu(ref: RefObject<HTMLDivElement>, identity: unknown, close: () => void) {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !identity) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const clamp = () => {
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
      // A fixed menu inside the animated floating sidebar is positioned against
      // that transformed ancestor, not the viewport. Apply the viewport delta
      // to its containing-block coordinates instead of assigning viewport
      // coordinates directly.
      menu.style.left = `${menu.offsetLeft + left - rect.left}px`;
      menu.style.top = `${menu.offsetTop + top - rect.top}px`;
      // Footer menus start from a bottom anchor so they can be measured
      // above their trigger. Convert to one top coordinate after measuring;
      // retaining both top and bottom would stretch the menu on resize.
      menu.style.bottom = "auto";
    };
    clamp();
    let restoreFocus = false;
    const key = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
      const focus = document.activeElement;
      if (focus instanceof HTMLElement && focus.closest("input,textarea,[contenteditable=true]")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); restoreFocus = true; close(); return;
      }
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>(".ctx-item:not(:disabled)"));
      if (!buttons.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const at = buttons.findIndex((button) => button === focus);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
        at < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) :
        (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    window.addEventListener("resize", clamp); window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("resize", clamp); window.removeEventListener("keydown", key, true);
      if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [identity, close, ref]);
}
