import { useEffect, useRef, useState, type DragEvent } from "react";
import { splittable, useStore, type Tab } from "../state/store";
import {
  draggedIds, splitCandidate, tabDropIntent, tabDropPlacement,
  SPLIT_DWELL_MS, TAB_MIME, type TabDropIntent,
} from "./sidebarInteraction";

export function armsSplitDrag(dragged: Tab | undefined, active: Tab | undefined): boolean {
  return splittable(dragged) && splittable(active) && dragged.id !== active.id;
}

export function splittableDrag(targetId: string): boolean {
  const state = useStore.getState();
  return state.draggingTabIds.length === 1 && state.draggingTabIds[0] !== targetId &&
    splittable(state.tabs.find((tab) => tab.id === state.draggingTabIds[0]));
}

const position = (event: DragEvent<HTMLElement>): [number, number] => {
  const box = event.currentTarget.getBoundingClientRect();
  return [(event.clientX - box.left) / Math.max(1, box.width),
    (event.clientY - box.top) / Math.max(1, box.height)];
};

/** Reordering is immediate. Splitting requires a deliberate pause over the
 * middle band; fast vertical drags cannot accidentally change the layout. */
export function useSidebarTabDrop(tabId: string) {
  const [intent, setIntent] = useState<TabDropIntent | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidate = useRef<"left" | "right" | null>(null);
  const armed = useRef<"left" | "right" | null>(null);
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const clear = () => {
    cancelTimer();
    candidate.current = null;
    armed.current = null;
    setIntent(null);
  };
  useEffect(() => {
    const finishDrop = () => {
      // Capture runs even when a row consumes the drop. Defer the reset so
      // that row can read its armed intent during this event dispatch.
      queueMicrotask(clear);
    };
    window.addEventListener("drop", finishDrop, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      cancelTimer();
      window.removeEventListener("drop", finishDrop, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, []);

  const canSplit = () => splittable(useStore.getState().tabs.find((tab) => tab.id === tabId)) && splittableDrag(tabId);
  return {
    intent,
    onDragOver(event: DragEvent<HTMLDivElement>) {
      const state = useStore.getState();
      if (!state.draggingTabIds.length && !event.dataTransfer.types.includes(TAB_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (state.draggingTabIds.includes(tabId)) { clear(); return; }
      const [x, y] = position(event);
      const next = canSplit() ? splitCandidate(x, y) : null;
      if (next !== candidate.current) {
        cancelTimer();
        armed.current = null;
        candidate.current = next;
        if (next !== null) {
          timer.current = setTimeout(() => {
            timer.current = null;
            if (candidate.current === next && canSplit()) {
              armed.current = next;
              setIntent(`split-${next}`);
            }
          }, SPLIT_DWELL_MS);
        }
      }
      setIntent(tabDropIntent(x, y, armed.current));
    },
    onDragLeave(event: DragEvent<HTMLDivElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      clear();
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      event.preventDefault();
      event.stopPropagation();
      const state = useStore.getState();
      const payload = draggedIds(event.dataTransfer);
      const ids = payload.length ? payload : state.draggingTabIds;
      const [x, y] = position(event);
      const side = canSplit() ? armed.current : null;
      const finalIntent = tabDropIntent(x, y, side);
      if (ids.length === 1 && !ids.includes(tabId) && side !== null && finalIntent.startsWith("split-")) {
        // Revalidate the payload, not just the remembered drag session.
        if (splittable(state.tabs.find((tab) => tab.id === ids[0]))) state.splitOnTab(ids[0], tabId, side);
      } else {
        const placement = tabDropPlacement(state.tabs, ids, tabId, y < 0.5 ? "before" : "after");
        if (placement) {
          for (const id of ids) {
            const tab = useStore.getState().tabs.find((item) => item.id === id);
            if (tab && tab.groupId !== placement.groupId) state.assignToGroup(id, placement.groupId);
          }
          state.moveTabs(ids, placement.beforeId);
        }
      }
      clear();
      state.setDraggingTabs([]);
      state.setContentDrag(null);
    },
  };
}
