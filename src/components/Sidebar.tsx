import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { runAppCommand } from "../appCommands";
import { useFavicon } from "../favicons";
import { GroupHeadContent } from "./sidebarContent";
import { SidebarTreePresentation } from "@tabverse/workbench/sidebar";
import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import { keysFor } from "../shortcuts";
import {
  FolderPreview,
  cancelPreviewClose,
  openFolderPreview,
  schedulePreviewClose,
} from "./FolderPreview";
import {
  groupSubtreeIds,
  rootGroups,
  sidebarShowing,
  subtreeTabs,
  useStore,
  type Group,
  type SplitGroup,
  type Tab,
} from "../state/store";
import {
  ArchiveIcon,
  CloseIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  SidebarIcon,
  TAB_ICONS,
  GearIcon,
  MoreIcon,
} from "./icons";
import { LoadingState } from "./state/LoadingState";
import { useProfiles } from "./useProfiles";
import { footerMenuPosition } from "./sidebarLayout";

import { SidebarTabRow, ProfileBadges } from "./SidebarTabRow";
import { SidebarRenameInput } from "./SidebarRenameInput";
import { draggedIds, GROUP_MIME, SIDEBAR_UX } from "./sidebarInteraction";
import { useSidebarNavigation } from "./useSidebarNavigation";
import "./sidebar-ux.css";
export { armsSplitDrag, splittableDrag } from "./useSidebarTabDrop";

const depthVar = (level: number): CSSProperties =>
  ({ "--depth": level }) as CSSProperties;

function useDropFlag(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const clear = () => setOn(false);
    // Capture phase, and that is the whole fix. A drop onto a tab row or a
    // group header stops the event there — those handlers have to, or the
    // list's own handler would undo the move they just made — so a listener
    // out here in the bubble phase never runs, and the mark it was supposed
    // to clear stays on screen. Capture runs before any of them.
    //
    // Both events, because neither covers everything: `drop` says where it
    // landed, `dragend` says the drag is over however it ended, and a drop
    // that reorders the list can unmount the row the drag started from
    // before its `dragend` is ever delivered.
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, []);
  return [on, setOn];
}

function SplitHalf({ tab, active }: { tab: Tab; active: boolean }) {
  const activateTab = useStore((s) => s.activateTab);
  const openMenu = useStore((s) => s.openMenu);
  const favicon = useFavicon(
    tab.type === "browser" ? tab.url : undefined,
    tab.id
  );
  const Icon = TAB_ICONS[tab.type];
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={`split-half-row${active ? " active" : ""}`}
      // Stable identity for each half of a split row.
      data-tab-id={tab.id}
      onClick={() => activateTab(tab.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(tab.id, e.clientX, e.clientY);
      }}
      title={tab.title}
    >
      {favicon !== null ? (
        <img className="tab-icon tab-favicon" src={favicon} alt="" />
      ) : (
        <Icon className="tab-icon" />
      )}
      <span className="split-half-title">{tab.title}</span>
    </button>
  );
}

function SplitRow({
  split,
  depth,
  indent,
  peek,
}: {
  split: SplitGroup;
  depth: number;
  indent?: boolean;
  peek?: boolean;
}) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const members = split.ids.map((id) => tabs.find((t) => t.id === id));
  if (members.some((m) => m === undefined)) return null;
  return (
    <div
      className={`tab-row split-row${indent || peek ? " indent" : ""}`}
      style={indent || peek ? depthVar(depth + 1) : undefined}
    >
      {members.map((m, i) => (
        <Fragment key={m!.id}>
          {i > 0 && <span className="split-row-seam" />}
          <SplitHalf tab={m!} active={activeTabId === m!.id} />
        </Fragment>
      ))}
    </div>
  );
}

function SidebarRow({
  tab,
  active,
  indent,
  depth = 0,
  peek,
}: {
  tab: Tab;
  active: boolean;
  indent?: boolean;
  depth?: number;
  peek?: boolean;
}) {
  const split = useStore((s) => s.split);
  if (split !== null && split.ids.includes(tab.id)) {
    if (tab.id !== split.ids[0]) return null;
    return <SplitRow split={split} depth={depth} indent={indent} peek={peek} />;
  }
  return (
    <SidebarTabRow tab={tab} active={active} indent={indent} depth={depth} peek={peek} />
  );
}

function GroupHeader({
  group,
  count,
  depth = 0,
}: {
  group: Group;
  count: number;
  depth?: number;
}) {
  const toggle = useStore((s) => s.toggleGroupCollapsed);
  const renameGroup = useStore((s) => s.renameGroup);
  const closeGroup = useStore((s) => s.closeGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const moveTab = useStore((s) => s.moveTab);
  const assignToGroup = useStore((s) => s.assignToGroup);
  const setGroupParent = useStore((s) => s.setGroupParent);
  const moveGroupBefore = useStore((s) => s.moveGroupBefore);
  const openGroupMenu = useStore((s) => s.openGroupMenu);
  const namingGroupId = useStore((s) => s.namingGroupId);
  const setNamingGroup = useStore((s) => s.setNamingGroup);
  const previewPending = useStore(
    (s) => s.folderPreviewPendingGroupId === group.id
  );
  const [editing, setEditing] = useState(false);
  const headRef = useRef<HTMLButtonElement>(null);
  // A group made from the sidebar's menu opens ready to be named, so the
  // row that just appeared is the row being typed into.
  const naming = namingGroupId === group.id;
  const stopNaming = () => {
    if (naming) setNamingGroup(null);
    setEditing(false);
  };
  const [dropping, setDropping] = useDropFlag();
  const [dropBefore, setDropBefore] = useDropFlag();

  const previewTimer = useRef<number | null>(null);
  const cancelPreviewOpen = () => {
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  };
  useEffect(() => cancelPreviewOpen, []);
  const latchedRef = useRef(false);
  const latchAndClose = () => {
    latchedRef.current = true;
    cancelPreviewOpen();
    useStore.getState().setFolderPreview(null);
  };

  /** Whether the pointer is in the header's reorder zone (its top band). */
  const inBeforeZone = (e: ReactDragEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height * 0.35;
  };

  return (
    <div
      className={`group-head${dropping ? " dropping" : ""}${
        dropBefore ? " drop-before" : ""
      }`}
      // Stable identity for a group drag target.
      data-group-id={group.id}
      style={depth > 0 ? depthVar(depth) : undefined}
      draggable={group.preset === undefined && !editing && !naming}
      onDragStart={(e) => {
        e.dataTransfer.setData(GROUP_MIME, group.id);
        latchAndClose();
      }}
      onMouseEnter={() => {
        cancelPreviewOpen();
        // Back on the open panel's own row: the hover is not over, so the
        // close scheduled by leaving it (or the panel) is called off.
        if (useStore.getState().folderPreviewGroupId === group.id) {
          cancelPreviewClose();
        }
        if (latchedRef.current || naming || editing || !group.collapsed) {
          return;
        }
        cancelPreviewClose();
        previewTimer.current = window.setTimeout(() => {
          previewTimer.current = null;
          // Re-checked at fire: 250ms is plenty for the folder to expand
          // or a naming input to appear under a pointer that never moved.
          const st = useStore.getState();
          if (st.namingGroupId === group.id) return;
          if (st.groups.find((g) => g.id === group.id)?.collapsed !== true) {
            return;
          }
          void openFolderPreview(group.id, () => {
            const s2 = useStore.getState();
            return (
              !latchedRef.current &&
              s2.namingGroupId !== group.id &&
              s2.groups.find((g) => g.id === group.id)?.collapsed === true
            );
          });
        }, 250);
      }}
      onMouseLeave={() => {
        latchedRef.current = false;
        cancelPreviewOpen();
        // Leaving may mean "into the panel" — the grace delay lets the
        // panel's own mouseenter (or the pointer's sheer presence on it,
        // see schedulePreviewClose) call this off. Any open panel is
        // scheduled, not just this row's own: a pointer that wandered off
        // across other headers must still let the panel it left close.
        if (useStore.getState().folderPreviewGroupId !== null) {
          schedulePreviewClose();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        latchAndClose();
        openGroupMenu(group.id, e.clientX, e.clientY);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/tabverse-tab")) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
          return;
        }
        if (e.dataTransfer.types.includes(GROUP_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          const before = inBeforeZone(e);
          setDropBefore(before);
          setDropping(!before);
        }
      }}
      onDragLeave={() => {
        setDropping(false);
        setDropBefore(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        setDropBefore(false);
        e.stopPropagation();
        const draggedGroup = e.dataTransfer.getData(GROUP_MIME);
        if (draggedGroup) {
          // The store refuses an ancestor dropped into its own descendant,
          // with no side effects — nothing to clean up here.
          if (inBeforeZone(e)) moveGroupBefore(draggedGroup, group.id);
          else setGroupParent(draggedGroup, group.id);
          return;
        }
        for (const id of draggedIds(e.dataTransfer)) {
          assignToGroup(id, group.id);
          moveTab(id, null);
        }
      }}
      title={group.collapsed ? "Expand group" : "Collapse group"}
    >
      {editing || naming ? (
        <div className="group-toggle group-editing">
          <GroupHeadContent group={group} count={count} titleSlot={
            <SidebarRenameInput value={group.name} label="Rename group"
              onSave={(name) => renameGroup(group.id, name)}
              onDone={(restoreFocus) => {
                stopNaming();
                if (restoreFocus) requestAnimationFrame(() => headRef.current?.focus({ preventScroll: true }));
              }} />
          } />
        </div>
      ) : (
        <button type="button" className="group-toggle" ref={headRef}
          aria-expanded={!group.collapsed} aria-label={group.name}
          onClick={() => { latchAndClose(); toggle(group.id); }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
          onKeyDown={(e) => {
            if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); setEditing(true); }
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault(); e.stopPropagation();
              const collapse = e.key === "ArrowLeft";
              if (group.collapsed !== collapse) { latchAndClose(); toggle(group.id); }
            }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault(); e.stopPropagation(); latchAndClose();
              const box = e.currentTarget.getBoundingClientRect();
              openGroupMenu(group.id, box.left + 12, box.bottom);
            }
          }}>
          <GroupHeadContent group={group} count={count}
            afterTitleSlot={previewPending && <LoadingState inline label={STR.panels.folderPreview.opening} />} />
        </button>
      )}
      <button
        className="tab-close"
        title={
          count === 0
            ? STR.common.sidebar.deleteGroupHint
            : STR.common.sidebar.closeGroupHint
        }
        aria-label={
          count === 0
            ? STR.common.sidebar.deleteGroupHint
            : STR.common.sidebar.closeGroupHint
        }
        onClick={(e) => {
          e.stopPropagation();
          if (count === 0) deleteGroup(group.id);
          else closeGroup(group.id);
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function GroupTailDrop({ group, depth }: { group: Group; depth: number }) {
  const assignToGroup = useStore((s) => s.assignToGroup);
  const moveTabs = useStore((s) => s.moveTabs);
  const [dropping, setDropping] = useDropFlag();
  return (
    <div
      className={`group-tail-drop${dropping ? " dropping" : ""}`}
      data-group-id={group.id}
      style={depthVar(depth + 1)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/tabverse-tab")) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const ids = draggedIds(e.dataTransfer);
        if (ids.length === 0) return;
        for (const id of ids) assignToGroup(id, group.id);
        moveTabs(ids, null);
      }}
    />
  );
}

function GroupBlock({ group, depth }: { group: Group; depth: number }) {
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const activeTabId = useStore((s) => s.activeTabId);
  return (
    <SidebarTreePresentation
      group={group}
      groups={groups}
      tabs={tabs}
      depth={depth}
      className="group-block"
      subtreeTabs={subtreeTabs}
      countForGroup={({ group: countedGroup }) => {
        const ids = groupSubtreeIds(groups, countedGroup.id);
        return tabs.filter((tab) => tab.groupId !== null && ids.includes(tab.groupId)).length;
      }}
      renderGroupHead={({ group: treeGroup, count, depth: treeDepth }) => (
        <GroupHeader group={treeGroup} count={count} depth={treeDepth} />
      )}
      renderTab={({ tab, depth: treeDepth, peek }) => (
        <SidebarRow
          tab={tab}
          active={tab.id === activeTabId}
          indent
          depth={treeDepth}
          peek={peek}
        />
      )}
      renderExpandedTail={({ group: treeGroup, depth: treeDepth }) => (
        <GroupTailDrop group={treeGroup} depth={treeDepth} />
      )}
      shouldRenderCollapsedTab={(tab) => tab.dormant !== true}
    />
  );
}

function ZoneDivider() {
  const archiveCount = useStore((s) => s.archive.length);
  const setArchiveOpen = useStore((s) => s.setArchiveOpen);
  const archiveAllToday = useStore((s) => s.archiveAllToday);
  const anyToday = useStore((s) => s.tabs.some((t) => t.groupId === null));
  return (
    <div className="zone-divider">
      <span className="zone-label">{STR.common.sidebar.todayZone}</span>
      <span className="zone-divider-line" />
      <button
        className={`group-archive${archiveCount === 0 ? " bare" : ""}`}
        title={STR.common.sidebar.archivedHint}
        aria-label={STR.common.sidebar.archivedHint}
        onClick={() => setArchiveOpen(true)}
      >
        <ArchiveIcon />
        {archiveCount}
      </button>
      <button
        className="zone-clear"
        disabled={!anyToday}
        title={STR.common.sidebar.archiveTodayHint}
        onClick={() => archiveAllToday()}
      >
        {STR.common.sidebar.clear}
      </button>
    </div>
  );
}

export function Sidebar() {
  const [footMenu, setFootMenu] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const backgroundTaskCount = useStore((s) => s.backgroundTasks.length);
  const tabs = useStore((s) => s.tabs);
  const width = useStore((s) => s.sidebarWidth);
  const appShare = useStore((s) => s.appShare);
  const setAppSharePanel = useStore((s) => s.setAppSharePanel);
  const pinned = useStore((s) => s.sidebarPinned);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const openSidebarMenu = useStore((s) => s.openSidebarMenu);
  // The profiles' badge names, once per sidebar (see ProfileBadges): rows
  // read the map from context, the file is read once no matter how many
  // rows there are.
  const { list: profileConfig } = useProfiles();
  const profileBadges = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of profileConfig) {
      if (typeof p.badge === "string" && p.badge.trim() !== "") {
        out[p.name] = p.badge.trim();
      }
    }
    return out;
  }, [profileConfig]);
  // Highlighted while a tab is being dragged over the empty background,
  // where the drop means "leave every group".
  // The one that was missing the fix, which is why the line above the
  // footer outlived the drag.
  const [listDrop, setListDrop] = useDropFlag();
  // Unpinned, the sidebar waits off-screen and slides back while the
  // pointer is on it or on the strip along the window's edge.
  const peeking = useStore(sidebarShowing);
  const setPeeking = useStore((s) => s.setSidebarPeeking);
  // A drop onto a tab row stops propagating, so the list's own handler
  // never runs and its indicator would stay lit after the drag is over.
  // The end of a drag is the only event every case shares.
  useEffect(() => {
    const clear = () => setListDrop(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  // Drag the right edge. Pointer capture keeps the drag alive when the
  // cursor outruns the 4-pixel handle, which is most of the time.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSidebarWidth(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const groups = useStore((s) => s.groups);
  const activeTabId = useStore((s) => s.activeTabId);
  const setNewTabMenu = useStore((s) => s.setNewTabMenu);
  const addTab = useStore((s) => s.addTab);
  const moveTab = useStore((s) => s.moveTab);
  const assignToGroup = useStore((s) => s.assignToGroup);
  const setGroupParent = useStore((s) => s.setGroupParent);

  const listRef = useRef<HTMLDivElement>(null);
  const navigation = useSidebarNavigation(listRef, activeTabId, pinned === true || peeking);

  const today = tabs.filter((t) => !t.groupId && t.peek !== true);


  return (
    <aside
      className={`sidebar${pinned ? "" : " floating"}${peeking ? " peeking" : ""}`}
      // undefined, not a number, while the width has not been read: the
      // element then takes its stylesheet width rather than a guessed one.
      style={{ width: width ?? undefined }}
      onMouseEnter={() => setPeeking(true)}
      // A menu opens *under the pointer* and is not a descendant of this
      // element, so the browser reports the pointer as having left — and
      // the sidebar slid away while the user was still standing on it.
      // While a menu of its own is open, the sidebar is in use.
      onMouseLeave={() => {
        const s2 = useStore.getState();
        if (s2.sidebarMenu || s2.menu || s2.groupMenu || s2.folderPreviewGroupId)
          return;
        setPeeking(false);
      }}
    >
      {/* "deep": everything in the head drags the window, including the
          brand and any empty gap — a bare attribute only counts direct hits
          on the element itself, which is why parts of it did nothing. The
          buttons still click, because a clickable element blocks the walk
          unless it opts in. */}
      <div className="sidebar-head" data-tauri-drag-region="deep">
        {/* The window's own close/minimise/zoom buttons sit in this strip.
            "deep" would otherwise claim it, putting our drag handler in
            front of them — and a close button that does nothing is the
            result. "false" hands the strip back to the system. */}
        <span className="traffic-light-zone" data-tauri-drag-region="false" />
        {/* Header controls split into task groups: sidebar control by the
            traffic lights, search and create actions on the right. */}
        <div className="sidebar-head-left">
          <button
            className="icon-btn"
            onClick={toggleSidebar}
            aria-pressed={pinned === true}
            title={(pinned
              ? STR.common.sidebar.unpinHint
              : STR.common.sidebar.pinHint)({
              keys: formatKeys(keysFor("toggle-sidebar")),
            })}
            aria-label={(pinned
              ? STR.common.sidebar.unpinHint
              : STR.common.sidebar.pinHint)({
              keys: formatKeys(keysFor("toggle-sidebar")),
            })}
          >
            {/* Match Buzz's mode glyphs: persistent sidebar = figure 1;
                auto-collapse sidebar = figure 2, including while the
                floating panel is temporarily peeking into view. */}
            <SidebarIcon filled={pinned === true} />
          </button>
        </div>
        <div className="sidebar-head-right">
          <button
            className="icon-btn sidebar-search-btn"
            onClick={() => runAppCommand("command-bar")}
            title={STR.common.sidebar.searchHint({
              keys: formatKeys(keysFor("command-bar")),
            })}
            aria-label={STR.common.sidebar.searchHint({
              keys: formatKeys(keysFor("command-bar")),
            })}
          >
            <SearchIcon />
          </button>
          <button
            className="icon-btn"
            onClick={() => setNewTabMenu(true)}
            title={STR.common.sidebar.newTabHint({
              keys: formatKeys(keysFor("new-tab-menu")),
            })}
            aria-label={STR.common.sidebar.newTabHint({
              keys: formatKeys(keysFor("new-tab-menu")),
            })}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <ProfileBadges.Provider value={profileBadges}>
      <div
        className={`tab-list${listDrop ? " list-dropping" : ""}`}
        ref={listRef}
        aria-label={SIDEBAR_UX.tabs}
        {...navigation}
        // Bare attribute means "only a direct click on this element": empty
        // list background drags the window, a click on a tab row does not
        // (the row is not itself a region, so the walk stops there).
        data-tauri-drag-region
        onDragOver={(e) => {
          if (e.target !== e.currentTarget) { setListDrop(false); return; }
          if (
            e.dataTransfer.types.includes("text/tabverse-tab") ||
            e.dataTransfer.types.includes(GROUP_MIME)
          ) {
            e.preventDefault();
            setListDrop(true);
          }
        }}
        onDragLeave={() => setListDrop(false)}
        onMouseDown={(e) => {
          // Only the background. Clicking away is how every list on this
          // platform drops a selection.
          if (e.target === e.currentTarget) useStore.getState().clearSelection();
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          const divider = e.currentTarget.querySelector(".zone-divider");
          const zone =
            divider && e.clientY >= divider.getBoundingClientRect().top
              ? "today"
              : "pinned";
          openSidebarMenu(e.clientX, e.clientY, zone);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setListDrop(false);
          const draggedGroup = e.dataTransfer.getData(GROUP_MIME);
          if (draggedGroup) {
            setGroupParent(draggedGroup, null);
            return;
          }
          for (const id of draggedIds(e.dataTransfer)) {
            assignToGroup(id, null);
            moveTab(id, null);
          }
        }}
      >
        {rootGroups(groups).map((g) => (
          <GroupBlock key={g.id} group={g} depth={0} />
        ))}

        <ZoneDivider />

        {today.map((t) => (
          <SidebarRow key={t.id} tab={t} active={t.id === activeTabId} />
        ))}
      </div>
      </ProfileBadges.Provider>

      <FolderPreview />

      <div
        className="sidebar-resize"
        onPointerDown={startResize}
        title={STR.common.sidebar.dragResizeHint}
      />
      <div className="sidebar-foot" data-tauri-drag-region>
        {/* Round thirteen: one menu button instead of two loose glyphs —
            Settings and app-level remote control live behind it. The
            background-task badge rides the trigger so ongoing work stays
            visible with the menu closed. */}
        <button
          className={`icon-btn foot-menu-trigger${footMenu ? " on" : ""}`}
          aria-expanded={footMenu !== null}
          title={STR.common.sidebar.settings}
          aria-label={STR.common.sidebar.settings}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setFootMenu(
              footMenu
                ? null
                : footerMenuPosition(r, window.innerWidth, window.innerHeight)
            );
          }}
        >
          <MoreIcon />
          {backgroundTaskCount > 0 && (
            <span
              className="background-task-badge"
              data-background-task-count={backgroundTaskCount}
              title={STR.common.sidebar.backgroundTasksHint({
                count: backgroundTaskCount,
              })}
            >
              {backgroundTaskCount}
            </span>
          )}
        </button>
        {footMenu && (
          <>
            <div
              className="sort-menu-scrim"
              onMouseDown={() => setFootMenu(null)}
            />
            <div
              className="ctx-menu foot-menu"
              style={{ left: footMenu.left, bottom: footMenu.bottom }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="ctx-title">{STR.common.appName}</div>
              <button
                className="ctx-item"
                onClick={() => {
                  addTab({ type: "settings" });
                  setFootMenu(null);
                }}
              >
                <GearIcon className="ctx-item-icon" />
                {STR.common.sidebar.settings}
              </button>
              <button
                className={`ctx-item${appShare !== null ? " on" : ""}`}
                onClick={() => {
                  setAppSharePanel(true);
                  setFootMenu(null);
                }}
              >
                <ShareIcon className="ctx-item-icon" />
                {STR.share.appPanelTitle}
                {appShare !== null && appShare.viewers.length > 0 && (
                  <kbd className="ctx-kbd">{appShare.viewers.length}</kbd>
                )}
              </button>
            </div>
          </>
        )}
        <span className="version" data-tauri-drag-region>
          {`v${__APP_VERSION__}`}
        </span>
      </div>
    </aside>
  );
}
