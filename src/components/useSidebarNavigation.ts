import { useEffect, useRef, type RefObject, type KeyboardEvent, type DragEvent } from "react";
import { useStore } from "../state/store";
import { edgeScrollSpeed, TAB_MIME, GROUP_MIME } from "./sidebarInteraction";

export function useSidebarNavigation(list: RefObject<HTMLDivElement>, activeId: string | null, showing: boolean) {
  const frame = useRef<number | null>(null);
  const speed = useRef(0);
  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; speed.current = 0; };
  useEffect(() => {
    if (!showing || !activeId || !list.current) return;
    const container = list.current;
    const row = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeId);
    if (!row) return;
    const bounds = container.getBoundingClientRect(), rect = row.getBoundingClientRect();
    if (rect.top < bounds.top + 4) container.scrollTop += rect.top - bounds.top - 4;
    else if (rect.bottom > bounds.bottom - 4) container.scrollTop += rect.bottom - bounds.bottom + 4;
  }, [activeId, showing]);
  useEffect(() => {
    const finish = () => {
      stop();
      queueMicrotask(() => { const s = useStore.getState(); s.setDraggingTabs([]); s.setContentDrag(null); });
    };
    window.addEventListener("drop", finish, true); window.addEventListener("dragend", finish, true); window.addEventListener("blur", finish);
    return () => { stop(); window.removeEventListener("drop", finish, true); window.removeEventListener("dragend", finish, true); window.removeEventListener("blur", finish); };
  }, []);
  return {
    onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || !(e.target instanceof HTMLElement) ||
          e.target.closest("input,textarea,[contenteditable=true]")) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".tab-main, .group-toggle")).filter((b) => !b.disabled);
      const at = buttons.findIndex((b) => b === e.target); if (at < 0) return;
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      e.preventDefault(); e.stopPropagation(); buttons[next]?.focus();
    },
    onDragOverCapture(e: DragEvent<HTMLDivElement>) {
      if (!e.dataTransfer.types.includes(TAB_MIME) && !e.dataTransfer.types.includes(GROUP_MIME)) return;
      const rect = e.currentTarget.getBoundingClientRect(); speed.current = edgeScrollSpeed(e.clientY, rect.top, rect.bottom);
      if (!speed.current) { stop(); return; } if (frame.current !== null) return;
      const tick = () => { if (!list.current || !speed.current) { stop(); return; } list.current.scrollTop += speed.current; frame.current = requestAnimationFrame(tick); };
      frame.current = requestAnimationFrame(tick);
    },
    onDragLeaveCapture(e: DragEvent<HTMLDivElement>) {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) stop();
    },
  };
}
