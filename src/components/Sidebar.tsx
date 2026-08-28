import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { closeTabAsking, runAppCommand } from "../appCommands";
import { shareBlockedReason, shareBlockedText } from "../share/framework/terminalBlocking";
import { shareCapability } from "../share/framework/capability";
import { useFavicon } from "../favicons";
import { tabSubtitle } from "../tabMeta";
import { GroupHeadContent, TabRowContent } from "./sidebarContent";
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
  splitPartners,
  splittable,
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
  SpeakerIcon,
  SpeakerMutedIcon,
  TAB_ICONS,
  GearIcon,
  MoreIcon,
} from "./icons";
import { toggleMute } from "../mediaControl";
import { LoadingState } from "./state/LoadingState";
import { useProfiles } from "./useProfiles";
import { profileBadgeVar } from "../theme/tokens";
import { footerMenuPosition } from "./sidebarLayout";

/**
 * Which tabs a drag is carrying. One kind of drop handler, whether the drag
 * started as one row or several — a second code path for the plural case is
 * how the two get to disagree about what a drop means.
 */
function draggedIds(dt: DataTransfer | null): string[] {
  // Programmatic drops may carry no payload, so treat a missing transfer as
  // an empty selection.
  if (!dt) return [];
  const many = dt.getData("text/tabverse-tabs");
  if (many) {
    try {
      const list = JSON.parse(many);
      if (Array.isArray(list) && list.every((x) => typeof x === "string")) return list;
    } catch {
      // Fall through to the single id: a malformed list is not a reason to
      // drop the drag on the floor.
    }
  }
  const one = dt.getData("text/tabverse-tab");
  return one ? [one] : [];
}

const GROUP_MIME = "text/tabverse-group";

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

const subtitleFor = tabSubtitle;

const ProfileBadges = createContext<Record<string, string>>({});

function TabRow({
  tab,
  active,
  indent,
  depth = 0,
  peek,
}: {
  tab: Tab;
  active: boolean;
  indent?: boolean;
  /** Nesting level of the group this row sits in; 0 for a top-level group. */
  depth?: number;
  peek?: boolean;
}) {
  const activateTab = useStore((s) => s.activateTab);
  const moveTab = useStore((s) => s.moveTab);
  const moveTabs = useStore((s) => s.moveTabs);
  const selected = useStore((s) => s.selectedTabIds.includes(tab.id));
  const coActive = useStore((s) => splitPartners(s).includes(tab.id));
  const openMenu = useStore((s) => s.openMenu);
  const setShareDialogTab = useStore((s) => s.setShareDialogTab);
  const renameTab = useStore((s) => s.renameTab);
  const audible = useStore((s) => !!s.audibleTabs[tab.id]);
  const muted = useStore((s) => !!s.mutedTabs[tab.id]);
  const profileBadges = useContext(ProfileBadges);
  const profileBadge =
    tab.type === "terminal" &&
    typeof tab.profile === "string" &&
    tab.profile !== ""
      ? profileBadges[tab.profile]
      : undefined;
  const [ownEditing, setOwnEditing] = useState(false);
  const askedToRename = useStore((s) => s.renamingTabId === tab.id);
  const editing = ownEditing || askedToRename;
  const setEditing = (on: boolean) => {
    setOwnEditing(on);
    if (!on && askedToRename) useStore.getState().setRenamingTab(null);
  };
  // Which half of this row a dropped tab would take, or null when the drop
  // means "reorder" instead (2026-08-12 feedback 3).
  const [splitSide, setSplitSide] = useState<"left" | "right" | null>(null);
  const [dropBefore, setDropBefore] = useDropFlag();
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the press that is finishing turned into a drag.
  const draggingRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const shareCap = shareCapability(tab.type);
  const shared = !!tab.share;
  const shareBlocked = shareBlockedReason(tab) !== null;

  const pressedRef = useRef(false);

  const clickRow = () => {
    const st = useStore.getState();
    if (
      st.activeTabId === tab.id &&
      tab.pinnedUrl !== undefined &&
      tab.url !== tab.pinnedUrl
    ) {
      runAppCommand("go-pinned");
    }
    activateTab(tab.id);
  };

  return (
    <div
      className={[
        "tab-row",
        active ? "active" : "",
        coActive ? "co-active" : "",
        selected ? "selected" : "",
        tab.exited ? "exited" : "",
        indent ? "indent" : "",
        tab.attention ? "attention" : "",
        dropBefore ? "drop-before" : "",
        splitSide === "left" ? "split-drop-left" : "",
        splitSide === "right" ? "split-drop-right" : "",
        tab.dormant ? "dormant" : "",
        peek ? "peek" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // Stable identity for drag targets and automation.
      data-tab-id={tab.id}
      style={indent || peek ? depthVar(depth + 1) : undefined}
      draggable={!editing}
      onDragStart={(e) => {
        draggingRef.current = true;
        const st = useStore.getState();
        // Dragging a row that is part of the picked-out set moves the whole
        // set; dragging any other row is an ordinary single drag and drops
        // the set, because otherwise a stale selection silently comes along
        // for a ride the user did not ask for.
        const ids = st.selectedTabIds.includes(tab.id)
          ? st.tabs.filter((t) => st.selectedTabIds.includes(t.id)).map((t) => t.id)
          : [tab.id];
        if (ids.length === 1) st.clearSelection();
        e.dataTransfer.setData("text/tabverse-tab", tab.id);
        e.dataTransfer.setData("text/tabverse-tabs", JSON.stringify(ids));
        // Said once, here, because it cannot be asked later: dragover gets a
        // protected data store and would read an empty string.
        st.setDraggingTabs(ids);
        if (ids.length === 1) {
          const active = st.tabs.find((t) => t.id === st.activeTabId);
          if (armsSplitDrag(tab, active)) {
            st.setContentDrag({ id: tab.id, side: null });
          }
        }
        if (ids.length > 1) {
          // Otherwise the cursor carries one row and nothing says the other
          // two are coming.
          const ghost = document.createElement("div");
          ghost.className = "drag-ghost";
          ghost.textContent = `${ids.length} tabs`;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 12, 12);
          window.setTimeout(() => ghost.remove(), 0);
        }
      }}
      onDragOver={(e) => {
        // Either signal is enough: the payload's type or the remembered ids.
        const dragging = useStore.getState().draggingTabIds.length > 0;
        if (!dragging && !e.dataTransfer?.types.includes("text/tabverse-tab")) {
          return;
        }
        e.preventDefault();
        // Where in the row decides WHAT the drop means, which is how Arc
        // tells its two tab drags apart: across the middle of another tab is
        // "put these side by side", along its edges is "put it here in the
        // list". Only two splittable tabs can pair up, so anywhere else the
        // middle band simply reads as a reorder.
        const r = e.currentTarget.getBoundingClientRect();
        const t = (e.clientY - r.top) / Math.max(1, r.height);
        const middle = t > 0.28 && t < 0.72;
        const canSplit = middle && splittable(tab) && splittableDrag(tab.id);
        setSplitSide(
          canSplit ? (e.clientX - r.left < r.width / 2 ? "left" : "right") : null
        );
        setDropBefore(!canSplit);
      }}
      onDragEnd={() => {
        useStore.getState().setDraggingTabs([]);
        // Cleared on the next turn so the release that ends the drag does
        // not read as a plain click on this row.
        window.setTimeout(() => {
          draggingRef.current = false;
        }, 0);
      }}
      onDragLeave={() => {
        setDropBefore(false);
        setSplitSide(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        // Without this the drop bubbles on to the list container, whose
        // handler un-groups and re-appends — undoing this move instantly.
        e.stopPropagation();
        const side = splitSide;
        setDropBefore(false);
        setSplitSide(null);
        const remembered = useStore.getState().draggingTabIds;
        useStore.getState().setDraggingTabs([]);
        const fromPayload = draggedIds(e.dataTransfer);
        const ids = fromPayload.length > 0 ? fromPayload : remembered;
        if (side !== null && ids.length === 1) {
          useStore.getState().splitOnTab(ids[0], tab.id, side);
          return;
        }
        if (ids.length > 1) moveTabs(ids, tab.id);
        else if (ids.length === 1) moveTab(ids[0], tab.id);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTabAsking(tab.id);
          return;
        }
        if (e.button !== 0 || editing) return;
        const st = useStore.getState();
        // The two ways every list on this platform picks out more than one
        // row. Neither switches tabs: picking is not going.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          st.toggleSelected(tab.id);
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          st.extendSelectionTo(tab.id);
          return;
        }
        // A drag begins with a plain press on a row that is already picked
        // out — so clearing here threw the selection away a moment before
        // the drag could read it, and every multi-row drag moved exactly
        // one row. The decision waits for the release instead: dragged, and
        // the picking stands; released without dragging, and it collapses
        // to this row, which is what a plain click means.
        if (st.selectedTabIds.includes(tab.id)) return;
        st.clearSelection();
        // Going there waits for the release (2026-08-12 feedback 3). A drag
        // begins with a press, so switching here meant the dragged tab was
        // ALWAYS the one in front by the time it was dropped — and "split
        // this with whatever is in front" could then never mean anything.
        // Arc has the same property: dragging a tab does not go to it.
        pressedRef.current = true;
      }}
      // The release is where a press becomes a click — and only a press that
      // never turned into a drag counts. Two cases arrive here: a row that
      // was part of the picked-out set (the pick collapses to this row), and
      // a plain row whose press deliberately did NOT go there yet.
      onMouseUp={(e) => {
        const wasPress = pressedRef.current;
        pressedRef.current = false;
        if (e.button !== 0 || editing) return;
        if (draggingRef.current || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const st = useStore.getState();
        if (st.selectedTabIds.includes(tab.id)) {
          st.clearSelection();
          clickRow();
          return;
        }
        if (wasPress) clickRow();
      }}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(tab.id, e.clientX, e.clientY);
      }}
      title={tab.title}
    >
      <TabRowContent
        tab={tab}
        titleSlot={
          editing ? (
            <input
              ref={inputRef}
              className="tab-rename"
              defaultValue={tab.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) renameTab(tab.id, v);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
                e.stopPropagation();
              }}
            />
          ) : undefined
        }
        subtitleSlot={
          subtitleFor(tab) && (
            <span className="tab-subtitle-wrap">
              {profileBadge !== undefined && (
                <span
                  className="tab-profile-dot"
                  style={{ background: profileBadgeVar(profileBadge) }}
                  title={STR.common.sidebar.profileBadgeHint({
                    name: tab.profile ?? "",
                  })}
                />
              )}
              <span className="tab-subtitle">{subtitleFor(tab)}</span>
            </span>
          )
        }
      />
      {tab.type === "browser" && (audible || muted) && (
        <button
          className={`tab-audio${muted ? " muted" : ""}`}
          title={
            muted
              ? STR.common.sidebar.mutedHint
              : STR.common.sidebar.audibleHint
          }
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleMute(tab.id);
          }}
        >
          {muted ? <SpeakerMutedIcon /> : <SpeakerIcon />}
        </button>
      )}
      {shareCap.shareable && tab.dormant !== true && (
        <button
          className={`tab-share${shared ? " on" : ""}`}
          disabled={shareBlocked}
          title={
            shareBlocked
              ? (shareBlockedText(shareBlockedReason(tab)) ?? undefined)
              : shared
                ? STR.common.sidebar.sharingHint({ viewers: tab.share!.viewers.length })
                : STR.common.sidebar.shareHint
          }
          aria-label={
            shareBlocked
              ? (shareBlockedText(shareBlockedReason(tab)) ?? undefined)
              : shared
                ? STR.common.sidebar.sharingHint({ viewers: tab.share!.viewers.length })
                : STR.common.sidebar.shareHint
          }
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setShareDialogTab(tab.id);
          }}
        >
          <ShareIcon />
          {shared && tab.share!.viewers.length > 0 && (
            <span className="share-count">{tab.share!.viewers.length}</span>
          )}
        </button>
      )}
      {tab.dormant !== true && (
        <button
          className="tab-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            closeTabAsking(tab.id);
          }}
          aria-label={STR.common.sidebar.closeTab}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
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
    <div
      className={`split-half-row${active ? " active" : ""}`}
      // Stable identity for each half of a split row.
      data-tab-id={tab.id}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        activateTab(tab.id);
      }}
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
    </div>
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
    <TabRow tab={tab} active={active} indent={indent} depth={depth} peek={peek} />
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
      onClick={() => {
        if (editing) return;
        latchAndClose();
        toggle(group.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
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
          setDropping(true);
          return;
        }
        if (e.dataTransfer.types.includes(GROUP_MIME)) {
          e.preventDefault();
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
      <GroupHeadContent
        group={group}
        count={count}
        titleSlot={
          editing || naming ? (
            <input
              className="tab-rename"
              autoFocus
              defaultValue={group.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) renameGroup(group.id, v);
                stopNaming();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") stopNaming();
                e.stopPropagation();
              }}
            />
          ) : undefined
        }
        afterTitleSlot={
          previewPending && (
            <LoadingState
              inline
              label={STR.panels.folderPreview.opening}
            />
          )
        }
      />
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

export function armsSplitDrag(
  dragged: Tab | undefined,
  active: Tab | undefined
): boolean {
  return (
    splittable(dragged) && splittable(active) && dragged.id !== active.id
  );
}

/**
 * Could the tab being dragged form a split with this row's tab?
 *
 * The dragged id travels in the drag payload, so this is answerable during
 * dragover — which is when the answer is needed, to decide whether the middle
 * of the row means "split" or just "reorder". One splittable tab, and not the
 * same one twice; the ROW's own eligibility is asked by the caller, which has
 * the row to hand.
 */
export function splittableDrag(targetId: string): boolean {
  const st = useStore.getState();
  // One tab only: dragging a picked-out set is a reorder, never a split.
  if (st.draggingTabIds.length !== 1) return false;
  const dragged = st.draggingTabIds[0];
  if (dragged === targetId) return false;
  return splittable(st.tabs.find((x) => x.id === dragged));
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
        // Bare attribute means "only a direct click on this element": empty
        // list background drags the window, a click on a tab row does not
        // (the row is not itself a region, so the walk stops there).
        data-tauri-drag-region
        onDragOver={(e) => {
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
