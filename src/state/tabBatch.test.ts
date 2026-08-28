import { beforeEach, describe, expect, it } from "vitest";
import { useStore, withPresetGroups, type Group, type SplitGroup, type Tab } from "./store";
import { batchActionTabs } from "../components/TabMenu";


const reset = async () => {
  // The closed queue is module-private and shared across this file; drain
  // it through its own door so one test's closes never answer the next
  // test's reopen assertion.
  while (useStore.getState().reopenClosedTab() !== null) {
    /* pop */
  }
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    archive: [],
    archiveEvicted: 0,
    archiveThreshold: "24h",
    selectedTabIds: [],
    selectionAnchor: null,
    mutedTabs: {},
    split: null,
    peekTabId: null,
  });
  localStorage.clear();
};

const tabOf = (id: string) => useStore.getState().tabs.find((t) => t.id === id);
const idsOf = (tabs: Tab[]) => tabs.map((t) => t.id);

describe("batch close inherits every branch", () => {
  beforeEach(reset);

  it("pinned sleeps in place, today enters the reopen queue, peek is discarded", async () => {
    const st = useStore.getState();
    // The peek's opener: active, and deliberately NOT in the batch, so the
    // overlay survives every intermediate commit until its own turn.
    const opener = st.addTab({ type: "terminal" });
    const pinned = st.addTab({ type: "terminal", cwd: "/tmp/pin" });
    const preset = useStore.getState().groups.find(
      (g) => g.preset === "terminal"
    )!;
    useStore.getState().assignToGroup(pinned, preset.id);
    const today = useStore.getState().addTab({ type: "files", cwd: "/tmp/today" });
    useStore.getState().activateTab(opener);
    const peek = useStore.getState().openPeek({ type: "browser", url: "https://peek.test/" });
    const queueBefore = useStore.getState().closedCount;
    useStore.setState({ selectedTabIds: [pinned, today, peek] });

    await useStore.getState().closeTabs([pinned, today, peek]);

    const s = useStore.getState();
    // pinned → dormant, not destroyed: same row, same folder, still here.
    expect(tabOf(pinned)?.dormant).toBe(true);
    expect(tabOf(pinned)?.groupId).toBe(preset.id);
    // today → really closed, and reopenable: it is IN the queue.
    expect(s.tabs.some((t) => t.id === today)).toBe(false);
    // peek → discarded, gone, and NOT in the queue — the whole batch grew
    // the queue by exactly one entry (the today tab's).
    expect(s.tabs.some((t) => t.id === peek)).toBe(false);
    expect(s.peekTabId).toBeNull();
    expect(s.closedCount).toBe(queueBefore + 1);
    expect(s.reopenClosedTab()).toBe(today);
    // The picking is done and gone.
    expect(s.selectedTabIds).toEqual([]);
  });

  it("hands focus to a surviving neighbour when the active row closes", async () => {
    const st = useStore.getState();
    const first = st.addTab({ type: "terminal" });
    const second = st.addTab({ type: "terminal" });
    const third = st.addTab({ type: "terminal" });
    useStore.getState().activateTab(second);

    await useStore.getState().closeTabs([second, third]);

    // closeTab's own handoff, inherited per close: the last close of the
    // active row seats a visible survivor.
    expect(useStore.getState().activeTabId).toBe(first);
  });

  it("a destructive close in the batch is asked about alone; a no leaves it standing", async () => {
    const st = useStore.getState();
    const settings = st.addTab({ type: "settings" });
    const today = useStore.getState().addTab({ type: "terminal" });
    const asked: string[] = [];
    const ask = async (t: Tab) => {
      asked.push(t.id);
      return false;
    };

    await useStore.getState().closeTabs([today, settings], ask);

    // Only the destructive kind was asked about — the today row closed
    // unasked, exactly as its own menu item always has.
    expect(asked).toEqual([settings]);
    expect(useStore.getState().tabs.some((t) => t.id === today)).toBe(false);
    expect(useStore.getState().tabs.some((t) => t.id === settings)).toBe(true);
    expect(useStore.getState().selectedTabIds).toEqual([]);
  });

  it("a yes closes the destructive row — and nothing of it enters the reopen list", async () => {
    const st = useStore.getState();
    const settings = st.addTab({ type: "settings" });
    const keeper = useStore.getState().addTab({ type: "terminal" });
    const queueBefore = useStore.getState().closedCount;
    const ask = async () => true;

    await useStore.getState().closeTabs([keeper, settings], ask);

    expect(useStore.getState().tabs.some((t) => t.id === settings)).toBe(false);
    // The keeper queued; the settings row is final, as its question said.
    expect(useStore.getState().closedCount).toBe(queueBefore + 1);
    expect(useStore.getState().reopenClosedTab()).toBe(keeper);
  });

  it("an id that stopped existing between click and close is simply done", async () => {
    const st = useStore.getState();
    const gone = st.addTab({ type: "terminal" });
    useStore.getState().closeTab(gone);
    const survivor = useStore.getState().addTab({ type: "terminal" });

    await useStore.getState().closeTabs([gone, survivor]);

    expect(useStore.getState().tabs.some((t) => t.id === survivor)).toBe(false);
  });
});

describe("batch archive passes the shelf's own gate", () => {
  beforeEach(reset);

  it("shelves the eligible, holds the rest back BY NAME, and reports both", () => {
    const st = useStore.getState();
    const doomed = st.addTab({ type: "browser", url: "https://a.test/" });
    const running = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().setTabBusy(running, true); // the state guard holds it
    const pinned = useStore.getState().addTab({
      type: "browser",
      url: "https://b.test/",
    });
    const preset = useStore.getState().groups.find(
      (g) => g.preset === "browser"
    )!;
    useStore.getState().assignToGroup(pinned, preset.id); // the zone rule holds it
    useStore.setState({ selectedTabIds: [doomed, running, pinned] });

    const report = useStore.getState().archiveTabs([doomed, running, pinned]);

    const s = useStore.getState();
    expect(report.archived).toBe(1);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped).toContain(tabOf(running)!.title);
    expect(report.skipped).toContain(tabOf(pinned)!.title);
    // The eligible one is on the shelf, same id, revivable; the held ones
    // are untouched where they stand.
    const at = s.archive.findIndex((e) => e.id === doomed);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(s.tabs.some((t) => t.id === running)).toBe(true);
    expect(s.tabs.some((t) => t.id === pinned)).toBe(true);
    expect(s.tabs.some((t) => t.id === doomed)).toBe(false);
    expect(s.unarchiveEntry(at)).toBe(doomed);
    expect(s.selectedTabIds).toEqual([]);
  });

  it("the active tab is archived only after focus is handed to a survivor", () => {
    const st = useStore.getState();
    const survivor = st.addTab({ type: "terminal" });
    const active = useStore.getState().addTab({ type: "browser", url: "https://c.test/" });
    useStore.getState().activateTab(active);

    const report = useStore.getState().archiveTabs([active]);

    expect(report.archived).toBe(1);
    expect(useStore.getState().activeTabId).toBe(survivor);
  });

  it("a batch the gate refuses entirely shelves nothing and still accounts", () => {
    const st = useStore.getState();
    const settings = st.addTab({ type: "settings" });
    useStore.setState({ selectedTabIds: [settings] });

    const report = useStore.getState().archiveTabs([settings]);

    expect(report.archived).toBe(0);
    expect(report.skipped).toEqual([tabOf(settings)!.title]);
    expect(useStore.getState().archive).toHaveLength(0);
    expect(useStore.getState().tabs.some((t) => t.id === settings)).toBe(true);
    expect(useStore.getState().selectedTabIds).toEqual([]);
  });
});

describe("the menu transforms only when it hits the picking", () => {
  beforeEach(reset);

  const menuOf = (tabs: Tab[], groups: Group[] = useStore.getState().groups) => {
    const split: SplitGroup | null = null;
    return { tabs, groups, split };
  };

  it("acts on the whole picking, in drawing order, when the menu's row is one of it", () => {
    const st = useStore.getState();
    const second = st.addTab({ type: "terminal" });
    const pinned = st.addTab({ type: "terminal" });
    const preset = useStore.getState().groups.find(
      (g) => g.preset === "terminal"
    )!;
    useStore.getState().assignToGroup(pinned, preset.id);
    const { tabs, groups, split } = menuOf(useStore.getState().tabs);

    // The pinned zone draws first: the batch runs in the order the eye
    // marked, not the array's.
    const batch = batchActionTabs(tabs, groups, split, [second, pinned], pinned);
    expect(batch && idsOf(batch)).toEqual([pinned, second]);
  });

  it("stays single when the row is outside the picking, or the picking is the row alone", () => {
    const st = useStore.getState();
    const a = st.addTab({ type: "terminal" });
    const b = st.addTab({ type: "terminal" });
    const { tabs, groups, split } = menuOf(useStore.getState().tabs);

    // Outside the picking entirely: the single-tab menu, unchanged.
    expect(batchActionTabs(tabs, groups, split, [b], a)).toBeNull();
    // The picking is exactly the clicked row: still the single menu —
    // a one-row batch would only be the single menu wearing a costume.
    expect(batchActionTabs(tabs, groups, split, [a], a)).toBeNull();
    expect(batchActionTabs(tabs, groups, split, [], a)).toBeNull();
  });

  it("never offers a peek row — the sidebar does not draw one to pick", () => {
    const st = useStore.getState();
    const opener = st.addTab({ type: "terminal" });
    const other = useStore.getState().addTab({ type: "terminal" });
    const peek = useStore.getState().openPeek({ type: "browser", url: "https://peek.test/" });
    const { tabs, groups, split } = menuOf(useStore.getState().tabs);

    // A peek id in the picking counts for nothing: with only one real row
    // left beside it, the menu is the single one.
    expect(batchActionTabs(tabs, groups, split, [other, peek], other)).toBeNull();
    // And a peek id never swells a real batch either — the batch is the
    // two rows the eye can see, in drawing order (a new tab lands at the
    // top of today, so `other` draws above `opener`).
    const batch = batchActionTabs(
      tabs,
      groups,
      split,
      [opener, other, peek],
      other
    );
    expect(batch && idsOf(batch)).toEqual([other, opener]);
    expect(useStore.getState().tabs.some((t) => t.id === opener)).toBe(true);
  });
});
