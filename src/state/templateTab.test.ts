import { beforeEach, describe, expect, it } from "vitest";
import { sessionSnapshot, useStore, withPresetGroups } from "./store";
import { firstLeaf, findLeaf, leaves, type PaneSplit } from "../paneTree";
import type { ConfigTemplate } from "./config";


const WORK: ConfigTemplate = {
  name: "work",
  tree: {
    kind: "split",
    vertical: false,
    ratios: [60, 40],
    children: [
      { kind: "leaf", profile: "code", cwd: "/work/app" },
      {
        kind: "split",
        vertical: true,
        children: [
          { kind: "leaf", cwd: "/work/logs" },
          { kind: "leaf", profile: "ops", cwd: "/work", run_on_start: "make watch" },
        ],
      },
    ],
  },
};

const reset = () => {
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    split: null,
    saveTemplateFor: null,
  });
};

describe("opening a layout", () => {
  beforeEach(reset);

  it("rebuilds the declared tree, shape and per-pane fields together", () => {
    const id = useStore.getState().openTemplateTab(WORK);
    const tab = useStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.type).toBe("terminal");

    const panes = tab?.panes;
    expect(panes, "a layout always opens as a tree").toBeDefined();
    if (panes === undefined) return;
    expect(panes.kind).toBe("split");
    const root = panes as PaneSplit;
    expect(root.vertical).toBe(false);
    expect(root.ratios).toEqual([0.6, 0.4]);
    expect(root.children).toHaveLength(2);

    // Every pane in reading order, each judged on its own declaration.
    const byId = leaves(panes).map((paneId) => findLeaf(panes, paneId));
    expect(byId.map((l) => l?.profile)).toEqual(["code", undefined, "ops"]);
    expect(byId.map((l) => l?.cwd)).toEqual([
      "/work/app",
      "/work/logs",
      "/work",
    ]);
    expect(byId.map((l) => l?.runOnStart)).toEqual([
      undefined,
      undefined,
      "make watch",
    ]);

    // The first leaf wears the tab's own id — the registry key and
    // screen-memory scope an un-split terminal has always used.
    expect(firstLeaf(panes)).toBe(id);
    expect(tab?.activePaneId).toBe(id);
    // The tab-level directory mirrors the first pane's.
    expect(tab?.cwd).toBe("/work/app");
  });

  it("starts the tab active and closes the picker", () => {
    useStore.setState({ newTabMenuOpen: true });
    const id = useStore.getState().openTemplateTab(WORK);
    const state = useStore.getState();
    expect(state.activeTabId).toBe(id);
    expect(state.newTabMenuOpen).toBe(false);
  });

  it("survives a restart as a layout, without the start commands", () => {
    const id = useStore.getState().openTemplateTab(WORK);
    const live = useStore.getState().tabs.find((t) => t.id === id)!.panes!;
    const [saved] = sessionSnapshot(useStore.getState()).tabs;
    expect(saved.id).toBe(id);
    const savedPanes = saved.panes;
    expect(savedPanes, "the shape rides the session").toBeDefined();
    if (savedPanes === undefined) return;
    expect(leaves(savedPanes)).toEqual(leaves(live));
    for (const paneId of leaves(savedPanes)) {
      const leaf = findLeaf(savedPanes, paneId);
      expect(leaf?.runOnStart, "no pane carries a command").toBeUndefined();
      expect(leaf?.profile, "no pane carries a profile").toBeUndefined();
      expect(leaf?.cwd, "each pane keeps its directory").toBe(
        findLeaf(live, paneId)?.cwd
      );
    }
  });
});
