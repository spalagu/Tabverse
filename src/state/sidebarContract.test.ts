import { beforeEach, describe, expect, it } from "vitest";
import { sessionSnapshot, useStore, visibleOrdered, withPresetGroups, type Tab } from "./store";
const s = () => useStore.getState();
const get = (id: string) => s().tabs.find((tab) => tab.id === id);
const make = (id: string, groupId: string | null = null) => s().addTab({ id, type: "browser", title: id, url: `https://${id}.test/`, groupId });
beforeEach(() => {
  while (s().reopenClosedTab() !== null) { /* drain */ }
  useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null, split: null, peekTabId: null,
    selectedTabIds: [], selectionAnchor: null, contentDrag: null, draggingTabIds: [] });
});

describe("design A01/A02: retention and runtime are separate", () => {
  it("removes a sleeping pin directly and restores its identity without starting it", () => {
    const a = make("a", "preset-browser");
    s().renameTab(a, "Saved work"); s().closeTab(a, false);
    const b = make("b");
    s().closeTab(a, true);
    expect(get(a)).toBeUndefined(); expect(s().tabs.map((t) => t.id)).toEqual([b]);
    expect(s().reopenClosedTab()).toBe(a);
    expect(get(a)).toMatchObject({ title: "Saved work", dormant: true, groupId: "preset-browser", pinnedUrl: "https://a.test/" });
    expect(s().activeTabId).toBe(b);
  });
  it("ignores repeat live-close delivery and deduplicates a batch", async () => {
    const a = make("a", "preset-browser");
    await s().closeTabs([a, a, a]); expect(get(a)?.dormant).toBe(true);
    s().closeTab(a, false); expect(get(a)).toBeDefined();
    await s().closeTabs([a, a]); expect(get(a)).toBeUndefined();
  });
  it("unpin does not wake and repin does not reset an existing anchor", () => {
    const a = make("a", "preset-browser"); s().closeTab(a);
    s().assignToGroup(a, null); expect(get(a)?.dormant).toBe(true);
    expect(get(a)?.groupId).toBeNull(); expect(s().activeTabId).toBeNull();
    s().assignToGroup(a, "preset-browser"); expect(get(a)?.dormant).toBe(true);
  });
  it("restores into the nearest surviving group without recreating a deleted folder", () => {
    const a = make("a"); const parent = s().createEmptyGroup(); s().setNamingGroup(null);
    const child = s().createEmptyGroup(parent); s().setNamingGroup(null);
    s().assignToGroup(a, child); s().closeTab(a); s().closeTab(a);
    s().deleteGroup(child); s().renameGroup(parent, "New name");
    s().reopenClosedTab();
    expect(get(a)).toMatchObject({ dormant: true, groupId: parent });
    expect(s().groups.some((g) => g.id === child)).toBe(false);
    expect(s().groups.find((g) => g.id === parent)?.name).toBe("New name");
  });
  it("never replays one-shot commands or stale handles when reopening", () => {
    const a = s().addTab({ type: "terminal", runOnStart: "do-not-repeat", attachSessionId: "old" });
    s().setTabTermId(a, "dead-pty"); s().closeTab(a); s().reopenClosedTab();
    expect(get(a)).toMatchObject({ runOnStart: undefined, attachSessionId: undefined, termId: undefined });
  });
});

describe("design A03/A04: every split entry point preserves identity", () => {
  const entries = [
    (a: string, b: string) => { s().activateTab(a); return s().splitWith(b); },
    (a: string, b: string) => s().splitOnTab(b, a, "right"),
    (a: string, b: string) => { s().activateTab(a); return s().splitDropAt(b, 1); },
  ];
  for (const [index, split] of entries.entries()) for (const fixedB of [false, true]) {
    it(`entry ${index}: fixed A + ${fixedB ? "fixed" : "ordinary"} B stays unchanged through split/un-split`, () => {
      const a = make("a", "preset-browser"), b = make("b", fixedB ? "preset-files" : null);
      const before = s().tabs.map((t) => ({ id: t.id, groupId: t.groupId, pinnedUrl: t.pinnedUrl }));
      expect(split(a, b)).toBe(true); s().moveSplitPane(b, -1); s().unsplit();
      expect(s().tabs.map((t) => ({ id: t.id, groupId: t.groupId, pinnedUrl: t.pinnedUrl }))).toEqual(before);
    });
  }
  it("keeps explicit changes made during a split instead of restoring old snapshots", () => {
    const a = make("a", "preset-browser"), b = make("b"); s().splitOnTab(b, a, "right");
    s().assignToGroup(a, null); s().assignToGroup(b, "preset-browser"); s().renameTab(b, "Keep me"); s().unsplit();
    expect(get(a)?.groupId).toBeNull(); expect(get(b)).toMatchObject({ groupId: "preset-browser", title: "Keep me" });
  });
  it("refuses a fifth, duplicate, dormant or self target without replacing the full layout", () => {
    const ids = ["a", "b", "c", "d", "e"].map((id) => make(id)); s().activateTab(ids[0]);
    ids.slice(1, 4).forEach((id) => s().splitWith(id)); const before = s().split;
    expect(s().splitOnTab(ids[4], ids[0], "right")).toBe(false);
    expect(s().splitDropAt(ids[4], 1)).toBe(false);
    expect(s().splitOnTab(ids[1], ids[0], "left")).toBe(false);
    expect(s().splitOnTab(ids[0], ids[0], "left")).toBe(false);
    expect(s().split).toEqual(before);
    const peek = s().openPeek({ type: "browser", url: "https://peek.test" });
    expect(s().splitPeek()).toBeNull(); expect(s().peekTabId).toBe(peek); expect(s().split).toEqual(before);
  });
  it("closing a pinned member leaves the ordinary survivor ordinary", () => {
    const a = make("a", "preset-browser"), b = make("b"); s().splitOnTab(b, a, "right");
    s().activateTab(a); s().closeTab(a);
    expect(get(a)?.dormant).toBe(true); expect(get(b)?.groupId).toBeNull(); expect(s().activeTabId).toBe(b);
    expect(s().split).toBeNull();
  });
  it("exports unchanged member identities and all rows for save and keyboard consumers", () => {
    const a = make("a", "preset-browser"), b = make("b"); s().splitOnTab(b, a, "right");
    expect(visibleOrdered(s().tabs, s().groups, s().split).map((t) => t.id)).toEqual([a, b]);
    expect(sessionSnapshot(s()).tabs.find((t) => t.id === b)?.groupId).toBeNull();
  });
});

describe("design A05–A07: organization is explicit and atomic", () => {
  it("places a multi-group selection atomically in visible order and preserves sleeping state", () => {
    const a = make("a", "preset-browser"), b = make("b", "preset-files"), c = make("c");
    s().closeTab(a); const states: Tab[][] = []; const unsubscribe = useStore.subscribe((now) => { states.push(now.tabs); });
    expect(s().moveTabsTo([a, b], null, c)).toBe(true); unsubscribe();
    expect(states).toHaveLength(1); expect(s().tabs.map((t) => t.id)).toEqual([b, a, c]); expect(get(a)?.dormant).toBe(true);
  });
  it("refuses self, stale anchors and missing destination groups", () => {
    const a = make("a"), b = make("b"); const before = s().tabs;
    expect(s().moveTabsTo([a, b], null, a)).toBe(false);
    expect(s().moveTabsTo([a], null, "gone")).toBe(false);
    expect(s().moveTabsTo([a], "gone", null)).toBe(false); expect(s().tabs).toBe(before);
  });
  it("copying a pin creates a temporary continuation, not an implicit second pin", () => {
    const a = make("a", "preset-browser"); const b = s().duplicateTab(a)!;
    expect(get(b)).toMatchObject({ groupId: null, pinnedUrl: undefined }); expect(get(a)?.groupId).toBe("preset-browser");
  });
  it("dissolving a top-level group retains sleeping generic pins safely", () => {
    const a = s().addTab({ type: "agent" }); const g = s().createGroup("Work", a); s().closeTab(a);
    s().dissolveGroup(g); expect(get(a)?.dormant).toBe(true); expect(get(a)?.groupId).not.toBeNull();
    expect(s().groups.some((group) => group.id === get(a)?.groupId)).toBe(true);
  });
});
