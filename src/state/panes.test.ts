import { beforeEach, describe, expect, it } from "vitest";
import {
  sessionSnapshot,
  useStore,
  withPresetGroups,
  type Tab,
} from "./store";
import { flushAll } from "../persist";
import { shareBlockedReason } from "../share/framework/terminalBlocking";
import { termScope } from "../components/terminal/sessionMemory";
import { termKey } from "../termRegistry";
import { isLeaf, layout, leaves, paneCount, type PaneNode, type PaneSplit } from "../paneTree";


const reset = async () => {
  await flushAll();
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    archive: [],
  });
};

const tabOf = (id: string): Tab => {
  const t = useStore.getState().tabs.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no tab ${id}`);
  return t;
};

const treeOf = (id: string): PaneNode => {
  const p = tabOf(id).panes;
  if (p === undefined) throw new Error(`tab ${id} has no panes`);
  return p;
};

/** A terminal tab with a shell already up, which is what ⌘D acts on. */
function terminalWithShell(cwd = "/work"): string {
  const id = useStore.getState().addTab({ type: "terminal", cwd });
  useStore.getState().setPaneTermId(id, id, "pty-1");
  return id;
}

describe(" — a tab that never split behaves exactly as before", () => {
  beforeEach(reset);

  it("has no tree, no focused pane and no zoom", () => {
    const id = terminalWithShell();
    const tab = tabOf(id);
    expect(tab.panes).toBeUndefined();
    expect(tab.activePaneId).toBeUndefined();
    expect(tab.zoomedPaneId).toBeUndefined();
  });

  it("keys its remembered screen and its registry entry by the tab id", () => {
    const id = terminalWithShell();
    // The strings this app used before panes existed, character for
    // character. Anything else and the release that shipped panes would
    // silently lose every terminal's remembered screen: the file would
    // still be on disk under a name nothing looks for.
    expect(termScope(id)).toBe(`term:${id}`);
    expect(termScope(id, id)).toBe(`term:${id}`);
    expect(termKey(id)).toBe(id);
    expect(termKey(id, id)).toBe(id);
  });

  it("writes the PTY id and the directory onto the tab itself", () => {
    const id = terminalWithShell("/work");
    useStore.getState().setPaneCwd(id, id, "/work/deeper");
    const tab = tabOf(id);
    expect(tab.termId).toBe("pty-1");
    expect(tab.cwd).toBe("/work/deeper");
    expect(tab.panes).toBeUndefined();
  });

  it("carries nothing new into the session", () => {
    const id = terminalWithShell();
    const saved = sessionSnapshot(useStore.getState()).tabs.find(
      (t) => t.id === id
    );
    expect(saved?.panes).toBeUndefined();
  });

  it("ignores every pane action that needs a tree", () => {
    const id = terminalWithShell();
    const before = tabOf(id);
    const st = useStore.getState();
    st.focusPaneDir(id, "right");
    st.resizePaneDir(id, "right");
    st.togglePaneZoom(id);
    st.focusPane(id, "whatever");
    st.removeTerminalPane(id, id);
    // Not merely "no crash": the same tab object, so nothing was rewritten
    // into an equal-looking copy on a path that used to leave it alone.
    expect(tabOf(id)).toBe(before);
  });

  it("can be shared, which is what the split tab loses", () => {
    const id = terminalWithShell();
    expect(shareBlockedReason(tabOf(id))).toBeNull();
  });
});

describe("splitting a terminal tab", () => {
  beforeEach(reset);

  it("wraps the running terminal in a leaf carrying the TAB'S id", () => {
    const id = terminalWithShell("/work");
    const made = useStore.getState().splitTerminalPane(id, false, "/work/sub");
    expect(made).not.toBeNull();

    const tree = treeOf(id) as PaneSplit;
    expect(tree.kind).toBe("split");
    // The first leaf IS the tab, which is what keeps its shell alive across
    // the split: every key the terminal is filed under stays the same
    // string, so React, the registry and the doorway all see no change.
    expect(leaves(tree)[0]).toBe(id);
    expect(termScope(id, leaves(tree)[0])).toBe(`term:${id}`);
    expect(termKey(id, leaves(tree)[0])).toBe(id);
    // And the newcomer is filed apart from it, under a name the doorway can
    // still attribute to this tab (the tab id goes last).
    const other = leaves(tree)[1];
    expect(termScope(id, other)).toBe(`term:${other}:${id}`);
    expect(termScope(id, other).endsWith(`:${id}`)).toBe(true);
    expect(termKey(id, other)).not.toBe(id);
  });

  it("gives the new pane the directory it was split from", () => {
    const id = terminalWithShell("/work");
    const made = useStore.getState().splitTerminalPane(id, false, "/work/sub")!;
    const tree = treeOf(id) as PaneSplit;
    const newLeaf = tree.children.find((c) => isLeaf(c) && c.id === made);
    expect((newLeaf as { cwd?: string }).cwd).toBe("/work/sub");
    // The tab's own directory is untouched by a pane opening beside it.
    expect(tabOf(id).cwd).toBe("/work");
  });

  it("focuses the pane it just made, and drops any zoom", () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    useStore.getState().togglePaneZoom(id);
    expect(tabOf(id).zoomedPaneId).not.toBeUndefined();

    const third = useStore.getState().splitTerminalPane(id, false)!;
    expect(tabOf(id).activePaneId).toBe(third);
    // A split makes a pane to look at; leaving the zoom up would hide it.
    expect(tabOf(id).zoomedPaneId).toBeUndefined();
  });

  it("has no ceiling, unlike the outer split's four", () => {
    const id = terminalWithShell();
    for (let i = 0; i < 7; i += 1) useStore.getState().splitTerminalPane(id, false);
    expect(paneCount(treeOf(id))).toBe(8);
  });

  it("refuses on a tab that is not a live terminal", () => {
    const browser = useStore.getState().addTab({ type: "browser" });
    expect(useStore.getState().splitTerminalPane(browser, false)).toBeNull();
  });
});

describe("a pane leaving", () => {
  beforeEach(reset);

  it("collapses the tree and moves the focus to a survivor", () => {
    const id = terminalWithShell();
    const b = useStore.getState().splitTerminalPane(id, false)!;
    const c = useStore.getState().splitTerminalPane(id, true)!;
    expect(tabOf(id).activePaneId).toBe(c);

    useStore.getState().removeTerminalPane(id, c);
    expect(leaves(treeOf(id))).toEqual([id, b]);
    expect(tabOf(id).activePaneId).toBe(b);
  });

  it("keeps a one-pane tree and re-points the tab at the survivor", () => {
    const id = terminalWithShell("/work");
    const b = useStore.getState().splitTerminalPane(id, false, "/other")!;
    useStore.getState().setPaneTermId(id, b, "pty-2");

    useStore.getState().removeTerminalPane(id, id);

    // The tree stays — clearing it would unmount the surviving terminal and
    // take its shell down with it — and the tab's own termId/cwd follow the
    // pane that is left, since that is what every older reader looks at.
    const tree = treeOf(id);
    expect(isLeaf(tree)).toBe(true);
    expect(tree.id).toBe(b);
    expect(tabOf(id).termId).toBe("pty-2");
    expect(tabOf(id).cwd).toBe("/other");
    // One pane again, so sharing comes back.
    expect(shareBlockedReason(tabOf(id))).toBeNull();
  });

  it("never removes the last pane", () => {
    const id = terminalWithShell();
    const b = useStore.getState().splitTerminalPane(id, false)!;
    useStore.getState().removeTerminalPane(id, id);
    const before = tabOf(id);

    useStore.getState().removeTerminalPane(id, b);

    // Unchanged, by identity: the caller's fallback — the `Process exited`
    // line written in place and markTabExited — is what happens instead,
    // which is exactly what an un-split terminal has always done.
    expect(tabOf(id)).toBe(before);
    expect(leaves(treeOf(id))).toEqual([b]);
  });
});

describe("zoom, focus and the seam", () => {
  beforeEach(reset);

  it("zooms and unzooms without touching the tree", () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    const shape = treeOf(id);

    useStore.getState().togglePaneZoom(id);
    expect(tabOf(id).zoomedPaneId).toBe(tabOf(id).activePaneId);
    expect(treeOf(id)).toBe(shape);

    useStore.getState().togglePaneZoom(id);
    expect(tabOf(id).zoomedPaneId).toBeUndefined();
    expect(treeOf(id)).toBe(shape);
  });

  it("never writes the zoom to the session", async () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    useStore.getState().togglePaneZoom(id);
    await flushAll();

    const saved = sessionSnapshot(useStore.getState()).tabs.find(
      (t) => t.id === id
    );
    expect(saved).not.toHaveProperty("zoomedPaneId");
    expect(saved?.panes).not.toBeUndefined();
  });

  it("ends the zoom when the focus jumps out of it", () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    useStore.getState().togglePaneZoom(id);

    useStore.getState().focusPaneDir(id, "left");

    expect(tabOf(id).activePaneId).toBe(id);
    expect(tabOf(id).zoomedPaneId).toBeUndefined();
  });

  it("moves one seam and leaves the rest of the layout alone", () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    const root = treeOf(id);
    useStore.getState().setPaneRatio(id, root.id, 0, 0.7, true);

    const rects = layout(treeOf(id));
    expect(rects[0].w).toBeCloseTo(0.7, 9);
    expect(rects[1].w).toBeCloseTo(0.3, 9);
  });

  it("resizes toward the seam the focused pane leans against", () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    useStore.getState().focusPane(id, id);

    useStore.getState().resizePaneDir(id, "right");

    const rects = layout(treeOf(id));
    expect(rects[0].w).toBeGreaterThan(0.5);
  });
});

describe("what a restart brings back", () => {
  beforeEach(reset);

  it("restores the layout and each pane's directory, with new shells", async () => {
    const id = terminalWithShell("/work");
    const b = useStore.getState().splitTerminalPane(id, false, "/other")!;
    useStore.getState().setPaneTermId(id, b, "pty-2");
    await flushAll();

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);

    const tree = treeOf(id);
    expect(leaves(tree)).toEqual([id, b]);
    // The shells died with the app; where they were standing did not.
    expect(JSON.stringify(tree)).not.toContain("pty-");
    expect(tabOf(id).termId).toBeUndefined();
    expect(tabOf(id).activePaneId).toBe(id);
    expect(tabOf(id).zoomedPaneId).toBeUndefined();
  });

  it("reads a hand-broken layout back as no layout at all", async () => {
    const id = terminalWithShell();
    useStore.getState().splitTerminalPane(id, false);
    await flushAll();

    const raw = JSON.parse(localStorage.getItem("tabverse.state.session") as string);
    // Two panes sharing an id would share a screen-memory file and a
    // registry entry; the tab must come back as a single terminal instead
    // of as a layout with a pane nobody can address.
    const tree = raw.tabs.find((t: { id: string }) => t.id === id).panes;
    tree.children[1].id = tree.children[0].id;
    localStorage.setItem("tabverse.state.session", JSON.stringify(raw));

    useStore.setState({ tabs: [], groups: withPresetGroups([]), activeTabId: null });
    expect(await useStore.getState().restoreSession()).toBe(true);
    expect(tabOf(id).panes).toBeUndefined();
  });

  it("keeps the layout when a pinned tab is put to sleep, drops the shells", () => {
    const id = terminalWithShell("/work");
    const b = useStore.getState().splitTerminalPane(id, false, "/other")!;
    useStore.getState().setPaneTermId(id, b, "pty-2");
    const group = useStore.getState().groups.find((g) => g.preset === "terminal");
    useStore.getState().assignToGroup(id, group!.id);
    useStore.getState().closeTab(id);

    const tab = tabOf(id);
    expect(tab.dormant).toBe(true);
    // The layout is payload, like the directory; the shells inside it are
    // runtime, and a dormant item has none.
    expect(leaves(tab.panes as PaneNode)).toEqual([id, b]);
    expect(JSON.stringify(tab.panes)).not.toContain("pty-");
    expect(tab.termId).toBeUndefined();
  });
});

describe("sharing a tab with panes", () => {
  beforeEach(reset);

  it("is refused with a reason, and allowed again after a collapse", () => {
    const id = terminalWithShell();
    const b = useStore.getState().splitTerminalPane(id, false)!;
    expect(shareBlockedReason(tabOf(id))).toBe("panes");

    useStore.getState().removeTerminalPane(id, b);
    expect(shareBlockedReason(tabOf(id))).toBeNull();
  });

  it("says nothing about tabs that are not terminals", () => {
    const browser = useStore.getState().addTab({ type: "browser" });
    expect(shareBlockedReason(tabOf(browser))).toBeNull();
    expect(shareBlockedReason(undefined)).toBeNull();
  });
});
