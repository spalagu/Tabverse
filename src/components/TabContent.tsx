import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  WorkbenchTabHost,
  defineTabViewRenderers,
} from "@tabverse/workbench/tab-view";
import {
  nextSplitCandidate,
  SPLIT_MAX_PANES,
  useStore,
  type Tab,
} from "../state/store";
import { layout, splitRects, type PaneRect } from "../paneTree";
import { BrowserView } from "./BrowserView";
import { FilesView } from "./files/FilesView";
import { AgentView } from "./AgentView";
import { SettingsView } from "./SettingsView";
import { RemoteView } from "./RemoteView";
import { TerminalView } from "./TerminalView";
import {
  CloseIcon,
  MoreIcon,
  PeekCloseIcon,
  PeekPromoteIcon,
  PeekSplitIcon,
} from "./icons";
import { STR } from "../strings";
import { formatKeys, HINT_KEYS } from "../strings/formatKeys";
import { keysFor } from "../shortcuts";
import { fsApi, type FileMeta } from "../backend/fs";
import { describeError, type ErrorDescription } from "../strings/errors";
import { LoadingState } from "./state/LoadingState";
import { ErrorState } from "./state/ErrorState";
import { Preview } from "./files/Preview";

interface DesktopTabViewContext {
  readonly pageCoverable: boolean;
  readonly pageProxyDown: boolean;
}

const DESKTOP_TAB_RENDERERS = defineTabViewRenderers<
  Tab,
  DesktopTabViewContext
>({
  terminal: ({ tab, active }) => <TerminalPanes tab={tab} active={active} />,
  files: ({ tab, active }) =>
    // A files tab that is a peek shows the preview matrix alone, not a
    // workspace: no tree, panes or terminal panel come with it.
    tab.peek === true ? <FilePeek tab={tab} /> : <FilesView tab={tab} active={active} />,
  browser: ({ tab, active }) => <BrowserView tab={tab} active={active} />,
  agent: ({ tab, active }) => <AgentView tab={tab} active={active} />,
  remote: ({ tab, active }) => <RemoteView tab={tab} active={active} />,
  settings: ({ context }) => (
    <SettingsView
      isCoverable={context.pageCoverable}
      pageProxyDown={context.pageProxyDown}
    />
  ),
});

export function FilePeek({ tab }: { tab: Tab }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setError(null);
    const path = tab.openPath;
    if (path === undefined) return;
    fsApi.read(path).then(
      (m) => {
        if (!cancelled) setMeta(m);
      },
      (e) => {
        if (!cancelled) setError(describeError(e, STR.errors.actions.readFile));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [tab.openPath]);

  if (error !== null) {
    return (
      <div className="file-peek">
        <div className="file-peek-center">
          <ErrorState inline error={error} />
        </div>
      </div>
    );
  }
  if (meta === null) {
    return (
      <div className="file-peek">
        <div className="file-peek-center">
          <LoadingState label={STR.files.viewers.loading({ name: peekFileName(tab) })} />
        </div>
      </div>
    );
  }
  return (
    <div className="file-peek">
      <Preview meta={meta} />
    </div>
  );
}

/** The name the peek's loading line says — the file's own name, or the
 * path's last word when it names none. */
function peekFileName(tab: Tab): string {
  const path = tab.openPath ?? "";
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The running share before pane `i` — where its leading edge sits (0–1). */
function cumBefore(ratios: number[], i: number): number {
  return ratios.slice(0, i).reduce((a, b) => a + b, 0);
}

/** How much of a split pane is kept for this document: the focus ring's band. */
const RING = 2;

function paneLayout(
  ratios: number[],
  i: number,
  vertical: boolean
): { cell: CSSProperties; page: CSSProperties } {
  const n = ratios.length;
  const before = cumBefore(ratios, i);
  const size = ratios[i];
  const padStart = i > 0 ? 3 : 0;
  const padEnd = i < n - 1 ? 3 : 0;
  if (vertical) {
    return {
      cell: {
        left: 0,
        right: 0,
        top: `calc(${before * 100}% + ${padStart}px)`,
        bottom: "auto",
        height: `calc(${size * 100}% - ${padStart + padEnd}px)`,
      },
      page: {
        left: RING,
        right: RING,
        top: `calc(${before * 100}% + ${padStart + RING}px)`,
        bottom: "auto",
        height: `calc(${size * 100}% - ${padStart + padEnd + RING * 2}px)`,
      },
    };
  }
  return {
    cell: {
      top: 0,
      bottom: 0,
      left: `calc(${before * 100}% + ${padStart}px)`,
      right: "auto",
      width: `calc(${size * 100}% - ${padStart + padEnd}px)`,
    },
    page: {
      top: RING,
      bottom: RING,
      left: `calc(${before * 100}% + ${padStart + RING}px)`,
      right: "auto",
      width: `calc(${size * 100}% - ${padStart + padEnd + RING * 2}px)`,
    },
  };
}

function SplitDivider({
  vertical,
  style,
  onMove,
  onDrop,
  onDragging,
}: {
  vertical: boolean;
  style: CSSProperties;
  onMove: (position: number) => void;
  onDrop: (position: number) => void;
  onDragging?: (on: boolean) => void;
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const strip = e.currentTarget;
    const surface = strip.parentElement;
    if (!surface) return;
    strip.setPointerCapture(e.pointerId);
    onDragging?.(true);
    let raf = 0;
    let pending: number | null = null;
    const posAt = (ev: PointerEvent) => {
      const r = surface.getBoundingClientRect();
      return vertical
        ? (ev.clientY - r.top) / Math.max(1, r.height)
        : (ev.clientX - r.left) / Math.max(1, r.width);
    };
    const move = (ev: PointerEvent) => {
      pending = posAt(ev);
      if (raf === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending !== null) onMove(pending);
        });
      }
    };
    const finish = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cancelAnimationFrame(raf);
      onDrop(posAt(ev));
      onDragging?.(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return (
    <div
      className={`split-divider${vertical ? " vertical" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      title={STR.common.dragResizeSplit}
    />
  );
}

/** Where the outer split's strip sits: across the whole content area. */
function outerDividerStyle(position: number, vertical: boolean): CSSProperties {
  return vertical
    ? { top: `calc(${position * 100}% - 3px)` }
    : { left: `calc(${position * 100}% - 3px)` };
}

/** How much of an edge a pane gives back to a seam, in px (3 + 3 = the 6). */
const SEAM = 3;

/** Distances below this are the rounding of dividing by a sum, not a gap. */
const EDGE_EPS = 1e-6;

/**
 * One pane's box inside the tab's content area.
 *
 * The inset is per EDGE and not per pane, because in a tree a pane can be
 * against the window on one side and against a seam on the other — the outer
 * layer's row-of-panes version could decide it from the index alone.
 */
function paneRectStyle(rect: PaneRect): CSSProperties {
  const padL = rect.x > EDGE_EPS ? SEAM : 0;
  const padT = rect.y > EDGE_EPS ? SEAM : 0;
  const padR = rect.x + rect.w < 1 - EDGE_EPS ? SEAM : 0;
  const padB = rect.y + rect.h < 1 - EDGE_EPS ? SEAM : 0;
  return {
    position: "absolute",
    left: `calc(${rect.x * 100}% + ${padL}px)`,
    top: `calc(${rect.y * 100}% + ${padT}px)`,
    width: `calc(${rect.w * 100}% - ${padL + padR}px)`,
    height: `calc(${rect.h * 100}% - ${padT + padB}px)`,
  };
}

function TerminalPanes({ tab, active }: { tab: Tab; active: boolean }) {
  const rects: PaneRect[] = tab.panes
    ? layout(tab.panes)
    : [{ id: tab.id, x: 0, y: 0, w: 1, h: 1 }];
  const multi = rects.length > 1;
  const zoomed =
    tab.zoomedPaneId !== undefined &&
    rects.some((r) => r.id === tab.zoomedPaneId)
      ? tab.zoomedPaneId
      : null;
  const focusId = tab.activePaneId ?? rects[0]?.id;
  const seams = tab.panes && zoomed === null ? splitRects(tab.panes) : [];
  const setPaneRatio = useStore((s) => s.setPaneRatio);
  return (
    <div className="term-panes" style={{ position: "absolute", inset: 0 }}>
      {rects.map((r) => {
        const shown = zoomed === null || zoomed === r.id;
        const box = zoomed === r.id ? { ...r, x: 0, y: 0, w: 1, h: 1 } : r;
        return (
          <div
            key={r.id}
            className={`term-pane-slot${shown ? "" : " pane-hidden"}`}
            style={paneRectStyle(box)}
            data-pane-id={r.id}
          >
            <TerminalView
              tab={tab}
              active={active}
              paneId={tab.panes ? r.id : undefined}
            />
          </div>
        );
      })}
      {/* The focus ring only means something with more than one pane: on a
          single terminal it would be a box drawn around the whole tab. */}
      {multi && focusId !== undefined && (
        <div
          className="split-focus-ring"
          style={paneRectStyle(
            zoomed !== null
              ? { id: focusId, x: 0, y: 0, w: 1, h: 1 }
              : (rects.find((r) => r.id === focusId) ?? rects[0])
          )}
          aria-hidden
        />
      )}
      {seams.flatMap(({ node, rect }) =>
        node.children.slice(0, -1).map((_, i) => {
          const share = node.ratios
            .slice(0, i + 1)
            .reduce((a, b) => a + b, 0) / node.ratios.reduce((a, b) => a + b, 0);
          const at = node.vertical
            ? rect.y + share * rect.h
            : rect.x + share * rect.w;
          const style: CSSProperties = node.vertical
            ? {
                top: `calc(${at * 100}% - ${SEAM}px)`,
                left: `${rect.x * 100}%`,
                right: "auto",
                width: `${rect.w * 100}%`,
              }
            : {
                left: `calc(${at * 100}% - ${SEAM}px)`,
                top: `${rect.y * 100}%`,
                bottom: "auto",
                height: `${rect.h * 100}%`,
              };
          // The strip reports a fraction of the whole surface; this split
          // owns only its own rectangle, so the fraction is mapped into it.
          const within = (p: number) =>
            node.vertical
              ? (p - rect.y) / Math.max(rect.h, EDGE_EPS)
              : (p - rect.x) / Math.max(rect.w, EDGE_EPS);
          return (
            <SplitDivider
              key={`${node.id}-${i}`}
              vertical={node.vertical}
              style={style}
              onMove={(p) => setPaneRatio(tab.id, node.id, i, within(p))}
              onDrop={(p) => setPaneRatio(tab.id, node.id, i, within(p), true)}
            />
          );
        })
      )}
    </div>
  );
}

function PaneActions({
  tab,
  index,
  count,
  vertical,
  focused,
  style,
}: {
  tab: Tab;
  index: number;
  count: number;
  vertical: boolean;
  focused: boolean;
  style: CSSProperties;
}) {
  const closeTab = useStore((s) => s.closeTab);
  const moveSplitPane = useStore((s) => s.moveSplitPane);
  const separateFromSplit = useStore((s) => s.separateFromSplit);
  const addSplitPane = useStore((s) => s.addSplitPane);
  const toggleSplitOrientation = useStore((s) => s.toggleSplitOrientation);
  const canAdd = useStore(
    (s) => count < SPLIT_MAX_PANES && nextSplitCandidate(s) !== null
  );
  const setPaneHover = useStore((s) => s.setPaneHover);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  const closePane = () => {
    if (focused) closeTab(tab.id);
    else separateFromSplit(tab.id);
  };

  const back = vertical ? STR.common.splitMenu.moveUp : STR.common.splitMenu.moveLeft;
  const fwd = vertical ? STR.common.splitMenu.moveDown : STR.common.splitMenu.moveRight;
  const isFirst = index === 0;
  const isLast = index === count - 1;

  return (
    <div
      className="pane-actions"
      style={style}
      // The pointer leaving these controls is what puts them away — and this
      // document does hear it, because while they are up its layer is above
      // the page. A generous box around the buttons gives the hand somewhere
      // to travel without the target vanishing under it.
      onMouseLeave={() => {
        if (!menuOpen) setPaneHover(null);
      }}
    >
      <div className="pane-actions-row">
        <button
          className="pane-btn"
          title={STR.common.splitOptions}
          aria-label={STR.common.splitOptions}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <MoreIcon size={14} />
        </button>
        <button
          className="pane-btn"
          title={
            focused
              ? STR.common.closeTabHint({
                  keys: formatKeys(keysFor("close-tab")),
                })
              : STR.common.removePaneHint
          }
          aria-label={STR.common.closePane}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            closePane();
          }}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {menuOpen && (
        <div
          className="split-menu"
          ref={menuRef}
        >
          <button
            className="ctx-item"
            disabled={isFirst}
            onClick={() => {
              moveSplitPane(tab.id, -1);
              setMenuOpen(false);
            }}
          >
            {back}
          </button>
          <button
            className="ctx-item"
            disabled={isLast}
            onClick={() => {
              moveSplitPane(tab.id, 1);
              setMenuOpen(false);
            }}
          >
            {fwd}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              separateFromSplit(tab.id);
              setMenuOpen(false);
            }}
          >
            {STR.common.splitMenu.separate}
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            disabled={!canAdd}
            title={canAdd ? undefined : STR.common.splitAddDisabledHint}
            onClick={() => {
              addSplitPane("left");
              setMenuOpen(false);
            }}
          >
            {vertical ? STR.common.splitMenu.addAbove : STR.common.splitMenu.addLeft}
          </button>
          <button
            className="ctx-item"
            disabled={!canAdd}
            title={canAdd ? undefined : STR.common.splitAddDisabledHint}
            onClick={() => {
              addSplitPane("right");
              setMenuOpen(false);
            }}
          >
            {vertical ? STR.common.splitMenu.addBelow : STR.common.splitMenu.addRight}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              toggleSplitOrientation();
              setMenuOpen(false);
            }}
          >
            {vertical
              ? STR.common.splitMenu.toHorizontal
              : STR.common.splitMenu.toVertical}
          </button>
        </div>
      )}
    </div>
  );
}

function PeekActions({ tab }: { tab: Tab }) {
  const promotePeek = useStore((s) => s.promotePeek);
  const discardPeek = useStore((s) => s.discardPeek);
  const splitPeek = useStore((s) => s.splitPeek);
  return (
    <div className="peek-actions">
      <button
        className="peek-btn"
        onClick={() => discardPeek()}
        aria-label={STR.common.peekClose}
        title={STR.common.closeHint({ keys: formatKeys(HINT_KEYS.escape) })}
      >
        <PeekCloseIcon />
      </button>
      <button
        className="peek-btn"
        onClick={() => promotePeek()}
        aria-label={STR.common.peekOpenAsTab}
        title={STR.common.peekOpenAsTab}
      >
        <PeekPromoteIcon />
      </button>
      <button
        className="peek-btn"
        onClick={() => splitPeek()}
        aria-label={STR.common.peekSplitAria}
        title={STR.common.peekSplitHint({ title: tab.title })}
      >
        <PeekSplitIcon />
      </button>
    </div>
  );
}

function SplitDropZone({
  drag,
}: {
  drag: { id: string; side: "left" | "right" | null; index?: number | null };
}) {
  const setContentDrag = useStore((s) => s.setContentDrag);
  const splitDropAt = useStore((s) => s.splitDropAt);
  const split = useStore((s) => s.split);
  const activeTabId = useStore((s) => s.activeTabId);
  const tabs = useStore((s) => s.tabs);
  const ref = useRef<HTMLDivElement>(null);
  const visible =
    split !== null && activeTabId !== null && split.ids.includes(activeTabId);
  const panes = visible && split !== null ? split.ids.length : 1;
  const vertical = visible && split !== null ? split.vertical : false;
  const slots = panes + 1;
  const target = tabs.find((t) => t.id === activeTabId);
  const slotAt = (e: { clientX: number; clientY: number }): number => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return 0;
    const along = vertical
      ? (e.clientY - r.top) / Math.max(1, r.height)
      : (e.clientX - r.left) / Math.max(1, r.width);
    // Nearest boundary: 0 … panes.
    return Math.max(0, Math.min(panes, Math.round(along * panes)));
  };
  return (
    <div
      className={`split-dropzone${vertical ? " vertical" : ""}`}
      ref={ref}
      onDragOver={(e) => {
        // A browser-tab drag is the only thing that arms this layer, so any
        // dragover here is one — accept the drop and light the target.
        e.preventDefault();
        const index = slotAt(e);
        if (index !== drag.index) {
          setContentDrag({
            id: drag.id,
            side: index === 0 ? "left" : "right",
            index,
          });
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        splitDropAt(drag.id, slotAt(e));
      }}
    >
      {Array.from({ length: slots }, (_, i) => (
        <div
          key={i}
          className={`split-drop-slot${drag.index === i ? " on" : ""}`}
          style={
            vertical
              ? { top: `${(i / panes) * 100}%`, height: `${100 / panes / 1.6}%` }
              : { left: `${(i / panes) * 100}%`, width: `${100 / panes / 1.6}%` }
          }
        >
          {drag.index === i && (
            <span className="split-drop-label">
              {visible
                ? "Insert here"
                : `Split with ${target?.title ?? "this tab"}`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function TabContent() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const split = useStore((s) => s.split);
  const peekTabId = useStore((s) => s.peekTabId);
  const contentDrag = useStore((s) => s.contentDrag);
  const paneHoverTabId = useStore((s) => s.paneHoverTabId);
  const activateTab = useStore((s) => s.activateTab);
  const discardPeek = useStore((s) => s.discardPeek);

  const [pageCoverable, setPageCoverable] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<boolean>("page_coverable").then(setPageCoverable).catch(() => {})
    );
  }, []);

  const [pageProxyDown, setPageProxyDown] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ status: string }>("page-proxy-down", () => setPageProxyDown(true)).then(
        (fn) => {
          unlisten = fn;
        }
      );
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const setContentDrag = useStore((s) => s.setContentDrag);
  useEffect(() => {
    const clear = () => setContentDrag(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [setContentDrag]);

  const live = tabs.filter((t) => t.dormant !== true);
  const splitVisible =
    split !== null && activeTabId !== null && split.ids.includes(activeTabId);
  const paneIndex = (id: string) => (split ? split.ids.indexOf(id) : -1);

  // Which pane's controls are showing, decided from where the pointer IS
  // (2026-08-12 feedback 4). The page's corner report can only ever say
  // "someone arrived HERE": it fires once, the layer then rises, and from
  // that moment the page sees no pointer at all — so nothing was left to say
  // the pointer had moved on, and the buttons stayed up, sometimes over a
  // pane the pointer had already left. While the layer is up this document
  // hears every move, so it answers the question itself and the page's report
  // is demoted to what it can honestly be: the way in.
  useEffect(() => {
    if (!splitVisible) return;
    const onMove = (e: MouseEvent) => {
      let hit: string | null = null;
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(".pane.split-pane[data-pane-tab-id]")
      )) {
        const r = el.getBoundingClientRect();
        if (
          e.clientX >= r.right - 170 &&
          e.clientX <= r.right + 4 &&
          e.clientY >= r.top - 4 &&
          e.clientY <= r.top + 60
        ) {
          hit = el.dataset.paneTabId ?? null;
          break;
        }
      }
      const st = useStore.getState();
      if (hit === st.paneHoverTabId) return;
      // An open options menu keeps its pane's controls alive: the menu hangs
      // below the corner, so walking down into it leaves the zone.
      if (hit === null && document.querySelector(".split-menu")) return;
      st.setPaneHover(hit);
    };
    window.addEventListener("mousemove", onMove, true);
    return () => window.removeEventListener("mousemove", onMove, true);
  }, [splitVisible]);

  const placeless = live.filter((t) => t.peek !== true).length === 0;
  return (
    <main className="content">
      <div className="panes">
        {placeless && (
          <div className="placeholder">
            <div className="placeholder-title">
              {tabs.length === 0
                ? STR.common.noTabsTitle
                : STR.common.allAsleepTitle}
            </div>
            <div className="placeholder-blurb">
              {tabs.length === 0
                ? STR.common.noTabsHint({
                    keys: formatKeys(keysFor("new-terminal")),
                  })
                : STR.common.allAsleepHint({
                    keys: formatKeys(keysFor("new-terminal")),
                  })}
            </div>
          </div>
        )}
        {peekTabId !== null && (
          <div className="peek-scrim" onMouseDown={() => discardPeek()} />
        )}
        {live.map((t) => {
          const isPeek = t.id === peekTabId;
          const idx = splitVisible ? paneIndex(t.id) : -1;
          const inSplit = idx >= 0;
          const shown = t.id === activeTabId || inSplit || isPeek;
          // The PAGE rectangle: the cell minus the focus ring's band. The cell
          // itself is used below, for the ring and the pane's controls — one
          // calculation, two rectangles (paneLayout).
          const style =
            inSplit && split !== null
              ? paneLayout(split.ratios, idx, split.vertical).page
              : undefined;
          const paneFocused = inSplit && t.id === activeTabId;
          return (
            <div
              key={t.id}
              className={[
                "pane",
                t.type === "browser" ? "pane-browser" : "",
                shown ? "" : "pane-hidden",
                inSplit ? "split-pane" : "",
                paneFocused ? "focus" : "",
                isPeek ? "peek-pane" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={style}
              data-pane-tab-id={t.id}
              onMouseDownCapture={
                inSplit && t.id !== activeTabId
                  ? (e: ReactMouseEvent) => {
                      if (
                        (e.target as HTMLElement).closest(
                          ".pane-actions"
                        )
                      ) {
                        return;
                      }
                      activateTab(t.id);
                    }
                  : undefined
              }
            >
              {isPeek ? <PeekActions tab={t} /> : null}
              <WorkbenchTabHost
                tab={t}
                active={t.id === activeTabId}
                context={{ pageCoverable, pageProxyDown }}
                renderers={DESKTOP_TAB_RENDERERS}
              />
            </div>
          );
        })}
        {splitVisible &&
          split !== null &&
          split.ids.map((sid, i) => {
            const t = live.find((x) => x.id === sid);
            if (!t) return null;
            const { cell } = paneLayout(split.ratios, i, split.vertical);
            const focused = sid === activeTabId;
            return (
              <Fragment key={`chrome-${sid}`}>
                {focused && (
                  <div className="split-focus-ring" style={cell} aria-hidden />
                )}
                {paneHoverTabId === sid && (
                  <PaneActions
                    tab={t}
                    index={i}
                    count={split.ids.length}
                    vertical={split.vertical}
                    focused={focused}
                    style={cell}
                  />
                )}
              </Fragment>
            );
          })}
        {splitVisible &&
          split !== null &&
          split.ids.slice(0, -1).map((_, i) => (
            <SplitDivider
              key={`divider-${i}`}
              vertical={split.vertical}
              style={outerDividerStyle(
                cumBefore(split.ratios, i + 1),
                split.vertical
              )}
              onMove={(p) => useStore.getState().setSplitRatio(i, p)}
              onDrop={(p) => useStore.getState().setSplitRatio(i, p, true)}
              onDragging={(on) => useStore.getState().setSplitDragging(on)}
            />
          ))}
        {contentDrag !== null && <SplitDropZone drag={contentDrag} />}
      </div>
    </main>
  );
}
