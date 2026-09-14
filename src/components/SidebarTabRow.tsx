import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { closeTabAsking } from "../appCommands";
import { useFavicon } from "../favicons";
import { toggleMute } from "../mediaControl";
import { sidebarTabSubtitle } from "../tabMeta";
import { splittable, splitPartners, useStore, type Tab } from "../state/store";
import { STR } from "../strings";
import { profileBadgeVar } from "../theme/tokens";
import { shareCapability } from "../share/framework/capability";
import { shareBlockedReason, shareBlockedText } from "../share/framework/terminalBlocking";
import { CloseIcon, ShareIcon, SpeakerIcon, SpeakerMutedIcon, TAB_ICONS } from "./icons";
import { TabRowContent } from "./sidebarContent";
import { SidebarRenameInput } from "./SidebarRenameInput";
import { resetPinnedTab } from "./sidebarActions";
import { draggedIds, tabPlacement, TAB_MIME, TABS_MIME } from "./sidebarInteraction";

export const ProfileBadges = createContext<Record<string, string>>({});
export const armsSplitDrag = (tab: Tab | undefined, active: Tab | undefined) =>
  splittable(tab) && splittable(active) && tab.id !== active.id;
export function splittableDrag(targetId: string): boolean {
  const s = useStore.getState();
  return s.draggingTabIds.length === 1 && s.draggingTabIds[0] !== targetId &&
    splittable(s.tabs.find((t) => t.id === s.draggingTabIds[0]));
}

export function SidebarTabRow({ tab, active, indent, depth = 0, peek }: {
  tab: Tab; active: boolean; indent?: boolean; depth?: number; peek?: boolean;
}) {
  const selected = useStore((s) => s.selectedTabIds.includes(tab.id));
  const coActive = useStore((s) => splitPartners(s).includes(tab.id));
  const split = useStore((s) => s.split);
  const tabs = useStore((s) => s.tabs);
  const audible = useStore((s) => !!s.audibleTabs[tab.id]);
  const muted = useStore((s) => !!s.mutedTabs[tab.id]);
  const editing = useStore((s) => s.renamingTabId === tab.id);
  const badges = useContext(ProfileBadges);
  const profileBadge = tab.type === "terminal" && tab.profile ? badges[tab.profile] : undefined;
  const mainRef = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  const icon = useFavicon(tab.type === "browser" ? tab.url : undefined, tab.id);
  const Icon = TAB_ICONS[tab.type];
  const subtitle = sidebarTabSubtitle(tab, tabs);
  const text = STR.common.sidebar;
  const deviated = tab.type === "browser" && tab.groupId !== null && !tab.dormant &&
    tab.pinnedUrl !== undefined && tab.url !== undefined && tab.pinnedUrl !== tab.url;
  const shareable = shareCapability(tab.type).shareable && !tab.dormant;
  const blocked = shareBlockedReason(tab);
  const shareHint = blocked !== null ? shareBlockedText(blocked) ?? text.shareHint :
    tab.share ? text.sharingHint({ viewers: tab.share.viewers.length }) : text.shareHint;
  const closeLabel = tab.dormant && tab.groupId !== null ? text.removeSaved :
    tab.groupId !== null ? text.closeRunning : text.closeTab;
  const splitIndex = split?.ids.indexOf(tab.id) ?? -1;
  useEffect(() => {
    const clear = () => setEdge(null);
    window.addEventListener("drop", clear, true); window.addEventListener("dragend", clear, true);
    return () => { window.removeEventListener("drop", clear, true); window.removeEventListener("dragend", clear, true); };
  }, []);
  const choose = (e: MouseEvent) => {
    if (dragging.current || editing) return;
    const s = useStore.getState();
    if (e.metaKey || e.ctrlKey) s.toggleSelected(tab.id);
    else if (e.shiftKey) {
      if (s.selectionAnchor === null) useStore.setState({ selectionAnchor: s.activeTabId ?? tab.id });
      s.extendSelectionTo(tab.id);
    } else {
      s.clearSelection(); useStore.setState({ selectionAnchor: tab.id }); s.activateTab(tab.id);
    }
  };
  return <div
    className={["tab-row", "sidebar-tab-row", subtitle && "has-subtitle", active && "active", coActive && "co-active",
      selected && "selected", tab.exited && "exited", tab.attention && "attention", tab.dormant && "dormant",
      indent && "indent", peek && "peek", edge && `drop-${edge}`].filter(Boolean).join(" ")}
    data-tab-id={tab.id} data-drop-intent={edge ?? undefined}
    style={indent || peek ? { "--depth": Math.min(depth + 1, 5) } as CSSProperties : undefined}
    draggable={!editing}
    onClick={(e) => { if (e.target === e.currentTarget) choose(e); }}
    onMouseDown={(e) => { if (e.button === 1 && !editing) { e.preventDefault(); closeTabAsking(tab.id, tab.dormant === true); } }}
    onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
    onContextMenu={(e) => {
      if (editing) return;
      e.preventDefault(); e.stopPropagation(); useStore.getState().openMenu(tab.id, e.clientX, e.clientY);
    }}
    onDragStart={(e) => {
      dragging.current = true;
      const s = useStore.getState();
      const ids = s.selectedTabIds.includes(tab.id) ? s.selectedTabIds : [tab.id];
      if (!s.selectedTabIds.includes(tab.id)) s.clearSelection();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_MIME, tab.id); e.dataTransfer.setData(TABS_MIME, JSON.stringify(ids));
      s.setDraggingTabs(ids);
      if (ids.length > 1) {
        const ghost = document.createElement("div"); ghost.className = "drag-ghost"; ghost.textContent = `${ids.length} tabs`;
        document.body.appendChild(ghost); e.dataTransfer.setDragImage(ghost, 12, 12); setTimeout(() => ghost.remove(), 0);
      }
    }}
    onDragOver={(e) => {
      const s = useStore.getState();
      if (!s.draggingTabIds.length && !e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      setEdge(s.draggingTabIds.includes(tab.id) ? null : e.clientY >= r.top + r.height / 2 ? "after" : "before");
    }}
    onDragLeave={(e) => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setEdge(null); }}
    onDrop={(e) => {
      e.preventDefault(); e.stopPropagation();
      const s = useStore.getState(); const payload = draggedIds(e.dataTransfer);
      const ids = payload.length ? payload : s.draggingTabIds;
      const r = e.currentTarget.getBoundingClientRect();
      const target = tabPlacement(s.tabs, ids, tab.id, e.clientY >= r.top + r.height / 2);
      if (target) s.moveTabsTo(ids, target.groupId, target.beforeId);
      setEdge(null); s.setDraggingTabs([]); s.setContentDrag(null);
    }}
    onDragEnd={() => {
      useStore.getState().setDraggingTabs([]); useStore.getState().setContentDrag(null);
      setTimeout(() => { dragging.current = false; }, 0);
    }}>
    <TabRowContent tab={tab}
      iconSlot={<button type="button" className={`tab-icon-action${shareable ? " can-share" : ""}${tab.share ? " sharing" : ""}`}
        tabIndex={deviated || shareable ? 0 : -1}
        title={deviated ? text.resetPinned : shareable ? shareHint : tab.dormant ? text.sleeping : tab.title}
        aria-label={deviated ? text.resetPinned : shareable ? shareHint : tab.title}
        onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) { choose(e); return; }
          if (deviated) void resetPinnedTab(tab.id);
          else if (shareable) { if (!blocked) useStore.getState().setShareDialogTab(tab.id); }
          else choose(e);
        }}>
        <span className="tab-icon-face">{icon ? <img className="tab-icon tab-favicon" src={icon} alt="" /> : <Icon className="tab-icon" />}</span>
        {shareable && <span className="tab-icon-share"><ShareIcon /></span>}
      </button>}
      titleSlot={editing ? <SidebarRenameInput value={tab.title} label={text.renameTab}
        onSave={(name) => useStore.getState().renameTab(tab.id, name)}
        onDone={(restore) => {
          useStore.getState().setRenamingTab(null);
          if (restore) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
        }} /> : <button type="button" ref={mainRef} className="tab-main" aria-label={tab.title} draggable
          aria-current={active ? "page" : undefined} title={[tab.title, subtitle, tab.dormant ? text.sleeping : ""].filter(Boolean).join("\n")}
          onClick={choose} onDoubleClick={() => useStore.getState().setRenamingTab(tab.id)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); useStore.getState().setRenamingTab(tab.id); }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect();
              useStore.getState().openMenu(tab.id, r.left + 12, r.bottom);
            }
          }}><span className="tab-lines">
            <span className="tab-title">{deviated && <span className="tab-deviation" title={text.deviationHint}>/ </span>}{tab.title}</span>
            {subtitle && <span className="tab-subtitle-wrap">
              {profileBadge && <span className="tab-profile-dot" style={{ background: profileBadgeVar(profileBadge) }} title={text.profileBadgeHint({ name: tab.profile ?? "" })} />}
              <span className="tab-subtitle">{subtitle}</span>
            </span>}
          </span></button>}
    />
    {splitIndex >= 0 && <span className="tab-split-mark" title={text.splitMember({ index: splitIndex + 1, total: split!.ids.length })}
      aria-label={text.splitMember({ index: splitIndex + 1, total: split!.ids.length })}>◫</span>}
    {tab.type === "browser" && (audible || muted) && <button className="tab-audio" title={muted ? text.mutedHint : text.audibleHint}
      aria-label={muted ? text.mutedHint : text.audibleHint} onMouseDown={(e) => e.stopPropagation()} onClick={() => toggleMute(tab.id)}>
      {muted ? <SpeakerMutedIcon /> : <SpeakerIcon />}</button>}
    <button className={`tab-close${tab.dormant && tab.groupId !== null ? " remove-saved" : ""}`} aria-label={closeLabel} title={closeLabel}
      onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); if (e.detail <= 1) closeTabAsking(tab.id, tab.dormant === true); }}><CloseIcon /></button>
  </div>;
}
