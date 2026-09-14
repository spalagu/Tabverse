import { useStore } from "./state/store";

/** Design §7: intent delays and movement durations are different contracts. */
export const SIDEBAR_MOTION = { openIntent: 100, closeIntent: 280, enter: 180, exit: 200 } as const;
type Phase = "hidden" | "open" | "closing";
export interface SidebarHoverHost {
  pinned(): boolean;
  shown(): boolean;
  held(): boolean;
  reducedMotion?(): boolean;
  present(phase: Phase): void;
}

/** One arbiter for native and DOM events. No persistence or layout changes. */
export function createSidebarHover(host: SidebarHoverHost) {
  let wanted = false;
  let open: ReturnType<typeof setTimeout> | undefined;
  let close: ReturnType<typeof setTimeout> | undefined;
  let exit: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const locks = new Set<string>();
  const clearOpen = () => { clearTimeout(open); open = undefined; };
  const clearClose = () => { clearTimeout(close); clearTimeout(exit); close = exit = undefined; };
  const held = () => locks.size > 0 || host.held();
  const show = () => {
    clearOpen(); clearClose(); closing = false;
    if (!host.pinned()) host.present("open");
  };
  const leave = () => {
    wanted = false; clearOpen();
    if (host.pinned() || !host.shown() || held() || close !== undefined || closing) return;
    close = setTimeout(() => {
      close = undefined;
      if (wanted || held() || host.pinned()) return;
      closing = true;
      host.present("closing");
      exit = setTimeout(() => {
        exit = undefined;
        if (wanted || held()) { show(); return; }
        closing = false;
        host.present("hidden");
      }, host.reducedMotion?.() ? 0 : SIDEBAR_MOTION.exit);
    }, SIDEBAR_MOTION.closeIntent);
  };
  const reconcile = () => {
    if (host.pinned()) { clearOpen(); clearClose(); closing = false; return; }
    if (wanted || held()) {
      clearClose();
      if (closing) show();
    } else leave();
  };
  return {
    edgeEnter() {
      wanted = true; clearClose();
      if (host.pinned()) return;
      if (closing || host.shown()) { show(); return; }
      if (open !== undefined) return;
      open = setTimeout(() => { open = undefined; if (wanted && !host.pinned()) show(); }, SIDEBAR_MOTION.openIntent);
    },
    /** Leaving the native 10px strip may mean entering the panel, not exiting it. */
    edgeExit(outsidePanel: boolean) {
      clearOpen();
      if (!host.shown() || outsidePanel) leave();
    },
    enter() { wanted = true; if (host.shown() || closing) show(); else clearClose(); },
    leave,
    hold(key: string, on: boolean) { if (on) locks.add(key); else locks.delete(key); reconcile(); },
    reconcile,
    reset() { clearOpen(); clearClose(); wanted = closing = false; locks.clear(); },
    blur() { clearOpen(); leave(); },
  };
}

export const sidebarHover = createSidebarHover({
  pinned: () => useStore.getState().sidebarPinned === true,
  shown: () => useStore.getState().sidebarPeeking,
  held: () => {
    const s = useStore.getState();
    return !!(s.menu || s.groupMenu || s.sidebarMenu || s.folderPreviewGroupId ||
      s.folderPreviewPendingGroupId || s.renamingTabId || s.namingGroupId ||
      s.draggingTabIds.length || s.contentDrag || s.splitDragging || s.newTabMenuOpen);
  },
  reducedMotion: () => typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  present: (phase) => {
    const s = useStore.getState();
    if (phase === "closing") useStore.setState({ sidebarClosing: true });
    else s.setSidebarPeeking(phase === "open");
  },
});

// A portal/menu can disappear without another pointermove. Re-evaluate
// occupancy, but never recursively react to our own animation state.
useStore.subscribe((s, p) => {
  if (s.sidebarPinned !== p.sidebarPinned) { sidebarHover.reset(); return; }
  if (s.menu !== p.menu || s.groupMenu !== p.groupMenu || s.sidebarMenu !== p.sidebarMenu ||
      s.folderPreviewGroupId !== p.folderPreviewGroupId || s.folderPreviewPendingGroupId !== p.folderPreviewPendingGroupId ||
      s.renamingTabId !== p.renamingTabId || s.namingGroupId !== p.namingGroupId ||
      s.draggingTabIds !== p.draggingTabIds || s.contentDrag !== p.contentDrag ||
      s.splitDragging !== p.splitDragging || s.newTabMenuOpen !== p.newTabMenuOpen) sidebarHover.reconcile();
});
