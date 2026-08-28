import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import { keysShownFor } from "../shortcuts";

export function SidebarMenu() {
  const menu = useStore((s) => s.sidebarMenu);
  const close = useStore((s) => s.closeSidebarMenu);
  const reopenClosedTab = useStore((s) => s.reopenClosedTab);
  const createEmptyGroup = useStore((s) => s.createEmptyGroup);
  const closedCount = useStore((s) => s.closedCount);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    // Capture phase, and this is load-bearing: clicking the sidebar's
    // empty background is a window-drag surface, and the drag script
    // listens on document and calls stopImmediatePropagation — a
    // bubble-phase listener out here never runs, which is why this menu
    // would not close while the tab menu (whose rows are not drag
    // surfaces) always did.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} ref={ref}>
      {menu.zone === "pinned" && (
        <button
          className="ctx-item"
          onClick={() => {
            createEmptyGroup();
            close();
          }}
        >
          {/* Grouping otherwise starts from a tab, which cannot express "a
              place for work I have not opened yet". */}
          {STR.common.sidebarMenu.newGroup}
        </button>
      )}
      <button
        className="ctx-item"
        disabled={closedCount === 0}
        onClick={() => {
          reopenClosedTab();
          close();
        }}
      >
        {/* Shown greyed rather than hidden: an absent entry reads as "this
            app cannot", while a greyed one says "nothing to bring back". */}
        {closedCount === 0
          ? STR.common.sidebarMenu.reopenNone
          : STR.common.sidebarMenu.reopenCount({ count: closedCount })}
        <kbd className="ctx-kbd">{formatKeys(keysShownFor("reopen-closed"))}</kbd>
      </button>
    </div>
  );
}
