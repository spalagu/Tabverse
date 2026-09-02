import {
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  resolveTabStateEnvelope,
  type TabInstanceScope,
} from "@tabverse/tab-contracts";
import {
  nextSplitCandidate,
  SPLIT_MAX_PANES,
  useStore,
  type Tab,
} from "../state/store";
import {
  DesktopTabHostFactsProvider,
  installDesktopTabViews,
} from "../desktopTabViews";
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
import { LoadingState } from "./state/LoadingState";
import { desktopPluginComposition } from "../pluginComposition";
import { prepareResidentRuntime, stopResidentTab } from "../residentRuntime";

installDesktopTabViews();

function PluginProvidedTabView({
  tab,
  active,
  pageCoverable,
  pageProxyDown,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly pageCoverable: boolean;
  readonly pageProxyDown: boolean;
}) {
  const [instance, setInstance] = useState<TabInstanceScope | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [residentPolicyRevision, setResidentPolicyRevision] = useState(0);
  const [residentRuntimeId, setResidentRuntimeId] = useState<string | null | undefined>(
    undefined,
  );

  useEffect(() => {
    const changed = () => setCatalogRevision((revision) => revision + 1);
    window.addEventListener("tabverse-plugin-catalog-changed", changed);
    return () => window.removeEventListener("tabverse-plugin-catalog-changed", changed);
  }, []);

  useEffect(() => {
    const changed = () => setResidentPolicyRevision((revision) => revision + 1);
    window.addEventListener("tabverse-resident-policy-changed", changed);
    return () => window.removeEventListener("tabverse-resident-policy-changed", changed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let created: TabInstanceScope | null = null;
    setInstance(null);
    setFailure(null);
    setResidentRuntimeId(undefined);
    void desktopPluginComposition().createInstance(tab.type, tab.id).then(async (scope) => {
      created = scope;
      if (cancelled) {
        await scope.dispose();
        return;
      }
      const resident = await prepareResidentRuntime(tab, scope.contribution.resident);
      if (cancelled) return;
      setResidentRuntimeId(resident?.runtimeId ?? null);
      setInstance(scope);
    }).catch((error: unknown) => {
      if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      if (created !== null) void created.dispose();
      if (!useStore.getState().tabs.some((candidate) => candidate.id === tab.id)) {
        void stopResidentTab(tab.id);
      }
    };
  }, [catalogRevision, residentPolicyRevision, tab.id, tab.residentPolicy, tab.type]);

  if (failure !== null) {
    return (
      <div className="state-error" data-missing-plugin-kind={tab.type}>
        Plugin “{tab.type}” is unavailable. Saved Tab state has been retained. {failure}
      </div>
    );
  }
  if (instance === null || residentRuntimeId === undefined) {
    return <LoadingState label={`Loading ${tab.type} plugin…`} />;
  }
  let state: unknown = tab;
  if (tab.pluginState !== undefined) {
    const resolution = resolveTabStateEnvelope(tab.pluginState, instance.contribution);
    if (resolution.status === "placeholder") {
      return (
        <div className="state-error" data-missing-plugin-kind={tab.type}>
          Plugin “{tab.type}” cannot read this saved state. {resolution.reason}: {resolution.detail}
        </div>
      );
    }
    state = resolution.state;
  }
  const output = instance.contribution.view.render({
    tabId: tab.id,
    state,
    active,
    services: instance,
  });
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    !isValidElement(output)
  ) {
    return <div className="state-error">{tab.type} plugin returned an unsupported view descriptor.</div>;
  }
  return (
    <DesktopTabHostFactsProvider
      value={{
        pageCoverable,
        pageProxyDown,
        residentRuntimeId: residentRuntimeId ?? undefined,
      }}
    >
      {output as ReactNode}
    </DesktopTabHostFactsProvider>
  );
}

export { FilePeek } from "./files/FilePeek";

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
              <PluginProvidedTabView
                tab={t}
                active={t.id === activeTabId}
                pageCoverable={pageCoverable}
                pageProxyDown={pageProxyDown}
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
