/**
 * The app-share terminal channel's host bridge, driven with fakes: what it
 * reports to Rust on each activation, the mount-settle re-check that
 * recovers an activation that outran the terminal's mount, and where
 * viewer keystrokes land. These are the observable halves of the contract
 * — the Rust side (output tap, snapshot broadcast) is pinned in the
 * crates' tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64encode } from "../../backend/b64";
import type { TermApi } from "../../termRegistry";
import {
  installAppTermBridge,
  type AppTermBridgeDeps,
} from "./appTermBridge";

/** A recording stand-in for one mounted terminal. */
function fakeTerm(screen = "prompt $"): {
  api: TermApi;
  writes: string[];
  screen: string;
  caps: ({ cols: number; rows: number } | null)[];
} {
  const writes: string[] = [];
  const state = { screen };
  const caps: ({ cols: number; rows: number } | null)[] = [];
  const api: TermApi = {
    size: () => ({ cols: 100, rows: 30 }),
    serialize: () => state.screen,
    focus: () => {},
    runCommand: () => {},
    write: (data) => writes.push(data),
    detach: () => Promise.resolve(),
    openSearch: () => {},
    setViewerCap: (vp) => caps.push(vp),
    cwd: () => null,
  };
  return { api, writes, screen: state.screen, caps };
}

interface Harness {
  /** Drive one store transition through the bridge's subscription. */
  activate(activeTabId: string | null): void;
  /** The input seam's inward callback, captured from the deps. */
  viewerInput(data: string): void;
  /** The viewport seam's inward callback: the joint viewport arrived. */
  viewport(vp: { cols: number; rows: number } | null): void;
  deps: {
    activeReports: (string | null)[];
    snapshots: { b64: string; cols: number; rows: number }[];
  };
  registry: Map<string, TermApi>;
  stop(): void;
}

function mount(tabs: { id: string; type: string }[]): Harness {
  const registry = new Map<string, TermApi>();
  const activeReports: (string | null)[] = [];
  const snapshots: { b64: string; cols: number; rows: number }[] = [];
  let subscriber:
    | ((
        s: { tabs: typeof tabs; activeTabId: string | null },
        p: { tabs: typeof tabs; activeTabId: string | null },
      ) => void)
    | null = null;
  let inputCb: ((dataB64: string) => void) | null = null;
  let viewportCb: ((vp: { cols: number; rows: number } | null) => void) | null =
    null;
  let current: { tabs: typeof tabs; activeTabId: string | null } = {
    tabs,
    activeTabId: null,
  };
  const deps: AppTermBridgeDeps = {
    subscribe: (fn) => {
      subscriber = fn;
      return () => {
        subscriber = null;
      };
    },
    getTerm: (tabId) => registry.get(tabId),
    setActiveTab: (tabId) => activeReports.push(tabId),
    sendSnapshot: (b64, cols, rows) => snapshots.push({ b64, cols, rows }),
    onTermInput: (cb) => {
      inputCb = cb;
      return () => {
        inputCb = null;
      };
    },
    onViewport: (cb) => {
      viewportCb = cb;
      return () => {
        viewportCb = null;
      };
    },
  };
  const stop = installAppTermBridge(deps);
  return {
    activate(activeTabId) {
      const prev = current;
      current = { tabs, activeTabId };
      subscriber?.(current, prev);
    },
    viewerInput(data) {
      inputCb?.(b64encode(data));
    },
    viewport(vp) {
      viewportCb?.(vp);
    },
    deps: { activeReports, snapshots },
    registry,
    stop,
  };
}

describe("the app-share terminal bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TABS = [
    { id: "t1", type: "terminal" },
    { id: "b1", type: "browser" },
    { id: "t2", type: "terminal" },
  ];

  it("reports a mounted active terminal with its serialized screen and size", () => {
    const h = mount(TABS);
    const t1 = fakeTerm("screen one");
    h.registry.set("t1", t1.api);
    h.activate("t1");
    expect(h.deps.activeReports).toEqual(["t1"]);
    expect(h.deps.snapshots).toEqual([
      { b64: b64encode("screen one"), cols: 100, rows: 30 },
    ]);
    h.stop();
  });

  it("a non-terminal active tab still reports its raw id, and ships no snapshot", () => {
    const h = mount(TABS);
    h.activate("b1");
    // The RAW id reports now (Rust's agent binding keys on it); no
    // terminal fronts, so no snapshot ships.
    expect(h.deps.activeReports).toEqual(["b1"]);
    expect(h.deps.snapshots).toEqual([]);
    h.stop();
  });

  it("an activation that outran the mount is recovered by the settle re-checks", () => {
    const h = mount(TABS);
    // The tab activated before its TerminalView registered: the honest
    // first report is "no terminal", not a guess.
    h.activate("t2");
    expect(h.deps.activeReports).toEqual(["t2"]);
    // The mount lands inside the settle window: the re-report picks it
    // up and the viewers get the screen after all.
    const t2 = fakeTerm("late mount");
    h.registry.set("t2", t2.api);
    vi.advanceTimersByTime(1200);
    expect(h.deps.activeReports).toEqual(["t2", "t2"]);
    expect(h.deps.snapshots.map((s) => s.b64)).toEqual([
      b64encode("late mount"),
    ]);
    h.stop();
  });

  it("a settled live report is not re-sent (a re-send would blank viewer scrollback)", () => {
    const h = mount(TABS);
    const t1 = fakeTerm("live screen");
    h.registry.set("t1", t1.api);
    h.activate("t1");
    vi.advanceTimersByTime(2000);
    expect(h.deps.activeReports).toEqual(["t1"]);
    expect(h.deps.snapshots).toHaveLength(1);
    h.stop();
  });

  it("a new activation cancels the previous activation's settle re-checks", () => {
    const h = mount(TABS);
    h.activate("t1"); // no terminal mounted yet
    h.activate("b1"); // superseded before any re-check fired
    const t1 = fakeTerm();
    h.registry.set("t1", t1.api);
    vi.advanceTimersByTime(2000);
    // The stale re-check for t1 never reported it: the browser tab still
    // fronts, and Rust was never told a terminal was watchable.
    expect(h.deps.activeReports).toEqual(["t1", "b1"]);
    h.stop();
  });

  it("viewer keystrokes are decoded into the live terminal, dropped when none is live", () => {
    const h = mount(TABS);
    const t1 = fakeTerm();
    h.registry.set("t1", t1.api);
    h.activate("t1");
    h.viewerInput("ls\r");
    expect(t1.writes).toEqual(["ls\r"]);
    // A non-terminal activation makes the live slot null: input arriving
    // now is dropped, never written into a terminal the viewers cannot
    // see.
    h.activate("b1");
    h.viewerInput("rm -rf");
    expect(t1.writes).toEqual(["ls\r"]);
    h.stop();
  });

  it("the joint viewport caps the live terminal and re-snapshots the reflow", () => {
    const h = mount(TABS);
    const t1 = fakeTerm("before reflow");
    h.registry.set("t1", t1.api);
    h.activate("t1");
    h.viewport({ cols: 42, rows: 12 });
    expect(t1.caps).toEqual([{ cols: 42, rows: 12 }]);
    // The reflow touched every line: a fresh snapshot rides with the cap
    // so viewers re-anchor onto the new grid instead of re-wrapping old
    // bytes locally.
    expect(h.deps.snapshots.map((s) => s.b64)).toEqual([
      b64encode("before reflow"),
      b64encode("before reflow"),
    ]);
    h.stop();
  });

  it("a viewport arriving with no live terminal waits for the activation", () => {
    const h = mount(TABS);
    h.viewport({ cols: 42, rows: 12 });
    const t1 = fakeTerm("capped on arrival");
    h.registry.set("t1", t1.api);
    h.activate("t1");
    expect(t1.caps).toEqual([{ cols: 42, rows: 12 }]);
    h.stop();
  });

  it("switching the active tab releases the old terminal's cap and caps the new one", () => {
    const h = mount(TABS);
    const t1 = fakeTerm("one");
    const t2 = fakeTerm("two");
    h.registry.set("t1", t1.api);
    h.registry.set("t2", t2.api);
    h.activate("t1");
    h.viewport({ cols: 42, rows: 12 });
    h.activate("t2");
    expect(t1.caps).toEqual([{ cols: 42, rows: 12 }, null]);
    expect(t2.caps).toEqual([{ cols: 42, rows: 12 }]);
    h.stop();
  });

  it("lifting the cap (null) releases the terminal and the uninstall cleans up", () => {
    const h = mount(TABS);
    const t1 = fakeTerm("held");
    h.registry.set("t1", t1.api);
    h.activate("t1");
    h.viewport({ cols: 42, rows: 12 });
    h.viewport(null);
    expect(t1.caps).toEqual([{ cols: 42, rows: 12 }, null]);
    // Uninstall mid-cap: the terminal must not keep the audience's grid.
    h.viewport({ cols: 30, rows: 10 });
    h.stop();
    expect(t1.caps).toEqual([{ cols: 42, rows: 12 }, null, { cols: 30, rows: 10 }, null]);
  });

  it("the uninstall stops reports, input, and pending re-checks", () => {
    const h = mount(TABS);
    h.activate("t1"); // terminal not mounted: settle re-checks pending
    h.stop();
    const t1 = fakeTerm();
    h.registry.set("t1", t1.api);
    vi.advanceTimersByTime(2000);
    h.activate("t2");
    h.viewerInput("x");
    expect(h.deps.activeReports).toEqual(["t1"]);
    expect(t1.writes).toEqual([]);
  });
});
