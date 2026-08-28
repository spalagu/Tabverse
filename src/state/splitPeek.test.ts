import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextSplitCandidate,
  sessionSnapshot,
  splitPartners,
  useStore,
  visibleOrdered,
  withPresetGroups,
} from "./store";
import {
  flushAll,
  listScopes,
  saveState,
  SESSION_SCOPE,
  tabScope,
} from "../persist";


const reset = async () => {
  await flushAll();
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    archive: [],
    archiveThreshold: "24h",
    split: null,
    splitDragging: false,
    peekTabId: null,
    contentDrag: null,
  });
};

const st = () => useStore.getState();

const addBrowser = (url: string) => st().addTab({ type: "browser", url });

describe("split state machine", () => {
  beforeEach(reset);

  it("splits the active browser tab (left) with the asked one (right)", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    expect(st().splitWith(b)).toBe(true);
    expect(st().split).toEqual({ ids: [a, b], ratios: [0.5, 0.5], vertical: false });
    // Focus stays where it was; the split is an arrangement, not a switch.
    expect(st().activeTabId).toBe(a);
    expect(splitPartners(st())).toEqual([b]);
  });

 it("refuses anything but distinct awake tabs — of any type", () => {
    const term = st().addTab({ type: "terminal" });
    const b = addBrowser("https://b.example/");
    st().activateTab(term);
    expect(st().splitWith(b)).toBe(true);
    expect(st().split!.ids).toEqual([term, b]);
    st().unsplit();
    st().activateTab(b);
    expect(st().splitWith(b)).toBe(false); // itself
    expect(st().splitWith(term)).toBe(true); // the other way round too
    st().unsplit();
    // A dormant pinned item has no pane to show in a split.
    const c = addBrowser("https://c.example/");
    const preset = st().groups.find((g) => g.preset === "browser")!.id;
    st().assignToGroup(c, preset);
    st().activateTab(b);
    st().closeTab(c); // pinned: turns dormant
    expect(st().tabs.find((t) => t.id === c)?.dormant).toBe(true);
    expect(st().splitWith(c)).toBe(false);
    expect(st().split).toBeNull();
  });

  it("keeps the split while focus moves between its members", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().activateTab(b);
    expect(st().split).not.toBeNull();
    expect(st().activeTabId).toBe(b);
    expect(splitPartners(st())).toEqual([a]);
  });

  it("closing the focus member drops it and seats a neighbour, the rest staying split", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b); // [a, b]
    st().splitWith(c); // active a in split -> grows to [a, b, c]
    expect(st().split!.ids).toEqual([a, b, c]);
    st().closeTab(a); // focus member closes
    expect(st().tabs.some((t) => t.id === a)).toBe(false);
    // b (a's right neighbour) takes focus; the split lives on as [b, c].
    expect(st().activeTabId).toBe(b);
    expect(st().split!.ids).toEqual([b, c]);
  });

  it("closing a member of a two-pane split dissolves it, seating the survivor", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().closeTab(a);
    expect(st().split).toBeNull();
    expect(st().activeTabId).toBe(b);
  });

 it("a pinned member going dormant drops it, dissolving a two-pane split", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const preset = st().groups.find((g) => g.preset === "browser")!.id;
    st().assignToGroup(b, preset);
    st().activateTab(a);
    st().splitWith(b);
    expect(st().split).not.toBeNull();
    st().closeTab(b); // pinned: sleeps, does not vanish
    expect(st().tabs.find((t) => t.id === b)?.dormant).toBe(true);
    expect(st().split).toBeNull();
    expect(st().activeTabId).toBe(a);
  });

  it("unsplit keeps every member and the focus", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().unsplit();
    expect(st().split).toBeNull();
    expect(st().tabs.some((t) => t.id === a)).toBe(true);
    expect(st().tabs.some((t) => t.id === b)).toBe(true);
    expect(st().activeTabId).toBe(a);
  });

 it("the archive scan spares every co-focused pane", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c]
    const idle = Date.now() + 25 * 60 * 60 * 1000;
    st().runArchiveScan(idle);
    // Both companions are on screen beside the active pane: neither shelved.
    expect(st().tabs.some((t) => t.id === b)).toBe(true);
    expect(st().tabs.some((t) => t.id === c)).toBe(true);
    st().unsplit();
    st().runArchiveScan(idle);
    // Without the split the same clock shelves them.
    expect(st().tabs.some((t) => t.id === b)).toBe(false);
    expect(st().tabs.some((t) => t.id === c)).toBe(false);
  });
});

describe("multi-pane growth and removal", () => {
  beforeEach(reset);

  it("Add Split brings in the most-recently-active other browser tab, beside the focus", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(c); // c is most recently active
    st().activateTab(b);
    st().activateTab(a); // now a active, recency c < b < a among the rest
    st().splitWith(b); // [a, b], active a
    // nextSplitCandidate is the most recent tab not in the split: c.
    expect(nextSplitCandidate(st())).toBe(c);
    expect(st().addSplitPane("right")).toBe(true);
    expect(st().split!.ids).toEqual([a, c, b]);
    // Even shares after a grow.
    expect(st().split!.ratios.every((r) => Math.abs(r - 1 / 3) < 1e-9)).toBe(true);
  });

  it("Add Split on the left inserts before the focus", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(c);
    st().activateTab(a);
    st().splitWith(b); // [a, b], active a
    st().addSplitPane("left"); // c before a
    expect(st().split!.ids).toEqual([c, a, b]);
  });

  it("refuses a fifth pane and greys Add when full (>4)", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    const d = addBrowser("https://d.example/");
    const e = addBrowser("https://e.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c);
    st().splitWith(d); // [a, b, c, d] — four
    expect(st().split!.ids).toHaveLength(4);
    // A fifth candidate exists (e), but the split is full.
    expect(nextSplitCandidate(st())).toBe(e);
    expect(st().addSplitPane("right")).toBe(false);
    expect(st().splitWith(e)).toBe(false);
    expect(st().split!.ids).toHaveLength(4);
  });

  it("Add greys when there is no other today browser tab to bring in", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    expect(nextSplitCandidate(st())).toBeNull();
    expect(st().addSplitPane("right")).toBe(false);
  });

  it("separate removes one member, the rest staying split; a non-focus removal keeps focus", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c], active a
    st().separateFromSplit(b); // remove the middle, non-focus
    expect(st().split!.ids).toEqual([a, c]);
    expect(st().activeTabId).toBe(a); // focus untouched
    // b lives on as an ordinary tab.
    expect(st().tabs.some((t) => t.id === b)).toBe(true);
  });

  it("separating the focus member hands focus to a neighbour, the split staying", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c], active a
    st().separateFromSplit(a); // remove the focus member
    expect(st().split!.ids).toEqual([b, c]);
    expect(st().activeTabId).toBe(b); // a's right neighbour
    expect(st().tabs.some((t) => t.id === a)).toBe(true); // survives
  });

  it("moves a pane one place, focus following the tab", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c], active a
    st().moveSplitPane(a, 1); // a swaps with b
    expect(st().split!.ids).toEqual([b, a, c]);
    expect(st().activeTabId).toBe(a); // focus follows the tab
    // Cannot move the first pane earlier or the last later.
    st().moveSplitPane(b, -1);
    expect(st().split!.ids).toEqual([b, a, c]);
    st().moveSplitPane(c, 1);
    expect(st().split!.ids).toEqual([b, a, c]);
  });
});

describe("split orientation and ratios", () => {
  beforeEach(reset);

  it("toggles between horizontal and vertical, keeping members and shares", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    expect(st().split!.vertical).toBe(false);
    st().toggleSplitOrientation();
    expect(st().split!.vertical).toBe(true);
    expect(st().split!.ids).toEqual([a, b]);
    st().toggleSplitOrientation();
    expect(st().split!.vertical).toBe(false);
  });

  it("drags a divider between two panes, clamped and summing to one", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c], each 1/3, boundaries at 1/3 and 2/3
    // Move divider 0 (between a and b) to 0.5: a=0.5, b takes the rest of the
    // a+b pair (2/3 - 0.5 = ~0.1667), c untouched at 1/3.
    st().setSplitRatio(0, 0.5, true);
    const r = st().split!.ratios;
    expect(r[0]).toBeCloseTo(0.5, 6);
    expect(r[0] + r[1]).toBeCloseTo(2 / 3, 6);
    expect(r[2]).toBeCloseTo(1 / 3, 6);
    expect(r.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    // Clamp: dragging divider 0 far left cannot shrink a below the minimum.
    st().setSplitRatio(0, 0.0, true);
    expect(st().split!.ratios[0]).toBeCloseTo(0.1, 6);
    expect(st().split!.ratios.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
  });

  it("round-trips a multi-pane vertical split through the session", async () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c);
    st().toggleSplitOrientation();
    st().setSplitRatio(0, 0.5, true);
    const saved = sessionSnapshot(st()).split;
    expect(saved!.ids).toEqual([a, b, c]);
    expect(saved!.vertical).toBe(true);
    await flushAll();
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      split: null,
    });
    expect(await st().restoreSession()).toBe(true);
    expect(st().split!.ids).toEqual([a, b, c]);
    expect(st().split!.vertical).toBe(true);
    expect(st().split!.ratios[0]).toBeCloseTo(0.5, 6);
  });

 it("migrates a pre- two-pane splitPair from an old session", async () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    const snap = sessionSnapshot(st()) as unknown as Record<string, unknown>;
    delete snap.split;
    snap.splitPair = { leftId: a, rightId: b, ratio: 0.3 };
    await flushAll();
    saveState(SESSION_SCOPE, snap);
    await flushAll();
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      split: null,
    });
    expect(await st().restoreSession()).toBe(true);
    expect(st().split!.ids).toEqual([a, b]);
    expect(st().split!.vertical).toBe(false);
    expect(st().split!.ratios[0]).toBeCloseTo(0.3, 6);
    expect(st().split!.ratios[1]).toBeCloseTo(0.7, 6);
  });

  it("restore drops a split whose survivors fall below two", async () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().closeTab(b); // today tab: really gone, split swept before saving
    await flushAll();
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      split: null,
    });
    expect(await st().restoreSession()).toBe(true);
    expect(st().split).toBeNull();
  });
});

describe("merged split row and navigation", () => {
  beforeEach(reset);

  it("counts a multi-pane split once — the first member stands for it", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    const d = addBrowser("https://d.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // [a, b, c], active a
    // Un-merged, every row counts (pre-split callers).
    const flat = visibleOrdered(st().tabs, st().groups).map((t) => t.id);
    expect(flat).toEqual([d, c, b, a]);
    // Merged, only the first member is its own row; b and c drop out.
    const merged = visibleOrdered(st().tabs, st().groups, st().split).map(
      (t) => t.id
    );
    expect(merged).toEqual([d, a]);
    expect(merged).not.toContain(b);
    expect(merged).not.toContain(c);
  });

  it("⌘n lands on the split's first pane; ⌃Tab counts it once from any member", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    const d = addBrowser("https://d.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().splitWith(c); // merged order: [d, a]
    st().activateIndex(1); // the split's row
    expect(st().activeTabId).toBe(a); // its first pane
    st().cycleTab(1);
    expect(st().activeTabId).toBe(d);
    // Focus a later pane, then ⌃Tab: the split still counts once.
    st().activateTab(c);
    st().cycleTab(1);
    expect(st().activeTabId).toBe(d);
  });
});

describe("drag-to-split drop judgment", () => {
  beforeEach(reset);

  it("puts the dragged tab on the side dropped, active on the other", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    expect(st().splitDrop(b, "left")).toBe(true);
    expect(st().split!.ids).toEqual([b, a]);
    expect(st().activeTabId).toBe(a);
    st().unsplit();
    expect(st().splitDrop(b, "right")).toBe(true);
    expect(st().split!.ids).toEqual([a, b]);
  });

  it("dropping onto an existing split adds at the near edge", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    const c = addBrowser("https://c.example/");
    st().activateTab(a);
    st().splitWith(b); // [a, b], active a
    expect(st().splitDrop(c, "right")).toBe(true);
    expect(st().split!.ids).toEqual([a, b, c]); // appended
    st().unsplit();
    st().activateTab(a);
    st().splitWith(b);
    expect(st().splitDrop(c, "left")).toBe(true);
    expect(st().split!.ids).toEqual([c, a, b]); // prepended
  });

  it("takes a drop of any type, and refuses a dormant one — clearing the drag", () => {
    const a = addBrowser("https://a.example/");
    const term = st().addTab({ type: "terminal" });
    st().setContentDrag({ id: term, side: "left" });
    st().activateTab(a);
    expect(st().splitDrop(term, "left")).toBe(true);
    expect(st().split!.ids).toEqual([term, a]);
    expect(st().contentDrag).toBeNull();
    st().unsplit();
    st().activateTab(term);
    expect(st().splitDrop(a, "right")).toBe(true);
    expect(st().split!.ids).toEqual([term, a]);
    st().unsplit();
    // Dormancy is one of the three conditions the type gate's removal left
    // standing, and a bad drop still ends the drag.
    const c = addBrowser("https://c.example/");
    const preset = st().groups.find((g) => g.preset === "browser")!.id;
    st().assignToGroup(c, preset);
    st().activateTab(term);
    st().closeTab(c); // pinned: turns dormant
    st().setContentDrag({ id: c, side: "left" });
    expect(st().splitDrop(c, "left")).toBe(false);
    expect(st().split).toBeNull();
    expect(st().contentDrag).toBeNull();
  });

  it("a successful drop clears the drag flag", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().setContentDrag({ id: b, side: "right" });
    expect(st().splitDrop(b, "right")).toBe(true);
    expect(st().contentDrag).toBeNull();
  });
});

describe("split pane operations legacy end states", () => {
  beforeEach(reset);

  it("separates a two-pane split: it dissolves, the OTHER gets focus, both survive", () => {
    const a = addBrowser("https://a.example/");
    const b = addBrowser("https://b.example/");
    st().activateTab(a);
    st().splitWith(b);
    st().separateFromSplit(a);
    expect(st().split).toBeNull();
    expect(st().tabs.some((t) => t.id === a)).toBe(true);
    expect(st().tabs.some((t) => t.id === b)).toBe(true);
    expect(st().activeTabId).toBe(b);
  });
});

describe("peek tab exclusion surface and lifecycle", () => {
  beforeEach(reset);

  it("opens without stealing activation and off every user-facing list", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/page" });
    expect(st().peekTabId).toBe(peek);
    expect(st().activeTabId).toBe(base);
    const t = st().tabs.find((x) => x.id === peek)!;
    expect(t.type).toBe("browser");
    expect(t.peek).toBe(true);
    expect(
      visibleOrdered(st().tabs, st().groups).some((x) => x.id === peek)
    ).toBe(false);
    expect(sessionSnapshot(st()).tabs.some((x) => x.id === peek)).toBe(false);
  });

  it("the archive scan never shelves it, however stale", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    useStore.setState({
      tabs: st().tabs.map((t) =>
        t.id === peek ? { ...t, lastActiveAt: 0 } : t
      ),
    });
    st().runArchiveScan(Date.now() + 25 * 60 * 60 * 1000);
    expect(st().tabs.some((t) => t.id === peek)).toBe(true);
    expect(st().archive.some((e) => e.id === peek)).toBe(false);
  });

  it("discard drops it: no reopen queue entry, state files reclaimed", async () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const closedBefore = st().closedCount;
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    saveState(tabScope("files", peek), { anything: true });
    st().discardPeek();
    expect(st().peekTabId).toBeNull();
    expect(st().tabs.some((t) => t.id === peek)).toBe(false);
    expect(st().closedCount).toBe(closedBefore);
    await vi.waitFor(async () => {
      expect(await listScopes()).not.toContain(`files:${peek}`);
    });
  });

  it("closing it through any door is the same discard", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const closedBefore = st().closedCount;
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    st().closeTab(peek);
    expect(st().peekTabId).toBeNull();
    expect(st().tabs.some((t) => t.id === peek)).toBe(false);
    expect(st().closedCount).toBe(closedBefore);
  });

  it("activating another tab discards it", () => {
    const base = addBrowser("https://pinned.example/");
    const other = st().addTab({ type: "terminal" });
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    st().activateTab(other);
    expect(st().peekTabId).toBeNull();
    expect(st().tabs.some((t) => t.id === peek)).toBe(false);
    expect(st().activeTabId).toBe(other);
  });

  it("re-activating the tab it opened over leaves it standing", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    st().activateTab(base);
    expect(st().peekTabId).toBe(peek);
    expect(st().tabs.some((t) => t.id === peek)).toBe(true);
  });

  it("any path that fronts a new tab drops it — the commit gate, not the caller", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    const term = st().addTab({ type: "terminal" });
    expect(st().activeTabId).toBe(term);
    expect(st().peekTabId).toBeNull();
    expect(st().tabs.some((t) => t.id === peek)).toBe(false);
  });

  it("Open as tab clears the mark and lands top-of-today, activated", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/page" });
    expect(st().promotePeek()).toBe(peek);
    expect(st().peekTabId).toBeNull();
    const t = st().tabs.find((x) => x.id === peek)!;
    expect(t.peek).toBeUndefined();
    expect(t.groupId).toBeNull();
    expect(st().tabs[0].id).toBe(peek);
    expect(st().activeTabId).toBe(peek);
    expect(
      visibleOrdered(st().tabs, st().groups).some((x) => x.id === peek)
    ).toBe(true);
    expect(sessionSnapshot(st()).tabs.some((x) => x.id === peek)).toBe(true);
  });

  it("a peek can never be a split member", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    expect(st().splitWith(peek)).toBe(false);
    expect(st().split).toBeNull();
  });
});

describe("peek's three actions", () => {
  beforeEach(reset);

  it("split: promotes the peek and splits it beside its source (source left, promoted right)", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/page" });
    const promoted = st().splitPeek();
    expect(promoted).toBe(peek);
    expect(st().peekTabId).toBeNull();
    const t = st().tabs.find((x) => x.id === peek)!;
    expect(t.peek).toBeUndefined();
    expect(st().activeTabId).toBe(peek);
    expect(st().split).toEqual({
      ids: [base, peek],
      ratios: [0.5, 0.5],
      vertical: false,
    });
    expect(splitPartners(st())).toEqual([base]);
  });

 it("splits over a terminal source too — the type gate is gone", () => {
    const term = st().addTab({ type: "terminal" });
    st().activateTab(term);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    const promoted = st().splitPeek();
    expect(promoted).toBe(peek);
    expect(st().peekTabId).toBeNull();
    expect(st().split!.ids).toEqual([term, peek]);
    expect(st().tabs.find((x) => x.id === peek)?.peek).toBeUndefined();
  });

  it("split with a source that went away just promotes, no split", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://elsewhere.example/" });
    // The tab the peek opened over is gone by the time the split is asked
    // for — the one case left now that any TYPE may stand in a pane.
    useStore.setState({ tabs: st().tabs.filter((t) => t.id !== base) });
    const promoted = st().splitPeek();
    expect(promoted).toBe(peek);
    expect(st().peekTabId).toBeNull();
    expect(st().split).toBeNull();
    expect(st().tabs.find((x) => x.id === peek)?.peek).toBeUndefined();
  });

 it("close discards, promote opens as a full tab — the other two actions", () => {
    const base = addBrowser("https://pinned.example/");
    st().activateTab(base);
    const p1 = st().openPeek({ type: "browser", url: "https://one.example/" });
    st().discardPeek();
    expect(st().peekTabId).toBeNull();
    expect(st().tabs.some((t) => t.id === p1)).toBe(false);
    const p2 = st().openPeek({ type: "browser", url: "https://two.example/" });
    expect(st().promotePeek()).toBe(p2);
    expect(st().peekTabId).toBeNull();
    expect(st().activeTabId).toBe(p2);
    expect(st().tabs.find((t) => t.id === p2)?.peek).toBeUndefined();
  });
});
