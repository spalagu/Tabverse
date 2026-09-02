import { b64decode, b64encode } from "../../backend/b64";
import type { TermApi } from "../../termRegistry";

/** Everything the bridge touches, injectable so the tests drive it with
 * plain objects instead of a Tauri runtime and a real store. */
export interface AppTermBridgeDeps {
  /** Store subscription the way zustand calls it: (state, prev). The
   * structural BridgeTabs read — AppStore satisfies it, and the tests
   * hand in plain rows. */
  subscribe(fn: (s: BridgeTabs, prev: BridgeTabs) => void): () => void;
  /** The term registry read: the mounted terminal of a tab, if any. */
  getTerm(tabId: string): TermApi | undefined;
  /** Report the watchable active tab (null = none) to Rust. */
  setActiveTab(tabId: string | null): void;
  /** Ship one serialized screen to every viewer. */
  sendSnapshot(b64: string, cols: number, rows: number): void;
  /** Subscribe to viewer keystrokes; returns the unsubscribe fn. */
  onTermInput(cb: (dataB64: string) => void): () => void;
  /** The viewers' joint viewport arrived (null: nobody constrains). */
  onViewport(cb: (vp: { cols: number; rows: number } | null) => void): () => void;
}

/** A pending settle re-check; DOM timer ids. */
type SettleTimer = number;

/** How long after an activation the bridge keeps re-checking for the
 * terminal to mount. TerminalView registers on mount; an activation that
 * outran the mount (a tab created this instant, a restored session still
 * hydrating) would otherwise report "no terminal" and stay silent until
 * the NEXT activation — the first keystrokes of a new tab are exactly the
 * bytes a viewer should not miss. */
const MOUNT_SETTLE_ATTEMPTS = [0, 200, 1000] as const;

/** The minimal store read the bridge needs. Kept structural so the tests
 * can hand in plain rows. */
export interface BridgeTabs {
  tabs: { id: string; type: string }[];
  activeTabId: string | null;
}

/** The watchable terminal behind `activeTabId`, or null: no active tab, a
 * non-terminal tab fronts, or the terminal has not mounted yet. */
function watchableTerm(
  s: Pick<BridgeTabs, "tabs" | "activeTabId">,
  getTerm: (tabId: string) => TermApi | undefined
): { tabId: string; term: TermApi } | null {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab || tab.type !== "terminal") return null;
  const term = getTerm(tab.id);
  return term ? { tabId: tab.id, term } : null;
}

/** Install the bridge; returns the uninstall (store sub + event sub +
 * pending timers). Idempotent per returned handle — the caller installs
 * once at boot, desktop only. */
export function installAppTermBridge(deps: AppTermBridgeDeps): () => void {
  // The tab the last successful report named — the one viewer keystrokes
  // are written into. Kept here rather than re-derived on every event so
  // an input racing an activation lands where the host last said it
  // would, never in a terminal the viewers cannot see.
  let liveTabId: string | null = null;
  const stopInput = deps.onTermInput((dataB64) => {
    if (liveTabId === null) return;
    const term = deps.getTerm(liveTabId);
    if (!term) return;
    term.write(new TextDecoder().decode(b64decode(dataB64)));
  });

  // The audience's grid (smallest viewer viewport, tmux semantics — the
  // hub computes it, Rust emits it, this is where it lands). The cap
  // rides WITH the activation: the terminal that fronts gets capped, the
  // one that stops fronting is released back to the host pane's size.
  let viewerCap: { cols: number; rows: number } | null = null;
  const stopViewport = deps.onViewport((vp) => {
    viewerCap = vp;
    if (liveTabId === null) return;
    const term = deps.getTerm(liveTabId);
    if (!term) return;
    term.setViewerCap(vp);
    // The reflow changed every line, not just the tail: a fresh snapshot
    // resets viewers onto the new grid instead of letting their local
    // rewrap drift from the host's.
    const { cols, rows } = term.size();
    deps.sendSnapshot(b64encode(term.serialize()), cols, rows);
  });

  const report = (s: Pick<BridgeTabs, "tabs" | "activeTabId">) => {
    const w = watchableTerm(s, deps.getTerm);
    if (liveTabId !== null && liveTabId !== w?.tabId) {
      deps.getTerm(liveTabId)?.setViewerCap(null);
    }
    liveTabId = w?.tabId ?? null;
    // Report the raw active tab id, terminal or not. The terminal tap simply
    // finds no terminal session under a non-terminal id.
    deps.setActiveTab(s.activeTabId);
    if (!w) return;
    // Cap before serializing: the snapshot must carry the capped grid, or
    // a viewer's first frame disagrees with the cap that follows it.
    if (viewerCap) w.term.setViewerCap(viewerCap);
    const { cols, rows } = w.term.size();
    deps.sendSnapshot(b64encode(w.term.serialize()), cols, rows);
  };


  const timers: SettleTimer[] = [];
  const unsubscribe = deps.subscribe((s, prev) => {
    if (s.activeTabId === prev.activeTabId) return;
    // A fresh activation: report now, then re-check while the terminal
    // settles — the mount may trail the activation by a render.
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    report(s);
    // Whether this activation's report already named a terminal: a live
    // report re-sending a snapshot later would blank every viewer's
    // scrollback for nothing, so the settle re-checks below are for the
    // null report only.
    const reportedLive = liveTabId !== null;
    let settled = reportedLive;
    for (const delay of MOUNT_SETTLE_ATTEMPTS) {
      timers.push(
        window.setTimeout(() => {
          // The activation's terminal was missing at report time; if the
          // mount has landed since, say so now — these are the bytes a
          // viewer would otherwise never see. One successful re-report
          // settles the activation: later attempts stand down rather
          // than re-sending the same screen.
          if (settled) return;
          if (watchableTerm(s, deps.getTerm)) {
            settled = true;
            report(s);
          }
        }, delay)
      );
    }
  });

  return () => {
    unsubscribe();
    stopInput();
    stopViewport();
    // The share is over: the last fronting terminal must not keep the
    // audience's grid after its audience is gone.
    if (liveTabId !== null) deps.getTerm(liveTabId)?.setViewerCap(null);
    for (const t of timers) window.clearTimeout(t);
  };
}

/** The desktop wiring: the real store, the real term registry, the real
 * invoke/event seams. The join page never runs this — its mirror store
 * has no terminals and its runtime has no Tauri. */
export function bootAppTermBridge(): void {
  void import("@tauri-apps/api/core").then(({ invoke }) => {
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void import("../../state/store").then(({ useStore }) => {
        void import("../../termRegistry").then(({ getTerm }) => {
          installAppTermBridge({
            subscribe: (fn) => useStore.subscribe(fn),
            getTerm,
            setActiveTab: (tabId) => {
              void invoke("app_share_set_active_tab", { tabId }).catch(
                () => {}
              );
            },
            sendSnapshot: (b64, cols, rows) => {
              void invoke("app_share_term_snapshot", {
                b64Data: b64,
                cols,
                rows,
              }).catch(() => {});
            },
            onTermInput: (cb) => {
              let unlisten: (() => void) | null = null;
              let cancelled = false;
              void listen<{ data: string }>("app-share-term-input", (e) =>
                cb(e.payload.data)
              ).then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
              });
              return () => {
                cancelled = true;
                unlisten?.();
              };
            },

            onViewport: (cb) => {
              let unlisten: (() => void) | null = null;
              let cancelled = false;
              void listen<{ cols: number | null; rows: number | null }>(
                "app-share-term-viewport",
                (e) =>
                  cb(
                    e.payload.cols && e.payload.rows
                      ? { cols: e.payload.cols, rows: e.payload.rows }
                      : null
                  )
              ).then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
              });
              return () => {
                cancelled = true;
                unlisten?.();
              };
            },
          });
          // Desktop-only boot: nothing uninstalls it. Stated rather than
          // hidden — the bridge outlives React because the store does.
        });
      });
    });
  });
}
