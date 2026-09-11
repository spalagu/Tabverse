import { createContext, useContext, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { closeTabAsking, runAppCommand } from "../appCommands";
import { shareBlockedReason, shareBlockedText } from "../share/framework/terminalBlocking";
import { shareCapability } from "../share/framework/capability";
import { tabSubtitle } from "../tabMeta";
import { splitPartners, useStore, type Tab } from "../state/store";
import { STR } from "../strings";
import { profileBadgeVar } from "../theme/tokens";
import { toggleMute } from "../mediaControl";
import { CloseIcon, ShareIcon, SpeakerIcon, SpeakerMutedIcon } from "./icons";
import { TabRowContent } from "./sidebarContent";
import { SidebarRenameInput } from "./SidebarRenameInput";
import { armsSplitDrag, useSidebarTabDrop } from "./useSidebarTabDrop";
import { SIDEBAR_UX, TAB_MIME, TABS_MIME } from "./sidebarInteraction";

export const ProfileBadges = createContext<Record<string, string>>({});

export function SidebarTabRow({ tab, active, indent, depth = 0, peek }: {
  tab: Tab; active: boolean; indent?: boolean; depth?: number; peek?: boolean;
}) {
  const selected = useStore((state) => state.selectedTabIds.includes(tab.id));
  const coActive = useStore((state) => splitPartners(state).includes(tab.id));
  const audible = useStore((state) => !!state.audibleTabs[tab.id]);
  const muted = useStore((state) => !!state.mutedTabs[tab.id]);
  const askedToRename = useStore((state) => state.renamingTabId === tab.id);
  const [ownEditing, setEditing] = useState(false);
  const editing = ownEditing || askedToRename;
  const mainRef = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const { intent, ...dropHandlers } = useSidebarTabDrop(tab.id);
  const badges = useContext(ProfileBadges);
  const badge = tab.type === "terminal" && tab.profile ? badges[tab.profile] : undefined;
  const subtitle = tabSubtitle(tab);
  const shared = !!tab.share;
  const shareBlocked = shareBlockedReason(tab);
  const shareLabel = shareBlocked !== null ? shareBlockedText(shareBlocked) ?? STR.common.sidebar.shareHint :
    shared ? STR.common.sidebar.sharingHint({ viewers: tab.share!.viewers.length }) : STR.common.sidebar.shareHint;
  const deviated = tab.type === "browser" && tab.groupId !== null && !tab.dormant &&
    tab.pinnedUrl !== undefined && tab.url !== undefined && tab.url !== tab.pinnedUrl;

  const finishEditing = (restoreFocus: boolean) => {
    setEditing(false);
    if (askedToRename) useStore.getState().setRenamingTab(null);
    if (restoreFocus) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  };
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    if (dragging.current) return;
    const state = useStore.getState();
    if (event.metaKey || event.ctrlKey) {
      state.toggleSelected(tab.id);
    } else if (event.shiftKey) {
      // A plain click is the range anchor too, not just a prior multi-pick.
      if (state.selectionAnchor === null) useStore.setState({ selectionAnchor: state.activeTabId ?? tab.id });
      state.extendSelectionTo(tab.id);
    } else {
      state.clearSelection();
      useStore.setState({ selectionAnchor: tab.id });
      state.activateTab(tab.id);
    }
  };
  const rowContent = (
    <TabRowContent
      tab={tab}
      deviationHint={SIDEBAR_UX.deviation}
      titleSlot={editing ? <SidebarRenameInput
        value={tab.title} label={SIDEBAR_UX.rename}
        onSave={(name) => useStore.getState().renameTab(tab.id, name)}
        onDone={finishEditing}
      /> : undefined}
      subtitleSlot={subtitle && <span className="tab-subtitle-wrap">
        {badge !== undefined && <span className="tab-profile-dot"
          style={{ background: profileBadgeVar(badge) }}
          title={STR.common.sidebar.profileBadgeHint({ name: tab.profile ?? "" })} />}
        <span className="tab-subtitle">{subtitle}</span>
      </span>}
    />
  );
  return (
    <div
      className={["tab-row", "sidebar-tab-row", active && "active", coActive && "co-active",
        selected && "selected", tab.exited && "exited", indent && "indent", tab.attention && "attention",
        tab.dormant && "dormant", peek && "peek", intent && `drop-${intent}`].filter(Boolean).join(" ")}
      data-tab-id={tab.id}
      data-drop-intent={intent ?? undefined}
      style={indent || peek ? { "--depth": depth + 1 } as CSSProperties : undefined}
      draggable={!editing}
      {...dropHandlers}
      onDragStart={(event) => {
        if (editing) { event.preventDefault(); return; }
        dragging.current = true;
        const state = useStore.getState();
        const ids = state.selectedTabIds.includes(tab.id) ?
          state.tabs.filter((item) => state.selectedTabIds.includes(item.id)).map((item) => item.id) : [tab.id];
        if (ids.length === 1) state.clearSelection();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(TAB_MIME, tab.id);
        event.dataTransfer.setData(TABS_MIME, JSON.stringify(ids));
        state.setDraggingTabs(ids);
        if (ids.length === 1 && armsSplitDrag(tab, state.tabs.find((item) => item.id === state.activeTabId))) {
          state.setContentDrag({ id: tab.id, side: null });
        }
        if (ids.length > 1) {
          const ghost = document.createElement("div");
          ghost.className = "drag-ghost";
          ghost.textContent = `${ids.length} tabs`;
          document.body.appendChild(ghost);
          event.dataTransfer.setDragImage(ghost, 12, 12);
          setTimeout(() => ghost.remove(), 0);
        }
      }}
      onDragEnd={() => {
        useStore.getState().setDraggingTabs([]);
        useStore.getState().setContentDrag(null);
        setTimeout(() => { dragging.current = false; }, 0);
      }}
      onMouseDown={(event) => {
        if (event.button === 1 && !editing) { event.preventDefault(); closeTabAsking(tab.id); }
      }}
      onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        event.stopPropagation();
        useStore.getState().openMenu(tab.id, event.clientX, event.clientY);
      }}
    >
      {editing ? <div className="tab-main tab-editing">{rowContent}</div> : <button
        ref={mainRef} type="button" className="tab-main"
        aria-label={tab.title} aria-current={active ? "page" : undefined}
        title={subtitle ? `${tab.title}\n${subtitle}` : tab.title}
        onClick={activate}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); setEditing(true); }
          else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault(); event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            useStore.getState().openMenu(tab.id, box.left + 12, box.bottom);
          }
        }}
      >{rowContent}</button>}
      <span className="tab-actions" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        {deviated && <button type="button" className="tab-reset" title={SIDEBAR_UX.reset} aria-label={SIDEBAR_UX.reset}
          onClick={() => {
            // View commands are registered by the active pane's effect.
            // Finish activation before broadcasting, so another page can
            // never receive this row's explicit reset command.
            flushSync(() => useStore.getState().activateTab(tab.id));
            runAppCommand("go-pinned", "menu");
          }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M6 3 2 7l4 4M2 7h7a4 4 0 0 1 0 8" />
          </svg>
        </button>}
        {tab.type === "browser" && (audible || muted) && <button type="button"
          className={`tab-audio${muted ? " muted" : ""}`}
          title={muted ? STR.common.sidebar.mutedHint : STR.common.sidebar.audibleHint}
          aria-label={muted ? STR.common.sidebar.mutedHint : STR.common.sidebar.audibleHint}
          onClick={() => toggleMute(tab.id)}>{muted ? <SpeakerMutedIcon /> : <SpeakerIcon />}</button>}
        {shareCapability(tab.type).shareable && !tab.dormant && <button type="button"
          className={`tab-share${shared ? " on" : ""}`} disabled={shareBlocked !== null}
          title={shareLabel} aria-label={shareLabel}
          onClick={() => useStore.getState().setShareDialogTab(tab.id)}>
          <ShareIcon />
          {shared && tab.share!.viewers.length > 0 && <span className="share-count">{tab.share!.viewers.length}</span>}
        </button>}
        {!tab.dormant && <button type="button" className="tab-close" aria-label={STR.common.sidebar.closeTab}
          title={STR.common.sidebar.closeTab} onClick={() => closeTabAsking(tab.id)}><CloseIcon /></button>}
      </span>
      {intent && <span className="tab-drop-label" aria-hidden="true">{
        intent === "split-left" ? SIDEBAR_UX.splitLeft : intent === "split-right" ? SIDEBAR_UX.splitRight :
          intent === "before" ? SIDEBAR_UX.moveBefore : SIDEBAR_UX.moveAfter
      }</span>}
    </div>
  );
}
