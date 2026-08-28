import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { coreLog } from "../errlog";
import { useFavicon } from "../favicons";
import {
  FOLDER_PREVIEW_WIDTH,
  subtreeTabs,
  useStore,
  type Tab,
} from "../state/store";
import { relativeTime } from "./ArchivePanel";
import { TAB_ICONS } from "./icons";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;


/**
 * The close timer is shared between the headers (which schedule a close
 * when the pointer leaves them) and the panel (which cancels it when the
 * pointer arrives, and re-schedules when it leaves). One timer, module
 * scope: two owners with a timer each is how a panel gets closed by the
 * header it already left.
 */
let closeTimer: number | null = null;

export function cancelPreviewClose(): void {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export function schedulePreviewClose(delayMs = 300): void {
  cancelPreviewClose();
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    const st = useStore.getState();
    const gid = st.folderPreviewGroupId;
    if (gid === null) return;
    const head = document.querySelector(`.group-head[data-group-id="${gid}"]`);
    const panel = document.querySelector(".folder-preview");
    if (head?.matches(":hover") || panel?.matches(":hover")) return;
    st.setFolderPreview(null);
  }, delayMs);
}

export async function openFolderPreview(
  groupId: string,
  stillWanted?: () => boolean
): Promise<void> {
  const st = useStore.getState();
  const active = st.tabs.find((t) => t.id === st.activeTabId);
  const wants = () => (stillWanted ? stillWanted() : true);
  const show = () => {
    if (!wants()) return;
    useStore.getState().setFolderPreview(groupId);
    // The panel may open only after the pointer already left the header
    // (the snapshot costs real time), and then nobody is left to fire the
    // mouseleave that schedules the close — so it is scheduled here, with
    // the same presence check schedulePreviewClose itself applies.
    const head = document.querySelector(
      `.group-head[data-group-id="${groupId}"]`
    );
    const panel = document.querySelector(".folder-preview");
    if (!head?.matches(":hover") && !panel?.matches(":hover")) {
      schedulePreviewClose();
    }
  };
  if (
    !isTauri ||
    !active ||
    active.type !== "browser" ||
    active.url === undefined ||
    st.pageFreeze !== null ||
    st.folderPreviewGroupId !== null ||
    (!st.sidebarPinned && st.sidebarPeeking)
  ) {
    show();
    return;
  }
  useStore.getState().setFolderPreviewPending(groupId);
  try {
    await freezeActivePage(active.id, wants);
  } finally {
    useStore.getState().setFolderPreviewPending(null);
  }
  show();
}

export async function freezeActivePage(
  tabId: string,
  wants: () => boolean
): Promise<void> {
  let deadline: number | null = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const call = invoke<string>("browser_snapshot", { tabId });
    // Whichever side loses the race still settles later; both are marked
    // handled here so the loser cannot surface as an unhandled rejection.
    call.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      deadline = window.setTimeout(
        () => reject(new Error("slower than 300ms")),
        300
      );
    });
    timeout.catch(() => {});
    const src = await Promise.race([call, timeout]);
    if (!wants()) return; // the snapshot is simply dropped
    // A freeze may have landed from the other reason meanwhile (peek and
    // panel share one); do not clobber a live image with a second shot.
    if (useStore.getState().pageFreeze !== null) return;
    useStore.getState().setPageFreeze({ tabId, src });
  } catch (e) {
    coreLog("info", `snapshot freeze fell back for tab=${tabId}: ${e}`);
  } finally {
    if (deadline !== null) window.clearTimeout(deadline);
  }
}

export async function freezeForSidebarPeek(): Promise<void> {
  const st = useStore.getState();
  if (!isTauri || st.sidebarPinned || st.pageFreeze !== null) {
    return;
  }
  const active = st.tabs.find((t) => t.id === st.activeTabId);
  if (!active || active.type !== "browser" || active.url === undefined) return;
  // The peek may already be over by the time the snapshot lands; only freeze
  // if the sidebar is still out and nothing else has frozen meanwhile.
  await freezeActivePage(active.id, () => useStore.getState().sidebarPeeking);
}

function matches(tab: Tab, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (tab.title.toLowerCase().includes(q)) return true;
  // The line under a row's title is searchable too: "the github one" may be
  // typed as its host, "the api repo" as its directory.
  const extra = tab.type === "browser" ? tab.url ?? tab.pinnedUrl : tab.cwd;
  return (extra ?? "").toLowerCase().includes(q);
}

function PreviewRow({
  tab,
  selected,
  onPick,
  onHover,
}: {
  tab: Tab;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const Icon = TAB_ICONS[tab.type];
  const favicon = useFavicon(
    tab.type === "browser" ? tab.url ?? tab.pinnedUrl : undefined,
    tab.id
  );
  return (
    <div
      className={[
        "preview-row",
        selected ? "sel" : "",
        tab.dormant ? "dormant" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseEnter={onHover}
      onClick={onPick}
      title={tab.title}
    >
      {favicon !== null ? (
        <img className="tab-icon tab-favicon" src={favicon} alt="" />
      ) : (
        <Icon className="tab-icon" />
      )}
      <span className="preview-title">{tab.title}</span>
      <span className="preview-when">
        {tab.lastActiveAt !== undefined ? relativeTime(tab.lastActiveAt) : ""}
      </span>
    </div>
  );
}

export function FolderPreview() {
  const groupId = useStore((s) => s.folderPreviewGroupId);
  const group = useStore((s) =>
    s.groups.find((g) => g.id === s.folderPreviewGroupId)
  );
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const setFolderPreview = useStore((s) => s.setFolderPreview);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState<number | null>(null);

  // A fresh hover is a fresh question: the last search must not pre-filter
  // a different folder's panel.
  useEffect(() => {
    setQuery("");
    setSelected(0);
  }, [groupId]);

  // The full membership, subtree and all, in sidebar drawing order —
  // dormant members included, since reaching those without expanding the
  // folder is half the point of the panel. Computed before the placement
  // effect below, whose clamp depends on how many rows are showing.
  const members =
    groupId !== null ? subtreeTabs(tabs, groups, groupId) : [];
  const shown = members.filter((t) => matches(t, query));
  const sel = Math.min(selected, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    if (groupId === null) {
      setTop(null);
      return;
    }
    const head = document.querySelector(
      `.group-head[data-group-id="${groupId}"]`
    );
    const aside = document.querySelector(".sidebar");
    const panel = panelRef.current;
    if (!head || !aside || !panel) {
      setTop(null);
      return;
    }
    const asideRect = aside.getBoundingClientRect();
    const wanted = head.getBoundingClientRect().top - asideRect.top;
    // The sidebar spans the window's height, so clamping inside it is
    // clamping inside the window — in the coordinates the panel is
    // positioned in.
    const most = asideRect.height - panel.offsetHeight - 8;
    setTop(Math.round(Math.max(8, Math.min(wanted, most))));
  }, [groupId, shown.length]);

  // Focus once placed, not via autoFocus: the panel mounts invisible (see
  // above), and a hidden element refuses focus — an autoFocus that fired
  // there would leave the search box dead to the keyboard.
  const placed = top !== null;
  useEffect(() => {
    if (placed) inputRef.current?.focus();
  }, [groupId, placed]);

  // Esc closes, wherever the keyboard focus sits. Capture phase for the
  // same reason every sidebar surface uses it: the window-drag script
  // swallows bubble-phase events on parts of the sidebar.
  useEffect(() => {
    if (groupId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelPreviewClose();
        setFolderPreview(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [groupId, setFolderPreview]);

  if (groupId === null || !group) return null;

  const pick = (id: string) => {
    cancelPreviewClose();
    setFolderPreview(null);
    useStore.getState().activateTab(id);
  };

  return (
    <div
      ref={panelRef}
      className="folder-preview"
      style={{
        top: top ?? 0,
        width: FOLDER_PREVIEW_WIDTH,
        left: "100%",
        visibility: placed ? undefined : "hidden",
      }}
      onMouseEnter={cancelPreviewClose}
      onMouseLeave={() => schedulePreviewClose()}
    >
      <input
        ref={inputRef}
        className="preview-search"
        value={query}
        spellCheck={false}
        placeholder={`Search ${group.name}…`}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected(Math.min(sel + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected(Math.max(sel - 1, 0));
          } else if (e.key === "Enter") {
            if (shown[sel]) pick(shown[sel].id);
          }
          // Escape is handled by the window listener above; everything
          // else must not fall through to the app's shortcut layer.
          e.stopPropagation();
        }}
      />
      <div className="preview-list">
        {shown.map((t, i) => (
          <PreviewRow
            key={t.id}
            tab={t}
            selected={i === sel}
            onPick={() => pick(t.id)}
            onHover={() => setSelected(i)}
          />
        ))}
        {shown.length === 0 && (
          <div className="preview-empty">
            {members.length === 0 ? "Empty folder" : "No matches"}
          </div>
        )}
      </div>
    </div>
  );
}
