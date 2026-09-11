import { useEffect, useRef, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { useStore } from "../state/store";
import { edgeScrollSpeed, GROUP_MIME, TAB_MIME } from "./sidebarInteraction";

export function useSidebarNavigation(
  list: RefObject<HTMLDivElement>, activeId: string | null, showing: boolean,
) {
  const frame = useRef<number | null>(null);
  const speed = useRef(0);
  const stopScroll = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    speed.current = 0;
  };
  useEffect(() => {
    if (!showing || !activeId || !list.current) return;
    const container = list.current;
    const row = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeId);
    if (!row) return;
    const box = row.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    if (box.top < viewport.top + 4) container.scrollTop += box.top - viewport.top - 4;
    else if (box.bottom > viewport.bottom - 4) container.scrollTop += box.bottom - viewport.bottom + 4;
  }, [activeId, showing]);

  useEffect(() => {
    const finish = () => {
      stopScroll();
      // A move can unmount the source before its dragend. Clear transient
      // state on every ending path, after the drop has consumed its IDs.
      queueMicrotask(() => {
        const state = useStore.getState();
        state.setDraggingTabs([]);
        state.setContentDrag(null);
      });
    };
    window.addEventListener("drop", finish, true);
    window.addEventListener("dragend", finish, true);
    return () => {
      stopScroll();
      window.removeEventListener("drop", finish, true);
      window.removeEventListener("dragend", finish, true);
    };
  }, []);

  return {
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (!(event.target instanceof HTMLElement) || event.target.closest("input, textarea, [contenteditable=true]")) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".tab-main, .split-half-row, .group-toggle",
      )).filter((button) => !button.disabled);
      const at = buttons.findIndex((button) => button === event.target);
      if (at < 0 || !buttons.length) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
        Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault();
      event.stopPropagation();
      buttons[next].focus();
    },
    onDragOverCapture(event: DragEvent<HTMLDivElement>) {
      if (!event.dataTransfer.types.includes(TAB_MIME) && !event.dataTransfer.types.includes(GROUP_MIME)) return;
      const box = event.currentTarget.getBoundingClientRect();
      speed.current = edgeScrollSpeed(event.clientY, box.top, box.bottom);
      if (!speed.current) { stopScroll(); return; }
      if (frame.current !== null) return;
      const tick = () => {
        if (!list.current || !speed.current) { stopScroll(); return; }
        list.current.scrollTop += speed.current;
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
    onDragLeaveCapture(event: DragEvent<HTMLDivElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX <= box.left || event.clientX >= box.right || event.clientY <= box.top || event.clientY >= box.bottom) stopScroll();
    },
  };
}
