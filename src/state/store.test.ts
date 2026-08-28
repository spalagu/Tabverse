import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_SCOPE,
  FOLDER_PREVIEW_WIDTH,
  anyOverlayOpen,
  contentObstructionX,
  inheritedCwd,
  markFreshRun,
  pointerPastSidebar,
  sessionSnapshot,
  sweepOrphanTabState,
  useStore,
  visibleOrdered,
  withPresetGroups,
  type PersistedState,
} from "./store";
import {
  SESSION_SCOPE,
  flushAll,
  listScopes,
  saveState,
  tabScope,
} from "../persist";

/**
 * Runs against the doorway's browser-demo carrier (localStorage). Saves are
 * debounced, so tests flush before asserting on the carrier, and restore is
 * awaited — same shape the app itself uses.
 */

/** Where the fallback carrier lands the session scope. */
const CARRIER_KEY = "tabverse.state.session";

const reset = async () => {
  await flushAll(); // drain buffered writes so they cannot leak forward
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    sessionRestoreResult: null,
    archive: [],
    archiveEvicted: 0,
    archiveThreshold: "24h",
    // Per-pane busy records are transient run state; one test's panes must
    // not hold the next test's tabs busy.
    busyPanes: {},
  });
};

describe("session persistence", () => {
  beforeEach(reset);

  it.each([
    [null, "missing"],
    ["{ not json", "invalid-json"],
    [JSON.stringify({ version: 2, tabs: [] }), "unsupported-version"],
    [JSON.stringify({ version: 1, tabs: "not-an-array" }), "invalid-shape"],
    [JSON.stringify({ version: 1, tabs: [] }), "empty-tabs"],
  ] as const)(
    "records %s as %s without changing the in-memory session",
    async (raw, expected) => {
      if (raw !== null) localStorage.setItem(CARRIER_KEY, raw);
      const before = useStore.getState().tabs;

      expect(await useStore.getState().restoreSession()).toBe(false);
      expect(useStore.getState().sessionRestoreResult).toBe(expected);
      expect(useStore.getState().tabs).toBe(before);
    }
  );

  it("blocks every session write after recovery is declined until replacement is authorized", async () => {
    const raw = "{ not json";
    localStorage.setItem(CARRIER_KEY, raw);
    expect(await useStore.getState().restoreSession()).toBe(false);

    useStore.getState().addTab({ type: "terminal" });
    await flushAll();
    expect(localStorage.getItem(CARRIER_KEY)).toBe(raw);

    useStore.setState({ sessionRestoreResult: "missing" });
    useStore.getState().addTab({ type: "terminal" });
    await flushAll();
    expect(JSON.parse(localStorage.getItem(CARRIER_KEY)!).tabs).toHaveLength(2);
  });

  it("round-trips tabs and groups through the doorway to the carrier", async () => {
    const st = useStore.getState();
    const a = st.addTab({ type: "terminal" });
    st.addTab({ type: "browser", url: "https://example.com" });
    useStore.getState().createGroup("work", a);

    // Landed, not merely queued: the carrier itself must hold the session,
    // or a clean-looking run would still lose everything at process death.
    await flushAll();
    expect(localStorage.getItem(CARRIER_KEY)).not.toBeNull();

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.find((t) => t.type === "browser")?.url).toBe(
      "https://example.com"
    );
    // Three preset groups plus the custom one.
    const custom = s.groups.filter((g) => !g.preset);
    expect(custom).toHaveLength(1);
    expect(s.tabs.find((t) => t.id === a)?.groupId).toBe(custom[0].id);
  });

  it("does not restore a group whose only members were dropped remote tabs", async () => {
    const st = useStore.getState();
    const r = st.addTab({ type: "remote" });
    useStore.getState().createGroup("borrowed", r);
    // Keep at least one persistable tab so a session exists at all.
    useStore.getState().addTab({ type: "terminal" });

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    // No flush on purpose: restore must also serve the still-buffered save.
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    expect(s.tabs.every((t) => t.type !== "remote")).toBe(true);
    // No empty shell in the sidebar — presets are the only groups that
    // survive without members, because new tabs still need somewhere to land.
    expect(s.groups.filter((g) => !g.preset)).toHaveLength(0);
  });

  it("a pinned front tab restores awake and front; every awake pin stays awake", async () => {
    const st = useStore.getState();
    const a = st.addTab({ type: "terminal" });
    const pinned = st.addTab({ type: "terminal" });
    const gid = useStore.getState().createGroup("work", pinned);
    expect(gid).toBeTruthy();
    // The pinned tab fronts at quit.
    st.activateTab(pinned);
    await flushAll();

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    const row = s.tabs.find((t) => t.id === pinned);
    const today = s.tabs.find((t) => t.id === a);
    expect(row?.dormant).toBeUndefined();
    expect(s.activeTabId).toBe(pinned);
    // The today tab is awake too (it always was); the discrimination is
    // that PINNED and not-front rows sleep — pinned here via the group.
    expect(today?.dormant).toBeUndefined();
  });
});

describe("per-tab state lifecycle", () => {
  beforeEach(reset);

  it("closing a tab keeps its workspace while it can still be reopened", async () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "files" });
    saveState(tabScope("files", id), { root: "/tmp" });
    saveState(tabScope("drafts", id), { text: "wip" });
    expect(await listScopes()).toContain(`files:${id}`);

    useStore.getState().closeTab(id);
    await flushAll();
    const scopes = await listScopes();
    expect(scopes).toContain(`files:${id}`);
    expect(scopes).toContain(`drafts:${id}`);
  });

  it("reclaims a closed tab's workspace once it falls off the ledger", async () => {
    const st = useStore.getState();
    const first = st.addTab({ type: "files" });
    saveState(tabScope("files", first), { root: "/tmp" });
    useStore.getState().closeTab(first);

    // Ten more closes push the first one out; only then is it reclaimed.
    for (let i = 0; i < 10; i++) {
      const id = useStore.getState().addTab({ type: "files" });
      useStore.getState().closeTab(id);
    }
    await vi.waitFor(async () => {
      expect(await listScopes()).not.toContain(`files:${first}`);
    });
  });

  it("reopening restores the tab with its group, place and workspace", async () => {
    const st = useStore.getState();
    st.addTab({ type: "terminal" });
    const id = useStore.getState().addTab({ type: "files", cwd: "/tmp/work" });
    const groupBefore = useStore.getState().tabs.find((t) => t.id === id)!.groupId;
    const indexBefore = useStore.getState().tabs.findIndex((t) => t.id === id);
    saveState(tabScope("files", id), { root: "/tmp/work" });

    useStore.getState().closeTab(id);
    expect(useStore.getState().tabs.some((t) => t.id === id)).toBe(false);

    expect(useStore.getState().reopenClosedTab()).toBe(id);
    const back = useStore.getState().tabs.find((t) => t.id === id)!;
    // Same id is what makes the workspace come back with it: its state
    // files are keyed by the tab's id.
    expect(back.cwd).toBe("/tmp/work");
    expect(back.groupId).toBe(groupBefore);
    expect(useStore.getState().tabs.findIndex((t) => t.id === id)).toBe(indexBefore);
    expect(await listScopes()).toContain(`files:${id}`);
  });

  it("boot sweep reclaims scopes whose tab no longer exists", async () => {
    const st = useStore.getState();
    const live = st.addTab({ type: "files" });
    const deadId = crypto.randomUUID();
    saveState(tabScope("files", live), { keep: true });
    saveState(tabScope("files", deadId), { orphan: true });
    saveState("settings", { theme: "dark" }); // no owning tab: never swept

    await sweepOrphanTabState();
    await flushAll(); // let the queued deletions land
    const scopes = await listScopes();
    expect(scopes).toContain(`files:${live}`);
    expect(scopes).toContain("settings");
    expect(scopes).not.toContain(`files:${deadId}`);
  });
});

describe("duplicating a tab", () => {
  beforeEach(reset);

  it("copies the situation, lands beside its source, and shares its group", () => {
    const st = useStore.getState();
    const src = st.addTab({ type: "files", cwd: "/tmp/project" });
    const other = useStore.getState().addTab({ type: "files", cwd: "/tmp/other" });
    const copy = useStore.getState().duplicateTab(src)!;
    const tabs = useStore.getState().tabs;
    const at = (id: string) => tabs.findIndex((t) => t.id === id);

    expect(tabs.find((t) => t.id === copy)?.cwd).toBe("/tmp/project");
    // A copy is a new tab, never a second handle on the same live thing.
    expect(copy).not.toBe(src);
    expect(tabs.find((t) => t.id === copy)?.groupId).toBe(
      tabs.find((t) => t.id === src)?.groupId
    );
    expect(at(copy)).toBe(at(src) + 1);
    expect(at(other)).toBeLessThan(at(src));
  });

  it("refuses the two types where a copy means nothing", () => {
    const st = useStore.getState();
    const settings = st.addTab({ type: "settings" });
    const remote = useStore.getState().addTab({ type: "remote" });
    expect(useStore.getState().duplicateTab(settings)).toBeNull();
    expect(useStore.getState().duplicateTab(remote)).toBeNull();
  });
});

describe("visible order — what ⌘1-9 and ⌃Tab count", () => {
  beforeEach(reset);

  it("matches the sidebar: pinned-zone members first, then the today list", () => {
    const st = useStore.getState();
    const loose = st.addTab({ type: "terminal" });
    const grouped = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().createGroup("g", grouped);

    const ordered = visibleOrdered(
      useStore.getState().tabs,
      useStore.getState().groups
    );
    // The custom group's member comes before whatever lives in today.
    expect(ordered.map((t) => t.id)).toEqual([grouped, loose]);

    // ⌘1 therefore lands on the grouped tab, not on tabs[0].
    useStore.getState().activateIndex(0);
    expect(useStore.getState().activeTabId).toBe(grouped);
  });

 it("lands every new tab at the top of the today zone", () => {
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal" });
    const browser = useStore.getState().addTab({ type: "browser" });
    const settings = useStore.getState().addTab({ type: "settings" });
    const tabs = useStore.getState().tabs;
    expect(tabs.every((t) => t.groupId === null)).toBe(true);
    expect(tabs.map((t) => t.id)).toEqual([settings, browser, term]);
  });

  it("keeps a preset group when emptied — promotion still needs its target", () => {
    const st = useStore.getState();
    const filed = st.addTab({ type: "files" });
    const preset = useStore
      .getState()
      .groups.find((g) => g.preset === "files")!;
    useStore.getState().assignToGroup(filed, preset.id);
    useStore.getState().deleteGroup(preset.id);
    const groups = useStore.getState().groups;
    expect(groups.some((g) => g.id === preset.id)).toBe(true);
    // A new tab lands in today; the preset is where promotion aims.
    const next = useStore.getState().addTab({ type: "files" });
    expect(useStore.getState().tabs.find((t) => t.id === next)?.groupId).toBeNull();
    useStore.getState().assignToGroup(next, preset.id);
    expect(
      useStore.getState().tabs.find((t) => t.id === next)?.groupId
    ).toBe(preset.id);
  });

 it("a collapsed group peeks its materialized members and hides only dormant ones", () => {
    const st = useStore.getState();
    const awake = st.addTab({ type: "terminal" });
    const sleeper = useStore.getState().addTab({ type: "terminal" });
    const loose = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().createGroup("g", awake);
    const gid = useStore.getState().groups.find((g) => !g.preset)!.id;
    useStore.getState().assignToGroup(sleeper, gid);
    useStore.getState().closeTab(sleeper); // pinned close = dormant
    useStore.getState().toggleGroupCollapsed(gid);
    const ordered = visibleOrdered(
      useStore.getState().tabs,
      useStore.getState().groups
    );
    // The materialized member peeks out of the collapsed folder and stays
    // countable for ⌘1-9; the dormant one is out of sight.
    expect(ordered.map((t) => t.id)).toEqual([awake, loose]);
    // Expanded, both count — the dormant row is on screen, dimmed.
    useStore.getState().toggleGroupCollapsed(gid);
    const expanded = visibleOrdered(
      useStore.getState().tabs,
      useStore.getState().groups
    ).map((t) => t.id);
    expect(expanded).toContain(sleeper);
    expect(expanded).toContain(awake);
  });

 it("activation leaves a collapsed group collapsed — the row peeks instead", () => {
    const st = useStore.getState();
    const a = st.addTab({ type: "terminal" });
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().createGroup("g", a);
    const gid = useStore.getState().groups.find((g) => !g.preset)!.id;
    useStore.getState().toggleGroupCollapsed(gid);
    useStore.getState().activateTab(a);
    // The folder stays exactly as it was — the preview panel's "activate
    // and stay collapsed" depends on this — and the activated tab is still
    // visible, because a materialized member peeks.
    expect(
      useStore.getState().groups.find((g) => g.id === gid)?.collapsed
    ).toBe(true);
    expect(
      visibleOrdered(useStore.getState().tabs, useStore.getState().groups).some(
        (t) => t.id === a
      )
    ).toBe(true);
  });
});

describe("nested groups", () => {
  beforeEach(reset);

  /** A parent and a child group, each holding one terminal tab. */
  const makeTree = () => {
    const st = useStore.getState();
    const parent = st.createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    const child = useStore.getState().createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    expect(useStore.getState().setGroupParent(child, parent)).toBe(true);
    const pTab = useStore.getState().addTab({ type: "terminal", groupId: parent });
    const cTab = useStore.getState().addTab({ type: "terminal", groupId: child });
    return { parent, child, pTab, cTab };
  };

 it("flattens depth-first, subfolders above their parent's own tabs", () => {
    const { parent, child, pTab, cTab } = makeTree();
    const grandchild = useStore.getState().createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    expect(useStore.getState().setGroupParent(grandchild, child)).toBe(true);
    const gTab = useStore
      .getState()
      .addTab({ type: "terminal", groupId: grandchild });
    const order = visibleOrdered(
      useStore.getState().tabs,
      useStore.getState().groups
    ).map((t) => t.id);
    expect(order.indexOf(cTab)).toBe(order.indexOf(gTab) + 1);
    expect(order.indexOf(pTab)).toBe(order.indexOf(cTab) + 1);
    // ⌘n counts this same order, so the seam holds for the shortcuts too.
    useStore.getState().activateIndex(order.indexOf(gTab));
    expect(useStore.getState().activeTabId).toBe(gTab);
    void parent;
    void child;
  });

  it("collapse reaches the whole subtree: dormant members hide through any level", () => {
    const { parent, child, cTab, pTab } = makeTree();
    // The child's member sleeps; the parent's stays materialized.
    useStore.getState().closeTab(cTab);
    useStore.getState().toggleGroupCollapsed(parent);
    const shown = visibleOrdered(
      useStore.getState().tabs,
      useStore.getState().groups
    ).map((t) => t.id);
    expect(shown).not.toContain(cTab);
    expect(shown).toContain(pTab);
    void child;
  });

  it("refuses to nest a group into its own descendant, with no side effects", () => {
    const { parent, child } = makeTree();
    const before = useStore.getState().groups;
    expect(useStore.getState().setGroupParent(parent, child)).toBe(false);
    expect(useStore.getState().setGroupParent(parent, parent)).toBe(false);
    expect(useStore.getState().groups).toEqual(before);
  });

  it("keeps preset groups at the root", () => {
    const { parent } = makeTree();
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    expect(useStore.getState().setGroupParent(preset.id, parent)).toBe(false);
    expect(
      useStore.getState().groups.find((g) => g.id === preset.id)?.parentId
    ).toBeUndefined();
  });

  it("reorders a group before a sibling, adopting that sibling's level", () => {
    const st = useStore.getState();
    const a = st.createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    const b = useStore.getState().createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    // Array order is sibling order: b was made after a, so moving b before
    // a must flip them.
    expect(useStore.getState().moveGroupBefore(b, a)).toBe(true);
    const ids = useStore.getState().groups.map((g) => g.id);
    expect(ids.indexOf(b)).toBe(ids.indexOf(a) - 1);
  });

  it("sweeps a custom group only when its whole subtree holds no tabs", () => {
    const st = useStore.getState();
    // A by-product parent (no keepWhenEmpty): made from a tab, then the tab
    // moves one level down into a child group.
    const anchor = st.addTab({ type: "terminal", groupId: null });
    const parent = useStore.getState().createGroup("parent", anchor);
    const inner = useStore.getState().addTab({ type: "terminal", groupId: null });
    const child = useStore.getState().createGroup("child", inner);
    expect(useStore.getState().setGroupParent(child, parent)).toBe(true);
    useStore.getState().assignToGroup(anchor, null);
    // The parent's own membership is now empty, but its subtree is not —
    // the old per-group rule would have deleted it here.
    expect(useStore.getState().groups.some((g) => g.id === parent)).toBe(true);
    expect(useStore.getState().groups.some((g) => g.id === child)).toBe(true);
    // Empty the subtree for real and both go.
    useStore.getState().assignToGroup(inner, null);
    expect(useStore.getState().groups.some((g) => g.id === parent)).toBe(false);
    expect(useStore.getState().groups.some((g) => g.id === child)).toBe(false);
  });

  it("saves a parent whose tabs all live in a child group", () => {
    // By-product groups on purpose: keepWhenEmpty ones are saved anyway, so
    // only these prove the snapshot judges the subtree.
    const anchor = useStore.getState().addTab({ type: "terminal", groupId: null });
    const parent = useStore.getState().createGroup("parent", anchor);
    const inner = useStore.getState().addTab({ type: "terminal", groupId: null });
    const child = useStore.getState().createGroup("child", inner);
    expect(useStore.getState().setGroupParent(child, parent)).toBe(true);
    // Leave the parent with no member of its own; it must still be written
    // out, or a restart would orphan the child's parent pointer.
    useStore.getState().assignToGroup(anchor, null);
    const saved = sessionSnapshot(useStore.getState());
    expect(saved.groups.some((g) => g.id === parent)).toBe(true);
    expect(saved.groups.some((g) => g.id === child)).toBe(true);
  });

 it("closeGroup puts the whole subtree to sleep and keeps the folder", () => {
    const { parent, child, pTab, cTab } = makeTree();
    useStore.getState().activateTab(cTab);
    useStore.getState().closeGroup(parent);
    const s = useStore.getState();
    // Nothing left the tree: both tabs are still filed, just dormant.
    expect(s.tabs.find((t) => t.id === pTab)?.dormant).toBe(true);
    expect(s.tabs.find((t) => t.id === cTab)?.dormant).toBe(true);
    expect(s.tabs.find((t) => t.id === pTab)?.groupId).toBe(parent);
    expect(s.tabs.find((t) => t.id === cTab)?.groupId).toBe(child);
    expect(s.groups.some((g) => g.id === parent)).toBe(true);
    expect(s.groups.some((g) => g.id === child)).toBe(true);
    // The active tab was inside; focus went to a tab that still has a pane.
    expect(s.activeTabId).not.toBe(cTab);
  });

  it("deleteGroup removes the whole subtree; a preset root survives it", () => {
    const { parent, child, pTab, cTab } = makeTree();
    useStore.getState().deleteGroup(parent);
    const s = useStore.getState();
    expect(s.tabs.some((t) => t.id === pTab || t.id === cTab)).toBe(false);
    expect(s.groups.some((g) => g.id === parent || g.id === child)).toBe(false);

    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    const nested = useStore.getState().createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    expect(useStore.getState().setGroupParent(nested, preset.id)).toBe(true);
    const inTab = useStore.getState().addTab({ type: "browser", groupId: nested });
    useStore.getState().deleteGroup(preset.id);
    const after = useStore.getState();
    expect(after.groups.some((g) => g.id === preset.id)).toBe(true);
    expect(after.groups.some((g) => g.id === nested)).toBe(false);
    expect(after.tabs.some((t) => t.id === inTab)).toBe(false);
  });

 it("dissolving a nested folder lifts subfolders and tabs into its parent", () => {
    const { parent, child, cTab } = makeTree();
    // Give the child a subfolder of its own, to prove subtrees move whole.
    const grandchild = useStore.getState().createEmptyGroup();
    useStore.getState().setNamingGroup(null);
    expect(useStore.getState().setGroupParent(grandchild, child)).toBe(true);
    const anchored = useStore
      .getState()
      .addTab({ type: "browser", groupId: child, url: "https://kept.test/" });
    useStore.getState().dissolveGroup(child);
    const s = useStore.getState();
    expect(s.groups.some((g) => g.id === child)).toBe(false);
    // Contents went one level up: into the dissolved folder's parent.
    expect(s.groups.find((g) => g.id === grandchild)?.parentId).toBe(parent);
    expect(s.tabs.find((t) => t.id === cTab)?.groupId).toBe(parent);
    expect(s.tabs.find((t) => t.id === anchored)?.groupId).toBe(parent);
    // Still in the pinned zone, so a browser anchor survives the lift.
    expect(s.tabs.find((t) => t.id === anchored)?.pinnedUrl).toBe(
      "https://kept.test/"
    );
  });

 it("dissolving a top-level folder demotes its tabs to today, anchors cleared", () => {
    const st = useStore.getState();
    const page = st.addTab({ type: "browser", url: "https://home.test/" });
    const folder = useStore.getState().createGroup("Mine", page);
    expect(useStore.getState().tabs.find((t) => t.id === page)?.pinnedUrl).toBe(
      "https://home.test/"
    );
    // A subfolder with its own tab becomes a root and keeps its member.
    const sub = useStore.getState().createEmptyGroup(folder);
    useStore.getState().setNamingGroup(null);
    const subTab = useStore.getState().addTab({ type: "terminal", groupId: sub });
    useStore.getState().dissolveGroup(folder);
    const s = useStore.getState();
    expect(s.groups.some((g) => g.id === folder)).toBe(false);
    // "Up" from the top level leaves the pinned zone: today, anchor gone.
    expect(s.tabs.find((t) => t.id === page)?.groupId).toBeNull();
    expect(s.tabs.find((t) => t.id === page)?.pinnedUrl).toBeUndefined();
    expect(s.groups.find((g) => g.id === sub)?.parentId).toBeUndefined();
    expect(s.tabs.find((t) => t.id === subTab)?.groupId).toBe(sub);
  });

  it("refuses to dissolve a preset, and deleteGroup stays the close-tabs answer", () => {
    const st = useStore.getState();
    const filed = st.addTab({ type: "files" });
    const preset = useStore.getState().groups.find((g) => g.preset === "files")!;
    useStore.getState().assignToGroup(filed, preset.id);
    useStore.getState().dissolveGroup(preset.id);
    const s = useStore.getState();
    expect(s.groups.some((g) => g.id === preset.id)).toBe(true);
    expect(s.tabs.find((t) => t.id === filed)?.groupId).toBe(preset.id);
    useStore.getState().deleteGroup(preset.id);
    expect(useStore.getState().tabs.some((t) => t.id === filed)).toBe(false);
  });

  it("restores the tree shape across the doorway", async () => {
    const { parent, child, cTab } = makeTree();
    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    expect(s.groups.find((g) => g.id === child)?.parentId).toBe(parent);
    expect(s.groups.find((g) => g.id === parent)?.parentId).toBeUndefined();
    expect(s.tabs.find((t) => t.id === cTab)?.groupId).toBe(child);
  });
});

describe("promotion and demotion", () => {
  beforeEach(reset);

  const pinnedAt = (id: string) =>
    useStore.getState().tabs.find((t) => t.id === id)?.pinnedUrl;
  const groupOf = (id: string) =>
    useStore.getState().tabs.find((t) => t.id === id)?.groupId;

  it("filing a browser tab into a folder anchors it; sending it back clears", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "browser", url: "https://page.test/" });
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(id, preset.id);
    expect(groupOf(id)).toBe(preset.id);
    expect(pinnedAt(id)).toBe("https://page.test/");
    // Demotion: today again, home address gone.
    useStore.getState().assignToGroup(id, null);
    expect(groupOf(id)).toBeNull();
    expect(pinnedAt(id)).toBeUndefined();
  });

  it("dropping onto a grouped row promotes; onto a today row demotes", () => {
    const st = useStore.getState();
    const host = st.addTab({ type: "terminal" });
    const g = useStore.getState().createGroup("Target", host);
    const todayRow = useStore.getState().addTab({ type: "terminal" });
    const b = useStore.getState().addTab({ type: "browser", url: "https://drag.test/" });
    useStore.getState().moveTab(b, host);
    expect(groupOf(b)).toBe(g);
    expect(pinnedAt(b)).toBe("https://drag.test/");
    useStore.getState().moveTab(b, todayRow);
    expect(groupOf(b)).toBeNull();
    expect(pinnedAt(b)).toBeUndefined();
  });

  it("a multi-select drag promotes and demotes every carried row alike", () => {
    const st = useStore.getState();
    const host = st.addTab({ type: "terminal" });
    const g = useStore.getState().createGroup("Batch", host);
    const b1 = useStore.getState().addTab({ type: "browser", url: "https://one.test/" });
    const b2 = useStore.getState().addTab({ type: "browser", url: "https://two.test/" });
    useStore.getState().moveTabs([b1, b2], host);
    expect(groupOf(b1)).toBe(g);
    expect(groupOf(b2)).toBe(g);
    expect(pinnedAt(b1)).toBe("https://one.test/");
    expect(pinnedAt(b2)).toBe("https://two.test/");
    const todayRow = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().moveTabs([b1, b2], todayRow);
    expect(groupOf(b1)).toBeNull();
    expect(pinnedAt(b1)).toBeUndefined();
    expect(pinnedAt(b2)).toBeUndefined();
  });

  it("grouping into a brand-new folder is a promotion too", () => {
    const id = useStore
      .getState()
      .addTab({ type: "browser", url: "https://fresh.test/" });
    const g = useStore.getState().createGroup("Mine", id);
    expect(groupOf(id)).toBe(g);
    expect(pinnedAt(id)).toBe("https://fresh.test/");
  });

  it("keeps an anchor the user already chose when re-filing", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "browser", url: "https://home.test/" });
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(id, preset.id);
    // The page wanders; the anchor holds; moving between folders must not
    // silently re-anchor to wherever the page happens to be.
    useStore.getState().setTabUrl(id, "https://elsewhere.test/");
    const other = useStore.getState().addTab({ type: "terminal" });
    const g = useStore.getState().createGroup("Other", other);
    useStore.getState().assignToGroup(id, g);
    expect(pinnedAt(id)).toBe("https://home.test/");
    // pinTab is the explicit re-anchor (the menu's "update" action).
    useStore.getState().pinTab(id);
    expect(pinnedAt(id)).toBe("https://elsewhere.test/");
  });

  it("promotion anchors nothing on terminals, files, or blank browsers", () => {
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal" });
    const blank = useStore.getState().addTab({ type: "browser" });
    const termPreset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    const browserPreset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(term, termPreset.id);
    useStore.getState().assignToGroup(blank, browserPreset.id);
    expect(pinnedAt(term)).toBeUndefined();
    expect(pinnedAt(blank)).toBeUndefined();
    // And the explicit re-anchor refuses them just the same.
    useStore.getState().pinTab(term);
    useStore.getState().pinTab(blank);
    expect(pinnedAt(term)).toBeUndefined();
    expect(pinnedAt(blank)).toBeUndefined();
  });

  it("a promoted browser tab keeps its anchor across a restart", async () => {
    const id = useStore
      .getState()
      .addTab({ type: "browser", url: "https://kept.test/" });
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(id, preset.id);
    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    const back = useStore.getState().tabs.find((t) => t.id === id)!;
    expect(back.pinnedUrl).toBe("https://kept.test/");
    expect(back.groupId).toBe(preset.id);
  });
});

describe("today zone and auto-archive, all kinds", () => {
  beforeEach(reset);

  const HOUR = 60 * 60 * 1000;

  /** A today tab whose activity clock is turned back `idleMs`. */
  const idleTab = (
    partial: {
      type: "terminal" | "files" | "browser" | "settings" | "remote";
      url?: string;
      cwd?: string;
    },
    idleMs: number
  ) => {
    const id = useStore.getState().addTab(partial);
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: Date.now() - idleMs } : t
      ),
    }));
    return id;
  };

  it("archives stale today tabs of every kind, keeping their identity", () => {
    const page = idleTab({ type: "browser", url: "https://stale.test/" }, 25 * HOUR);
    const term = idleTab({ type: "terminal", cwd: "/tmp/work" }, 25 * HOUR);
    const files = idleTab({ type: "files", cwd: "/tmp/docs" }, 25 * HOUR);
    // Something else must be active — the tab in front is never taken.
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    const s = useStore.getState();
    expect(s.tabs.some((t) => t.id === page || t.id === term || t.id === files)).toBe(
      false
    );
    expect(s.archive.map((e) => e.id).sort()).toEqual([page, term, files].sort());
    const of = (id: string) => s.archive.find((e) => e.id === id)!;
    expect(of(page).type).toBe("browser");
    expect(of(page).url).toBe("https://stale.test/");
    expect(of(term).type).toBe("terminal");
    expect(of(term).cwd).toBe("/tmp/work");
    expect(of(files).cwd).toBe("/tmp/docs");
    expect(typeof of(page).archivedAt).toBe("number");
  });

  it("spares the filed, the active, the fresh, and the guard-protected", () => {
    const filed = idleTab({ type: "browser", url: "https://filed.test/" }, 25 * HOUR);
    useStore.getState().createGroup("mine", filed);
    const fresh = idleTab({ type: "browser", url: "https://fresh.test/" }, 1 * HOUR);
    const active = idleTab({ type: "browser", url: "https://active.test/" }, 25 * HOUR);
    useStore.getState().activateTab(active);
    // Activation stamps the clock, so turn it back again afterwards.
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === active ? { ...t, lastActiveAt: Date.now() - 25 * HOUR } : t
      ),
    }));
    useStore.getState().runArchiveScan();
    const ids = useStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain(filed);
    expect(ids).toContain(fresh);
    expect(ids).toContain(active);
    expect(useStore.getState().archive).toHaveLength(0);
  });

  it("guard matrix: busy terminal, fresh output, dirty files, settings, remote", () => {
    const busy = idleTab({ type: "terminal" }, 25 * HOUR);
    useStore.getState().setTabBusy(busy, true);
    const chatty = idleTab({ type: "terminal" }, 25 * HOUR);
    useStore.getState().setTabOutputAt(chatty, Date.now() - 1 * HOUR);
    const dirty = idleTab({ type: "files", cwd: "/tmp" }, 25 * HOUR);
    useStore.getState().setTabDirty(dirty, true);
    const settings = idleTab({ type: "settings" }, 25 * HOUR);
    const remote = idleTab({ type: "remote" }, 25 * HOUR);
    const blank = idleTab({ type: "browser" }, 25 * HOUR); // no page to bring back
    useStore.getState().addTab({ type: "terminal" }); // holds activation
    useStore.getState().runArchiveScan();
    const ids = useStore.getState().tabs.map((t) => t.id);
    for (const spared of [busy, chatty, dirty, settings, remote, blank]) {
      expect(ids).toContain(spared);
    }
    expect(useStore.getState().archive).toHaveLength(0);
  });

  it("an exited shell archives freely, busy flag and output age regardless", () => {
    const gone = idleTab({ type: "terminal", cwd: "/tmp" }, 25 * HOUR);
    // A shell can die mid-command; the stale busy flag must not shield it.
    useStore.getState().setTabBusy(gone, true);
    useStore.getState().setTabOutputAt(gone, Date.now() - 1 * HOUR);
    useStore.getState().markTabExited(gone);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    expect(useStore.getState().tabs.some((t) => t.id === gone)).toBe(false);
    expect(useStore.getState().archive.map((e) => e.id)).toEqual([gone]);
  });

  it("counts idleness against the configured threshold", () => {
    useStore.getState().setArchiveThreshold("12h");
    const young = idleTab({ type: "browser", url: "https://eleven.test/" }, 11 * HOUR);
    const old = idleTab({ type: "browser", url: "https://thirteen.test/" }, 13 * HOUR);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    const ids = useStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain(young);
    expect(ids).not.toContain(old);
  });

  it("the off setting archives nothing, however stale", () => {
    useStore.getState().setArchiveThreshold("off");
    const stale = idleTab({ type: "browser", url: "https://stale.test/" }, 24 * 30 * HOUR);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    expect(useStore.getState().tabs.some((t) => t.id === stale)).toBe(true);
    expect(useStore.getState().archive).toHaveLength(0);
  });

  it("keeps state files at archive time; eviction past 500 reclaims them", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: crypto.randomUUID(),
      type: "browser" as const,
      url: `https://old.test/${i}`,
      title: `old ${i}`,
      archivedAt: i,
    }));
    // The eventual eviction victim owns a state file.
    saveState(tabScope("files", full[0].id), { keep: "until eviction" });
    useStore.setState({ archive: full });
    const newest = idleTab({ type: "browser", url: "https://newest.test/" }, 25 * HOUR);
    saveState(tabScope("files", newest), { survives: "archiving" });
    useStore.getState().addTab({ type: "terminal" });
    await flushAll();
    useStore.getState().runArchiveScan();
    const archive = useStore.getState().archive;
    expect(archive).toHaveLength(500);
    expect(archive.some((e) => e.id === newest)).toBe(true);
    expect(archive.some((e) => e.url === "https://old.test/0")).toBe(false);
    expect(useStore.getState().archiveEvicted).toBe(1);
    await flushAll();
    const scopes = await listScopes();
    // Archiving kept the new tab's workspace; eviction reclaimed the old's.
    expect(scopes).toContain(`files:${newest}`);
    await vi.waitFor(async () => {
      expect(await listScopes()).not.toContain(`files:${full[0].id}`);
    });
  });

  it("restores an entry under its own id, on top of today, active", () => {
    const stale = idleTab({ type: "terminal", cwd: "/tmp/kept" }, 25 * HOUR);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    expect(useStore.getState().archive.map((e) => e.id)).toEqual([stale]);
    const revived = useStore.getState().unarchiveEntry(0);
    expect(revived).toBe(stale);
    const tab = useStore.getState().tabs.find((t) => t.id === revived)!;
    expect(tab.type).toBe("terminal");
    expect(tab.cwd).toBe("/tmp/kept");
    expect(tab.groupId).toBeNull();
    expect(useStore.getState().tabs[0].id).toBe(revived);
    expect(useStore.getState().activeTabId).toBe(revived);
    expect(useStore.getState().archive).toHaveLength(0);
  });

  it("row delete and clear-all empty the shelf and reclaim its workspaces", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    saveState(tabScope("files", a), { was: "archived" });
    saveState(tabScope("files", b), { was: "archived" });
    useStore.setState({
      archive: [
        { id: a, type: "browser", url: "https://a.test/", title: "a", archivedAt: 1 },
        { id: b, type: "browser", url: "https://b.test/", title: "b", archivedAt: 2 },
      ],
    });
    useStore.getState().removeArchiveEntry(0);
    expect(useStore.getState().archive.map((e) => e.url)).toEqual([
      "https://b.test/",
    ]);
    await vi.waitFor(async () => {
      expect(await listScopes()).not.toContain(`files:${a}`);
    });
    useStore.getState().clearArchive();
    expect(useStore.getState().archive).toHaveLength(0);
    await vi.waitFor(async () => {
      expect(await listScopes()).not.toContain(`files:${b}`);
    });
  });

  it("rides its own scope through the doorway and back", async () => {
    idleTab({ type: "browser", url: "https://persisted.test/" }, 25 * HOUR);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    await flushAll();
    expect(localStorage.getItem(`tabverse.state.${ARCHIVE_SCOPE}`)).not.toBeNull();

    useStore.setState({ archive: [] });
    await useStore.getState().restoreArchive();
    expect(useStore.getState().archive.map((e) => e.url)).toEqual([
      "https://persisted.test/",
    ]);
  });

 it("carries a -era archive forward as browser entries, zero loss", async () => {
    localStorage.setItem(
      `tabverse.state.${ARCHIVE_SCOPE}`,
      JSON.stringify([
        {
          url: "https://legacy.test/",
          title: "Legacy",
          groupId: "preset-browser",
          archivedAt: 42,
        },
      ])
    );
    await useStore.getState().restoreArchive();
    const [entry] = useStore.getState().archive;
    expect(entry.type).toBe("browser");
    expect(entry.url).toBe("https://legacy.test/");
    expect(entry.title).toBe("Legacy");
    expect(typeof entry.id).toBe("string");
  });

 it("the boot sweep counts archived ids as alive", async () => {
    const shelved = crypto.randomUUID();
    saveState(tabScope("terminal", shelved), { transcript: "kept" });
    saveState(
      ARCHIVE_SCOPE,
      [{ id: shelved, type: "terminal", title: "t", archivedAt: 1 }]
    );
    // The store's in-memory archive is empty on purpose: at boot the sweep
    // can run before the archive restore, and must still spare the shelf.
    useStore.setState({ archive: [] });
    await sweepOrphanTabState();
    await flushAll();
    expect(await listScopes()).toContain(`terminal:${shelved}`);
  });

  it("leaves the session, which is why forgetting one no longer resets it", async () => {
    useStore.getState().setArchiveThreshold("7d");
    useStore.getState().addTab({ type: "terminal" });
    const snapshot = sessionSnapshot(useStore.getState()) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(snapshot)).not.toContain("archiveThreshold");
    saveState(SESSION_SCOPE, snapshot);
    await flushAll();
    // A value the file would have supplied. Restoring must not touch it.
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      archiveThreshold: "12h",
    });
    expect(await useStore.getState().restoreSession()).toBe(true);
    expect(useStore.getState().archiveThreshold).toBe("12h");
  });
});

describe("the divider's Clear", () => {
  beforeEach(reset);

  it("shelves every archivable today tab at once, clocks notwithstanding", () => {
    const st = useStore.getState();
    const fresh = st.addTab({ type: "browser", url: "https://justnow.test/" });
    const term = useStore.getState().addTab({ type: "terminal", cwd: "/tmp" });
    const filed = useStore.getState().addTab({ type: "browser", url: "https://filed.test/" });
    useStore.getState().createGroup("mine", filed);
    const holder = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().activateTab(holder);
    useStore.getState().archiveAllToday();
    const s = useStore.getState();
    // Just-created tabs went: Clear is the user's explicit "put today
    // away", so idleness does not gate it.
    expect(s.tabs.some((t) => t.id === fresh || t.id === term)).toBe(false);
    // The filed tab is the user's arrangement and stays.
    expect(s.tabs.some((t) => t.id === filed)).toBe(true);
    expect(s.archive.map((e) => e.id).sort()).toEqual(
      [fresh, term, holder].sort()
    );
  });

  it("honours the state guards: busy, dirty, settings and remote stay", () => {
    const st = useStore.getState();
    const busy = st.addTab({ type: "terminal" });
    useStore.getState().setTabBusy(busy, true);
    const dirty = useStore.getState().addTab({ type: "files", cwd: "/tmp" });
    useStore.getState().setTabDirty(dirty, true);
    const settings = useStore.getState().addTab({ type: "settings" });
    const remote = useStore.getState().addTab({ type: "remote" });
    const going = useStore.getState().addTab({ type: "browser", url: "https://go.test/" });
    useStore.getState().archiveAllToday();
    const ids = useStore.getState().tabs.map((t) => t.id);
    for (const spared of [busy, dirty, settings, remote]) {
      expect(ids).toContain(spared);
    }
    expect(ids).not.toContain(going);
  });

  it("hands activation to the nearest survivor before taking the active tab", () => {
    const st = useStore.getState();
    const keeper = st.addTab({ type: "terminal" });
    useStore.getState().setTabBusy(keeper, true); // guarded, so it survives
    const active = useStore.getState().addTab({ type: "browser", url: "https://front.test/" });
    useStore.getState().activateTab(active);
    useStore.getState().archiveAllToday();
    const s = useStore.getState();
    expect(s.tabs.some((t) => t.id === active)).toBe(false);
    expect(s.activeTabId).toBe(keeper);
    expect(s.archive.some((e) => e.id === active)).toBe(true);
  });
});

describe("old-session compatibility and the two-zone migration", () => {
  beforeEach(reset);

 it("migrates a pre- session: custom stays, anchored stays, auto-filed moves to today", async () => {
    const old = {
      version: 1,
      tabs: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "terminal",
          title: "Terminal 1",
          groupId: "preset-terminal",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "browser",
          title: "Docs",
          groupId: "old-custom",
          url: "https://docs.test/",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          type: "browser",
          title: "Home",
          groupId: "preset-browser",
          url: "https://home.test/now",
          pinnedUrl: "https://home.test/",
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          type: "browser",
          title: "Passing",
          groupId: "preset-browser",
          url: "https://passing.test/",
        },
      ],
      groups: [
        {
          id: "preset-terminal",
          name: "Terminals",
          color: "#7aa2ff",
          collapsed: false,
          preset: "terminal",
        },
        { id: "old-custom", name: "Reading", color: "#52d98a", collapsed: false },
      ],
      activeTabId: "22222222-2222-4222-8222-222222222222",
    } satisfies Record<string, unknown>;
    localStorage.setItem(CARRIER_KEY, JSON.stringify(old));

    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    // Zero loss: every tab survived; only placement changed.
    expect(s.tabs).toHaveLength(4);
    const byTitle = (title: string) => s.tabs.find((t) => t.title === title)!;
    // Branch 1: a custom folder is the user's own arrangement.
    expect(byTitle("Docs").groupId).toBe("old-custom");
    // Branch 2: an anchored browser tab in a preset was promoted by hand.
    expect(byTitle("Home").groupId).toBe("preset-browser");
    expect(byTitle("Home").pinnedUrl).toBe("https://home.test/");
    // Branch 3: everything else in a preset was auto-filed — today now.
    expect(byTitle("Terminal 1").groupId).toBeNull();
    expect(byTitle("Passing").groupId).toBeNull();
    // The clock starts at restore, so nothing reads as idle-forever.
    expect(s.tabs.every((t) => typeof t.lastActiveAt === "number")).toBe(true);
    expect(s.archive).toHaveLength(0);
    expect(s.archiveThreshold).toBe("24h");
  });

  it("runs the migration once: a zones-marked session keeps promoted tabs put", async () => {
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal" });
    const preset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    useStore.getState().assignToGroup(term, preset.id);
    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    expect(
      useStore.getState().tabs.find((t) => t.id === term)?.groupId
    ).toBe(preset.id);
  });

 it("maps a pre- group's color value to its palette slot at restore", async () => {
    const old = {
      version: 1,
      zones: 3,
      tabs: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          type: "terminal",
          title: "Terminal 1",
          groupId: "legacy-exact",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          type: "terminal",
          title: "Terminal 2",
          groupId: "legacy-edited",
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          type: "terminal",
          title: "Terminal 3",
          groupId: "legacy-broken",
        },
      ],
      groups: [
        // A palette value as saved: an exact lookup.
        { id: "legacy-exact", name: "Amber", color: "#e0a458", collapsed: false },
        // A hand-edited off-palette value: nearest slot, not a crash.
        { id: "legacy-edited", name: "Lilac", color: "#c890e8", collapsed: false },
        // Not a color at all: the first slot, not a crash.
        { id: "legacy-broken", name: "Junk", color: "teal-ish", collapsed: false },
      ],
      activeTabId: null,
    } satisfies Record<string, unknown>;
    localStorage.setItem(CARRIER_KEY, JSON.stringify(old));

    expect(await useStore.getState().restoreSession()).toBe(true);
    const byId = (id: string) =>
      useStore.getState().groups.find((g) => g.id === id)!;
    // Slot order is the dark palette: 0 #93a6ff · 1 #55dc90 · 2 #e2a856 ·
    // 3 #cf9df0 · 4 #5fd6d6 · 5 #ff8f98 (2026-08-22 Deep Console recolor).
    expect(byId("legacy-exact").colorIndex).toBe(2);
    expect(byId("legacy-edited").colorIndex).toBe(3);
    expect(byId("legacy-broken").colorIndex).toBe(0);
    // The old field does not ride along into the live store.
    expect("color" in byId("legacy-exact")).toBe(false);
  });

  it("cuts a corrupt parent cycle loose instead of hiding its tabs", async () => {
    const cycled: PersistedState = {
      version: 1,
      tabs: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "terminal",
          title: "Trapped",
          groupId: "g-a",
        },
      ],
      groups: [
        { id: "g-a", name: "A", color: "#7aa2ff", collapsed: false, parentId: "g-b" },
        { id: "g-b", name: "B", color: "#52d98a", collapsed: false, parentId: "g-a" },
      ],
      activeTabId: null,
    };
    localStorage.setItem(CARRIER_KEY, JSON.stringify(cycled));
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    // Both ends of the cycle were cut to the root; the tab is reachable.
    expect(
      visibleOrdered(s.tabs, s.groups).some((t) => t.title === "Trapped")
    ).toBe(true);
  });
});

describe("pinned items: dormancy, wake and migration", () => {
  beforeEach(reset);

  const tabOf = (id: string) => useStore.getState().tabs.find((t) => t.id === id);

  it("closing a pinned tab turns it dormant in place, off every queue", async () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "terminal", cwd: "/tmp/work" });
    const preset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    useStore.getState().assignToGroup(id, preset.id);
    // A live runtime's traces, all of which must not survive into sleep.
    useStore.getState().setTabTermId(id, "pty-1");
    useStore.getState().setTabBusy(id, true);
    useStore.getState().setTabOutputAt(id, Date.now());
    useStore.getState().setAttention(id, true);
    saveState(tabScope("terminal", id), { transcript: "kept" });
    const queueBefore = useStore.getState().closedCount;

    useStore.getState().closeTab(id);
    const t = tabOf(id)!;
    expect(t.dormant).toBe(true);
    expect(t.groupId).toBe(preset.id);
    expect(t.cwd).toBe("/tmp/work"); // the payload stays
    expect(t.termId).toBeUndefined();
    expect(t.busy).toBeUndefined();
    expect(t.lastOutputAt).toBeUndefined();
    expect(t.attention).toBeUndefined();
    // Not closed in any bookkeeping sense: no reopen entry, no archive
    // entry, and the state files are exactly where waking will look.
    expect(useStore.getState().closedCount).toBe(queueBefore);
    expect(useStore.getState().archive).toHaveLength(0);
    await flushAll();
    expect(await listScopes()).toContain(`terminal:${id}`);
    // Closing again is a no-op, not a demotion or a deletion.
    useStore.getState().closeTab(id);
    expect(tabOf(id)?.dormant).toBe(true);
  });

  it("a dormant browser item snaps home, and waking finds it at its pinned address", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "browser", url: "https://home.test/" });
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(id, preset.id);
    useStore.getState().setTabUrl(id, "https://elsewhere.test/deep");
    useStore.getState().closeTab(id);
    expect(tabOf(id)?.url).toBe("https://home.test/");
    expect(tabOf(id)?.pinnedUrl).toBe("https://home.test/");
    expect(tabOf(id)?.dormant).toBe(true);

    useStore.getState().activateTab(id);
    expect(tabOf(id)?.dormant).toBeUndefined();
    expect(useStore.getState().activeTabId).toBe(id);
  });

  it("closing a today tab still really closes it", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "terminal" });
    const queueBefore = useStore.getState().closedCount;
    useStore.getState().closeTab(id);
    expect(useStore.getState().tabs.some((t) => t.id === id)).toBe(false);
    expect(useStore.getState().closedCount).toBe(queueBefore + 1);
    expect(useStore.getState().reopenClosedTab()).toBe(id);
  });

  it("closing the active pinned tab hands focus to a row that has a pane", () => {
    const st = useStore.getState();
    const pinned = st.addTab({ type: "terminal" });
    const preset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    useStore.getState().assignToGroup(pinned, preset.id);
    const today = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().activateTab(pinned);
    useStore.getState().closeTab(pinned);
    expect(tabOf(pinned)?.dormant).toBe(true);
    // Never a dormant tab: that would put a paneless row in front.
    expect(useStore.getState().activeTabId).toBe(today);
  });

  it("unpinning a dormant item wakes it into the today zone, anchor gone", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "browser", url: "https://home.test/" });
    const preset = useStore.getState().groups.find((g) => g.preset === "browser")!;
    useStore.getState().assignToGroup(id, preset.id);
    useStore.getState().closeTab(id);
    expect(tabOf(id)?.dormant).toBe(true);
    // The today zone has no dormant state, so leaving the pinned zone IS
    // materializing — by menu Unpin and by drag alike (both demote).
    useStore.getState().assignToGroup(id, null);
    const t = tabOf(id)!;
    expect(t.groupId).toBeNull();
    expect(t.dormant).toBeUndefined();
    expect(t.pinnedUrl).toBeUndefined();
  });

  it("restart restores wake state exactly as left (2026-08-21 requirement): nothing auto-sleeps, manual sleep persists", async () => {
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal", cwd: "/tmp/kept" });
    const termPreset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    useStore.getState().assignToGroup(term, termPreset.id);
    const page = useStore.getState().addTab({ type: "browser", url: "https://home.test/" });
    useStore.getState().createGroup("mine", page); // anchors at home
    useStore.getState().setTabUrl(page, "https://wandered.test/"); // then wanders
    const today = useStore.getState().addTab({ type: "files", cwd: "/tmp/docs" });
    // A SECOND pinned terminal, manually slept via its own folder's close.
    const slept = useStore.getState().addTab({ type: "terminal" });
    const sleepGroup = useStore.getState().createGroup("snooze", slept);
    useStore.getState().closeGroup(sleepGroup);
    // The saved active tab is pinned and awake.
    useStore.getState().activateTab(term);

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    // Awake pins restore awake — no auto-sleep, active keeps the seat.
    expect(s.tabs.find((t) => t.id === term)?.dormant).toBeUndefined();
    expect(s.activeTabId).toBe(term);
    // An awake wandered page stays where it wandered (as left).
    expect(s.tabs.find((t) => t.id === page)?.dormant).toBeUndefined();
    expect(s.tabs.find((t) => t.id === page)?.url).toBe("https://wandered.test/");
    // MANUAL sleep persisted through the dormant field.
    expect(s.tabs.find((t) => t.id === slept)?.dormant).toBe(true);
    expect(s.tabs.find((t) => t.id === today)?.dormant).toBeUndefined();
  });


  it("Update pinned address for a files tab re-anchors on its live browsing directory", () => {
    const st = useStore.getState();
    const files = st.addTab({ type: "files", cwd: "/Users/x/old" });
    useStore.getState().createGroup("work", files);
    // The FilesView reports the active pane's root, which may differ from
    // the tab's spawn-time cwd after the user has browsed elsewhere.
    st.setFilesOpenDir(files, "/Users/x/new");
    st.pinTab(files);
    expect(useStore.getState().tabs.find((t) => t.id === files)?.cwd).toBe(
      "/Users/x/new"
    );
  });
 it("backfills a zones-2 session's pinned payloads once", async () => {
    localStorage.setItem(
      CARRIER_KEY,
      JSON.stringify({
        version: 1,
        zones: 2,
        tabs: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            type: "browser",
            title: "Docs",
            groupId: "preset-browser",
            url: "https://docs.test/page",
          },
          {
            id: "77777777-7777-4777-8777-777777777777",
            type: "terminal",
            title: "Work",
            groupId: "preset-terminal",
            cwd: "/tmp/work",
          },
          {
            id: "88888888-8888-4888-8888-888888888888",
            type: "browser",
            title: "Today page",
            groupId: null,
            url: "https://today.test/",
          },
        ],
        groups: [],
        activeTabId: "88888888-8888-4888-8888-888888888888",
      })
    );
    expect(await useStore.getState().restoreSession()).toBe(true);
    const s = useStore.getState();
    expect(s.tabs).toHaveLength(3); // zero loss
    const byTitle = (title: string) => s.tabs.find((t) => t.title === title)!;
    // The payload came from where the tab was; placement did not change.
    expect(byTitle("Docs").pinnedUrl).toBe("https://docs.test/page");
    expect(byTitle("Docs").groupId).toBe("preset-browser");
    expect(byTitle("Docs").dormant).toBeUndefined();
    expect(byTitle("Work").cwd).toBe("/tmp/work");
    expect(byTitle("Work").dormant).toBeUndefined();
    // A today tab gains nothing and sleeps never.
    expect(byTitle("Today page").pinnedUrl).toBeUndefined();
    expect(byTitle("Today page").dormant).toBeUndefined();
  });

  it("writes the zones-3 marker, so the backfill cannot run twice", () => {
    useStore.getState().addTab({ type: "terminal" });
    expect(sessionSnapshot(useStore.getState()).zones).toBe(3);
  });

 it("archive scan and Clear never touch pinned items, in either state", () => {
    const HOUR = 60 * 60 * 1000;
    const st = useStore.getState();
    const awake = st.addTab({ type: "terminal", cwd: "/tmp" });
    const preset = useStore.getState().groups.find((g) => g.preset === "terminal")!;
    useStore.getState().assignToGroup(awake, preset.id);
    const asleep = useStore.getState().addTab({ type: "files", cwd: "/tmp" });
    const filesPreset = useStore.getState().groups.find((g) => g.preset === "files")!;
    useStore.getState().assignToGroup(asleep, filesPreset.id);
    useStore.getState().closeTab(asleep);
    const goes = useStore.getState().addTab({ type: "browser", url: "https://stale.test/" });
    const holder = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().activateTab(holder);
    // Turn every clock far past any threshold: only the today tab may go.
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, lastActiveAt: Date.now() - 999 * HOUR })),
    }));
    useStore.getState().runArchiveScan();
    let ids = useStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain(awake);
    expect(ids).toContain(asleep);
    expect(ids).not.toContain(goes);
    expect(useStore.getState().archive.map((e) => e.id)).toEqual([goes]);
    useStore.getState().archiveAllToday();
    ids = useStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain(awake);
    expect(ids).toContain(asleep);
  });

 it("the boot sweep counts dormant items as alive", async () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "files", cwd: "/tmp" });
    const preset = useStore.getState().groups.find((g) => g.preset === "files")!;
    useStore.getState().assignToGroup(id, preset.id);
    saveState(tabScope("files", id), { root: "/tmp" });
    useStore.getState().closeTab(id);
    expect(useStore.getState().tabs.find((t) => t.id === id)?.dormant).toBe(true);
    await sweepOrphanTabState();
    await flushAll();
    // Asleep is not dead: the workspace is exactly what waking reattaches.
    expect(await listScopes()).toContain(`files:${id}`);
  });
});

// Last on purpose: markFreshRun flips module state for the rest of the file.
describe("fresh run", () => {
  it("stops persisting so a test launch cannot overwrite the saved session", async () => {
    await reset();
    useStore.getState().addTab({ type: "terminal" });
    await flushAll();
    const saved = localStorage.getItem(CARRIER_KEY);
    expect(saved).not.toBeNull();

    markFreshRun();
    useStore.getState().addTab({ type: "terminal" });
    await flushAll();
    expect(localStorage.getItem(CARRIER_KEY)).toBe(saved);
  });
});

describe("a group made as a place, before it holds anything", () => {
  it("survives being empty, where a group made from a tab does not", () => {
    const s = useStore.getState();
    const made = s.createEmptyGroup();
    // The sweep that removes by-product groups runs on every commit, so a
    // single further change is enough to prove it is spared.
    useStore.getState().addTab({ type: "terminal" });
    expect(useStore.getState().groups.some((g) => g.id === made)).toBe(true);

    // The other kind still goes: grouping a tab and then taking it out
    // leaves nothing behind.
    const tab = useStore.getState().addTab({ type: "terminal" });
    const byProduct = useStore.getState().createGroup("From a tab", tab);
    useStore.getState().assignToGroup(tab, null);
    expect(useStore.getState().groups.some((g) => g.id === byProduct)).toBe(false);
  });

  it("opens ready to be named, and gets a name nothing else has", () => {
    const first = useStore.getState().createEmptyGroup();
    expect(useStore.getState().namingGroupId).toBe(first);
    const second = useStore.getState().createEmptyGroup();
    const names = useStore
      .getState()
      .groups.filter((g) => g.id === first || g.id === second)
      .map((g) => g.name);
    expect(new Set(names).size).toBe(2);
  });

  it("is written to the session, so it is still there after a restart", () => {
    const made = useStore.getState().createEmptyGroup();
    const saved = sessionSnapshot(useStore.getState());
    expect(saved.groups.some((g) => g.id === made)).toBe(true);
  });
});

describe("moving several tabs at once", () => {
  it("keeps the order they had between them", () => {
    const a = useStore.getState().addTab({ type: "terminal" });
    const b = useStore.getState().addTab({ type: "terminal" });
    const c = useStore.getState().addTab({ type: "terminal" });
    // New tabs prepend, so the list reads c, b, a. Moving b and a to the
    // end must land them still reading b, then a — a drag never shuffles
    // what it carries.
    useStore.getState().moveTabs([a, b], null);
    const order = useStore.getState().tabs.map((t) => t.id);
    expect(order.indexOf(a)).toBe(order.indexOf(b) + 1);
    expect(order[order.length - 1]).toBe(a);
    expect(order).toContain(c);
  });

  it("takes the group of whatever they were dropped on", () => {
    const host = useStore.getState().addTab({ type: "terminal" });
    const g = useStore.getState().createGroup("Target", host);
    const a = useStore.getState().addTab({ type: "terminal", groupId: null });
    const b = useStore.getState().addTab({ type: "terminal", groupId: null });
    useStore.getState().moveTabs([a, b], host);
    const inGroup = useStore
      .getState()
      .tabs.filter((t) => t.groupId === g)
      .map((t) => t.id);
    expect(inGroup).toContain(a);
    expect(inGroup).toContain(b);
  });

  it("a range counts in the order the sidebar draws, not the array's", () => {
    const st = useStore.getState();
    const first = st.addTab({ type: "terminal" });
    const mid = st.addTab({ type: "terminal" });
    const last = st.addTab({ type: "terminal" });
    useStore.getState().toggleSelected(first);
    useStore.getState().extendSelectionTo(last);
    const picked = useStore.getState().selectedTabIds;
    expect(picked).toContain(first);
    expect(picked).toContain(mid);
    expect(picked).toContain(last);
  });
});

describe("the page's give-way line", () => {
  // Pure geometry: how far the sidebar's layer reaches over the content
  // area, which is exactly how much the active native page must yield.
  const at = (
    over: Partial<{
      sidebarPinned: boolean;
      sidebarPeeking: boolean;
      sidebarWidth: number;
      folderPreviewGroupId: string | null;
      pageFreeze: { tabId: string; src: string } | null;
    }>
  ) =>
    contentObstructionX({
      sidebarPinned: true,
      sidebarPeeking: false,
      sidebarWidth: 248,
      folderPreviewGroupId: null,
      pageFreeze: null,
      ...over,
    });

  const shot = { tabId: "t1", src: "data:image/png;base64,x" };

  it("pinned, no panel: the page never occupied the column — zero", () => {
    expect(at({})).toBe(0);
  });

  it("unpinned and hidden: nothing floats over the pane", () => {
    expect(at({ sidebarPinned: false })).toBe(0);
  });

 it("peeking sidebar, not yet frozen: the page holds still — no give-way", () => {
    // A bare peek never shoves the page any more: before the snapshot lands
    // (or if it never does) the page stays exactly where it is, so neither a
    // steady state nor a transition frame translates it. This is the fix for
    // the peek's lingering slide — the give-way that produced it is gone.
    expect(at({ sidebarPinned: false, sidebarPeeking: true })).toBe(0);
  });

 it("peeking sidebar, frozen: the page holds still behind its snapshot — zero", () => {
    expect(
      at({ sidebarPinned: false, sidebarPeeking: true, pageFreeze: shot })
    ).toBe(0);
  });

 it("panel open and frozen: the page does not move", () => {
    expect(at({ folderPreviewGroupId: "g", pageFreeze: shot })).toBe(0);
    expect(
      at({
        sidebarPinned: false,
        sidebarPeeking: true,
        folderPreviewGroupId: "g",
        pageFreeze: shot,
      })
    ).toBe(0);
  });

  it("panel open, snapshot failed: the give-way path carries both the sidebar and the panel", () => {
    // Pinned: only the panel reaches past the sidebar's own column.
    expect(at({ folderPreviewGroupId: "g" })).toBe(248 + FOLDER_PREVIEW_WIDTH);
    // Unpinned: the floating sidebar's width plus the panel's.
    expect(
      at({ sidebarPinned: false, sidebarPeeking: true, folderPreviewGroupId: "g" })
    ).toBe(248 + FOLDER_PREVIEW_WIDTH);
    // Unpinned, pointer off the rail but the open panel still holds it out.
    expect(
      at({ sidebarPinned: false, sidebarPeeking: false, folderPreviewGroupId: "g" })
    ).toBe(248 + FOLDER_PREVIEW_WIDTH);
  });
});

describe("the snapshot freeze's lifecycle", () => {
  beforeEach(reset);
  const shot = { tabId: "t1", src: "data:image/png;base64,x" };

  it("closing the panel releases the freeze when nothing else holds it", () => {
    const st = useStore.getState();
    st.setFolderPreview("g");
    st.setPageFreeze(shot);
    useStore.getState().setFolderPreview(null);
    const s = useStore.getState();
    // An image left behind would keep the real page parked forever.
    expect(s.folderPreviewGroupId).toBeNull();
    expect(s.pageFreeze).toBeNull();
  });

  it("moving the panel to another folder keeps the freeze — the page is parked, re-shooting it would frame a blank", () => {
    const st = useStore.getState();
    st.setFolderPreview("g1");
    st.setPageFreeze(shot);
    useStore.getState().setFolderPreview("g2");
    const s = useStore.getState();
    expect(s.folderPreviewGroupId).toBe("g2");
    expect(s.pageFreeze).not.toBeNull();
  });

  it("switching tabs past the panel closes it and releases the freeze", () => {
    const st = useStore.getState();
    const a = st.addTab({ type: "terminal" });
    useStore.getState().setFolderPreview("g");
    useStore.getState().setPageFreeze(shot);
    useStore.getState().activateTab(a);
    const s = useStore.getState();
    // The freeze belonged to the page that was in front; a newly fronted
    // page would paint straight over a panel left open.
    expect(s.folderPreviewGroupId).toBeNull();
    expect(s.pageFreeze).toBeNull();
  });

 it("the peek and the panel share one freeze: whichever leaves last releases it", () => {
    const st = useStore.getState();
    // The peek froze the page; then the panel opened over the same freeze.
    st.setSidebarPeeking(true);
    st.setPageFreeze(shot);
    useStore.getState().setFolderPreview("g");
    // The panel closes but the sidebar is still peeking — the freeze stays.
    useStore.getState().setFolderPreview(null);
    expect(useStore.getState().pageFreeze).not.toBeNull();
    // The sidebar peeks back in — now nothing holds it, so it releases.
    useStore.getState().setSidebarPeeking(false);
    expect(useStore.getState().pageFreeze).toBeNull();
  });

  it("peeking back in with the panel still open leaves the panel's freeze alone", () => {
    const st = useStore.getState();
    st.setSidebarPeeking(true);
    st.setPageFreeze(shot);
    useStore.getState().setFolderPreview("g");
    // Pointer slides off the rail onto the open panel: peeking clears, but the
    // panel still wants the page frozen underneath it.
    useStore.getState().setSidebarPeeking(false);
    expect(useStore.getState().pageFreeze).not.toBeNull();
  });
});

describe("search engine setting", () => {
  beforeEach(async () => {
    await reset();
    useStore.setState({ searchEngine: "duckduckgo", customSearchTemplate: "" });
  });

  it("leaves the session: neither the engine nor the template is written there", async () => {
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().setSearchEngine("custom", "https://s.test/?q=%s");
    // Written through the doorway directly: by this point in the file an
    // earlier test has marked the run fresh, which silences the store's own
    // persist — the shape under test is the snapshot itself.
    const snapshot = sessionSnapshot(useStore.getState()) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(snapshot)).not.toContain("searchEngine");
    expect(Object.keys(snapshot)).not.toContain("customSearchTemplate");
    expect(JSON.stringify(snapshot)).not.toContain("s.test");
    saveState(SESSION_SCOPE, snapshot);
    await flushAll();
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      searchEngine: "google",
      customSearchTemplate: "https://from-the-file.test/?q=%s",
    });
    expect(await useStore.getState().restoreSession()).toBe(true);
    expect(useStore.getState().searchEngine).toBe("google");
    expect(useStore.getState().customSearchTemplate).toBe(
      "https://from-the-file.test/?q=%s"
    );
  });

  it("keeps the stored template while a built-in engine is selected", () => {
    useStore.getState().setSearchEngine("custom", "https://s.test/?q=%s");
    useStore.getState().setSearchEngine("google");
    expect(useStore.getState().customSearchTemplate).toBe("https://s.test/?q=%s");
  });

  it("ignores an old session's engine rather than letting it win over the file", async () => {
    useStore.getState().addTab({ type: "terminal" });
    // A session written before the configuration file still carries these
    // two fields. Restore must walk past them: the migration is what reads
    // them, once, and it only writes where the file has said nothing.
    const old = {
      ...sessionSnapshot(useStore.getState()),
      searchEngine: "bing" as const,
      customSearchTemplate: "https://stale.test/?q=%s",
    };
    saveState(SESSION_SCOPE, old);
    await flushAll();
    useStore.setState({
      tabs: [],
      groups: withPresetGroups([]),
      activeTabId: null,
      searchEngine: "custom",
      customSearchTemplate: "https://from-the-file.test/?q=%s",
    });
    expect(await useStore.getState().restoreSession()).toBe(true);
    expect(useStore.getState().searchEngine).toBe("custom");
    expect(useStore.getState().customSearchTemplate).toBe(
      "https://from-the-file.test/?q=%s"
    );
  });
});

describe("the command bar is an overlay", () => {
  beforeEach(reset);

  it("counts toward anyOverlayOpen, so a browser page parks under it", () => {
    expect(anyOverlayOpen(useStore.getState())).toBe(false);
    useStore.getState().setCommandBar(true);
    expect(anyOverlayOpen(useStore.getState())).toBe(true);
    useStore.getState().setCommandBar(false);
    expect(anyOverlayOpen(useStore.getState())).toBe(false);
  });
});

describe("revealing a path from a tool call", () => {
  beforeEach(reset);

  it("opens a files tab when nothing is rooted above the file", () => {
    const st = useStore.getState();
    st.revealPath("/work/api/src/main.rs", 12);

    const tabs = useStore.getState().tabs.filter((t) => t.type === "files");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].cwd).toBe("/work/api/src");
    expect(tabs[0].reveal).toEqual({
      path: "/work/api/src/main.rs",
      line: 12,
      nonce: 1,
    });
  });

  it("reuses the tab already rooted above the file instead of opening another", () => {
    const st = useStore.getState();
    const existing = st.addTab({ type: "files", cwd: "/work/api" });
    st.addTab({ type: "terminal" });

    useStore.getState().revealPath("/work/api/src/main.rs", 3);

    const s = useStore.getState();
    expect(s.tabs.filter((t) => t.type === "files")).toHaveLength(1);
    expect(s.activeTabId).toBe(existing);
    expect(s.tabs.find((t) => t.id === existing)?.reveal?.line).toBe(3);
  });

  it("a second reference to the same file lands again rather than being swallowed", () => {
    // The whole reason `reveal` carries a nonce: the path is unchanged, so an
    // effect keyed on the path alone would ignore every reference after the
    // first — which is exactly what an agent does, repeatedly.
    const st = useStore.getState();
    const existing = st.addTab({ type: "files", cwd: "/work" });

    useStore.getState().revealPath("/work/a.rs", 1);
    useStore.getState().revealPath("/work/a.rs", 40);

    const s = useStore.getState();
    expect(s.tabs.filter((t) => t.type === "files")).toHaveLength(1);
    const reveal = s.tabs.find((t) => t.id === existing)?.reveal;
    expect(reveal?.nonce).toBe(2);
    expect(reveal?.line).toBe(40);
  });

  it("prefers the deepest root when several tabs contain the file", () => {
    const st = useStore.getState();
    st.addTab({ type: "files", cwd: "/work" });
    const inner = useStore.getState().addTab({ type: "files", cwd: "/work/api" });

    useStore.getState().revealPath("/work/api/src/main.rs");

    expect(useStore.getState().activeTabId).toBe(inner);
  });

  it("does not mistake a sibling directory for a parent", () => {
    const st = useStore.getState();
    st.addTab({ type: "files", cwd: "/work/api" });

    useStore.getState().revealPath("/work/api-docs/readme.md");

    const files = useStore.getState().tabs.filter((t) => t.type === "files");
    expect(files).toHaveLength(2);
    expect(files.some((t) => t.cwd === "/work/api-docs")).toBe(true);
  });

  it("wakes a shelved tab rather than letting the request vanish", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "files", cwd: "/work" });
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dormant: true as const } : t)),
    }));

    useStore.getState().revealPath("/work/a.rs");

    const tab = useStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.dormant).toBeUndefined();
    expect(tab?.reveal?.path).toBe("/work/a.rs");
  });
});

describe("where a new agent tab works", () => {
  beforeEach(reset);

  // Found by running the built app: the menu says "a coding agent working in a
  // folder" but never asked which, so it fell back to the home directory and
  // the agent's first glob walked the whole home tree for three minutes.

  it("inherits the folder of the tab the user is looking at", () => {
    const st = useStore.getState();
    const files = st.addTab({ type: "files", cwd: "/work/api" });
    expect(useStore.getState().activeTabId).toBe(files);

    const agent = useStore.getState().addTab({ type: "agent" });

    expect(useStore.getState().tabs.find((t) => t.id === agent)?.cwd).toBe("/work/api");
  });

  it("falls back to the most recently used folder when the active tab has none", () => {
    const st = useStore.getState();
    st.addTab({ type: "files", cwd: "/work/api" });
    // A browser tab stands for no directory, so it cannot answer the question.
    useStore.getState().addTab({ type: "browser", url: "https://example.com" });

    const agent = useStore.getState().addTab({ type: "agent" });

    expect(useStore.getState().tabs.find((t) => t.id === agent)?.cwd).toBe("/work/api");
  });

  it("leaves cwd unset when nothing in the window stands for a folder", () => {
    // Undefined, not a guess: AgentView keeps its own fallback and the user
    // sees whatever it lands on.
    const agent = useStore.getState().addTab({ type: "agent" });
    expect(useStore.getState().tabs.find((t) => t.id === agent)?.cwd).toBeUndefined();
  });

  it("never overrides a folder the caller named", () => {
    const st = useStore.getState();
    st.addTab({ type: "files", cwd: "/work/api" });

    const agent = useStore.getState().addTab({ type: "agent", cwd: "/elsewhere" });

    expect(useStore.getState().tabs.find((t) => t.id === agent)?.cwd).toBe("/elsewhere");
  });

  it("does not hand a folder to tab types that did not ask for one", () => {
    const st = useStore.getState();
    st.addTab({ type: "files", cwd: "/work/api" });

    const browser = useStore.getState().addTab({ type: "browser" });

    expect(useStore.getState().tabs.find((t) => t.id === browser)?.cwd).toBeUndefined();
  });

  describe("inheritedCwd", () => {
    const tab = (id: string, type: string, cwd?: string, lastActiveAt?: number) =>
      ({ id, type, cwd, lastActiveAt }) as Parameters<typeof inheritedCwd>[0][number];

    it("prefers the active tab over a more recently used one", () => {
      const tabs = [
        tab("a", "files", "/active", 1),
        tab("b", "terminal", "/recent", 999),
      ];
      expect(inheritedCwd(tabs, "a")).toBe("/active");
    });

    it("takes the newest by use when the active tab is not rooted anywhere", () => {
      const tabs = [
        tab("browser", "browser", undefined, 999),
        tab("old", "files", "/old", 1),
        tab("new", "terminal", "/new", 5),
      ];
      expect(inheritedCwd(tabs, "browser")).toBe("/new");
    });

    it("answers undefined rather than inventing a directory", () => {
      expect(inheritedCwd([tab("b", "browser", undefined, 1)], "b")).toBeUndefined();
      expect(inheritedCwd([], null)).toBeUndefined();
    });
  });
});

describe("putting an agent's command in a terminal", () => {
  beforeEach(reset);

  it("uses the terminal already rooted under the agent's folder", () => {
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal", cwd: "/work/api" });
    st.addTab({ type: "browser", url: "https://example.com" });

    useStore.getState().showCommand("cargo test", "/work/api");

    const s = useStore.getState();
    expect(s.tabs.filter((t) => t.type === "terminal")).toHaveLength(1);
    expect(s.activeTabId).toBe(term);
    expect(s.tabs.find((t) => t.id === term)?.command).toEqual({
      text: "cargo test",
      nonce: 1,
    });
  });

  it("prefers the deepest terminal when several contain the folder", () => {
    const st = useStore.getState();
    st.addTab({ type: "terminal", cwd: "/work" });
    const inner = useStore.getState().addTab({ type: "terminal", cwd: "/work/api" });

    useStore.getState().showCommand("cargo test", "/work/api");

    expect(useStore.getState().activeTabId).toBe(inner);
  });

  it("opens a terminal in the right folder when there is none", () => {
    useStore.getState().showCommand("cargo test", "/work/api");

    const terminals = useStore.getState().tabs.filter((t) => t.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].cwd).toBe("/work/api");
    expect(terminals[0].command?.text).toBe("cargo test");
  });

  it("lands the same command again rather than being swallowed", () => {
    // An agent runs the same test command over and over; an effect keyed on the
    // text alone would ignore every one after the first.
    const st = useStore.getState();
    const term = st.addTab({ type: "terminal", cwd: "/work" });

    useStore.getState().showCommand("cargo test", "/work");
    useStore.getState().showCommand("cargo test", "/work");

    expect(useStore.getState().tabs.find((t) => t.id === term)?.command?.nonce).toBe(2);
  });

  it("wakes a shelved terminal rather than letting the command vanish", () => {
    const st = useStore.getState();
    const id = st.addTab({ type: "terminal", cwd: "/work" });
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dormant: true as const } : t)),
    }));

    useStore.getState().showCommand("ls", "/work");

    const tab = useStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.dormant).toBeUndefined();
    expect(tab?.command?.text).toBe("ls");
  });

  it("does not hijack a terminal sitting in an unrelated folder", () => {
    const st = useStore.getState();
    st.addTab({ type: "terminal", cwd: "/somewhere/else" });

    useStore.getState().showCommand("cargo test", "/work/api");

    const terminals = useStore.getState().tabs.filter((t) => t.type === "terminal");
    expect(terminals).toHaveLength(2);
    expect(terminals.some((t) => t.cwd === "/work/api")).toBe(true);
  });

  it("is not carried across a restart", () => {
    // Same reason runOnStart is not: a command nobody asked for should not be
    // waiting in a terminal after reopening the app.
    const st = useStore.getState();
    st.addTab({ type: "terminal", cwd: "/work" });
    useStore.getState().showCommand("rm -rf build", "/work");

    const saved = sessionSnapshot(useStore.getState());
    expect(saved.tabs.every((t) => !("command" in t))).toBe(true);
  });
});

describe("an agent tab's lifecycle", () => {
  beforeEach(reset);

  const HOUR = 60 * 60 * 1000;

  const idleAgent = (idleMs: number, busy: boolean) => {
    const id = useStore.getState().addTab({ type: "agent" });
    useStore.getState().setTabBusy(id, busy);
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: Date.now() - idleMs } : t,
      ),
    }));
    return id;
  };

  it("never shelves an agent that is mid-run", () => {
    // The pane is the runtime: shelving one that is working kills the work.
    const working = idleAgent(25 * HOUR, true);
    useStore.getState().addTab({ type: "terminal" }); // something else in front

    useStore.getState().runArchiveScan();

    expect(useStore.getState().tabs.map((t) => t.id)).toContain(working);
    expect(useStore.getState().archive).toHaveLength(0);
  });

  it("shelves an idle one, keeping the identity its log is filed under", () => {
    const idle = idleAgent(25 * HOUR, false);
    useStore.getState().addTab({ type: "terminal" });

    useStore.getState().runArchiveScan();

    const s = useStore.getState();
    expect(s.tabs.map((t) => t.id)).not.toContain(idle);
    const entry = s.archive.find((e) => e.id === idle);
    expect(entry?.type).toBe("agent");
    // The id is what the session log is named after, so waking it has to bring
    // back the same id or the history is orphaned.
    expect(entry?.id).toBe(idle);
  });

  it("becomes shelvable again once the run ends", () => {
    const id = idleAgent(25 * HOUR, true);
    useStore.getState().addTab({ type: "terminal" });
    useStore.getState().runArchiveScan();
    expect(useStore.getState().tabs.map((t) => t.id)).toContain(id);

    // The turn finishes; the view reports it.
    useStore.getState().setTabBusy(id, false);
    useStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: Date.now() - 25 * HOUR } : t,
      ),
    }));
    useStore.getState().runArchiveScan();

    expect(useStore.getState().tabs.map((t) => t.id)).not.toContain(id);
  });

  it("does not carry busy across a restart", () => {
    // busy describes a live process. Persisting it would leave a tab that can
    // never be shelved after a crash mid-run.
    const id = idleAgent(1 * HOUR, true);
    const saved = sessionSnapshot(useStore.getState());
    expect(saved.tabs.find((t) => t.id === id)).toBeDefined();
    expect(saved.tabs.every((t) => !("busy" in t))).toBe(true);
  });
});

describe("a split tab's busy is the union of its panes", () => {
  beforeEach(reset);

  it("an idle sibling's report does not unbusy a running pane", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    const other = useStore.getState().splitTerminalPane(id, false)!;
    // The pane wearing the tab's id runs; the sibling reports idle last —
    // the exact order that used to write `false` over a live `true`.
    useStore.getState().setPaneBusy(id, id, true);
    useStore.getState().setPaneBusy(id, other, false);

    const tab = useStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.busy).toBe(true);
    expect(useStore.getState().busyPanes[id]).toEqual({ [id]: true });
  });

  it("busy clears only when the last running pane reports idle", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    const other = useStore.getState().splitTerminalPane(id, false)!;

    useStore.getState().setPaneBusy(id, id, true);
    useStore.getState().setPaneBusy(id, other, true);
    useStore.getState().setPaneBusy(id, id, false);
    expect(useStore.getState().tabs.find((t) => t.id === id)!.busy).toBe(true);

    useStore.getState().setPaneBusy(id, other, false);
    expect(useStore.getState().tabs.find((t) => t.id === id)!.busy).toBe(false);
    // An empty record leaves no trace: the map holds only tabs with a
    // running pane, so a closed tab cannot be held busy by a stale entry.
    expect(useStore.getState().busyPanes[id]).toBeUndefined();
  });

  it("clearing the tab-level flag drops the per-pane records it is the union of", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    const other = useStore.getState().splitTerminalPane(id, false)!;
    useStore.getState().setPaneBusy(id, id, true);
    useStore.getState().setPaneBusy(id, other, true);

    // The shell died mid-command: TerminalView clears the tab-level flag,
    // and a stale per-pane entry must not resurrect `busy` on the next flip.
    useStore.getState().setTabBusy(id, false);
    expect(useStore.getState().tabs.find((t) => t.id === id)!.busy).toBe(false);
    expect(useStore.getState().busyPanes[id]).toBeUndefined();
  });
});

describe("an unread sidebar width decides nothing (the peek settles)", () => {
  it("a pointer report against a width that never arrived is not past anything", () => {
    // The width lived in the session blob once — always a number — and the
    // settle closed the peeking sidebar on every report. The width is the
    // configuration file's now, and until it is read the settle must stay
    // quiet, or the sidebar snaps back mid-slide (the 0.0.5 regression).
    expect(pointerPastSidebar(1200, null)).toBe(false);
    expect(pointerPastSidebar(undefined, null)).toBe(false);
    expect(pointerPastSidebar(null, null)).toBe(false);
  });

  it("a page that cannot report an x decides nothing, width or not", () => {
    expect(pointerPastSidebar(undefined, 248)).toBe(false);
    expect(pointerPastSidebar(null, 248)).toBe(false);
  });

  it("with both numbers, the 8px grace band holds as it always did", () => {
    expect(pointerPastSidebar(256, 248)).toBe(false); // inside the band
    expect(pointerPastSidebar(257, 248)).toBe(true); // past it
  });
});
