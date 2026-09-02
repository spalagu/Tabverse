import { beforeEach, describe, expect, it } from "vitest";
import {
  SPLIT_MAX_PANES,
  splittable,
  useStore,
  withPresetGroups,
  type Tab,
  type TabType,
} from "./store";
import { canSplitWithActive } from "../components/TabMenu";
import { armsSplitDrag, splittableDrag } from "../components/Sidebar";
import { flushAll } from "../persist";


const reset = async () => {
  await flushAll();
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    archive: [],
    split: null,
    splitDragging: false,
    peekTabId: null,
    contentDrag: null,
    draggingTabIds: [],
  });
};

const st = () => useStore.getState();

/** Every type a tab can be, so no future type quietly escapes the sweep. */
const ALL_TYPES: TabType[] = [
  "terminal",
  "files",
  "browser",
  "settings",
  "remote",
];

/** One tab of each type in each state a split cares about. Built as plain
 *  objects rather than through addTab: a peek tab and a dormant tab are
 *  reachable only by particular routes, and the sweep is about the SHAPE. */
const shapes = (): Array<{ name: string; tab: Tab }> => {
  const out: Array<{ name: string; tab: Tab }> = [];
  for (const type of ALL_TYPES) {
    const base: Tab = {
      id: `${type}-plain`,
      type,
      title: type,
      groupId: null,
    };
    out.push({ name: `${type} (awake)`, tab: base });
    out.push({
      name: `${type} (dormant)`,
      tab: { ...base, id: `${type}-dormant`, dormant: true },
    });
    out.push({
      name: `${type} (peek)`,
      tab: { ...base, id: `${type}-peek`, peek: true },
    });
  }
  return out;
};

describe("the split's type gate is gone", () => {
  beforeEach(reset);

  it("takes a terminal, a file view and the settings page into a pane", () => {
    const browser = st().addTab({ type: "browser", url: "https://a.example/" });
    for (const type of ["terminal", "files", "settings"] as TabType[]) {
      const other = st().addTab({ type });
      st().activateTab(browser);
      expect(st().splitWith(other)).toBe(true);
      expect(st().split!.ids).toEqual([browser, other]);
      st().unsplit();
      // And the same pair with the types the other way round.
      st().activateTab(other);
      expect(st().splitWith(browser)).toBe(true);
      expect(st().split!.ids).toEqual([other, browser]);
      st().unsplit();
      st().closeTab(other);
    }
  });

  it("puts two terminals side by side — no browser involved at all", () => {
    const a = st().addTab({ type: "terminal" });
    const b = st().addTab({ type: "terminal" });
    st().activateTab(a);
    expect(st().splitWith(b)).toBe(true);
    expect(st().split!.ids).toEqual([a, b]);
  });

  it("still refuses a dormant tab, a peek, and the fifth pane", () => {
    // Dormant: a pinned item with no runtime has no pane to show.
    const term = st().addTab({ type: "terminal" });
    const pinned = st().addTab({ type: "browser", url: "https://p.example/" });
    const preset = st().groups.find((g) => g.preset === "browser")!.id;
    st().assignToGroup(pinned, preset);
    st().activateTab(term);
    st().closeTab(pinned);
    expect(st().tabs.find((t) => t.id === pinned)?.dormant).toBe(true);
    expect(st().splitWith(pinned)).toBe(false);

    // Peek: not the user's tab yet.
    const base = st().addTab({ type: "browser", url: "https://b.example/" });
    st().activateTab(base);
    const peek = st().openPeek({ type: "browser", url: "https://peek.example/" });
    expect(splittable(st().tabs.find((t) => t.id === peek))).toBe(false);
    st().discardPeek();

    // The ceiling is resource, not semantics: four terminals fill it just as
    // four browsers would, and the fifth is refused.
    st().unsplit();
    const panes = [term];
    while (panes.length < SPLIT_MAX_PANES) {
      panes.push(st().addTab({ type: "terminal" }));
    }
    st().activateTab(panes[0]);
    for (const id of panes.slice(1)) expect(st().splitWith(id)).toBe(true);
    expect(st().split!.ids).toEqual(panes);
    const fifth = st().addTab({ type: "terminal" });
    st().activateTab(panes[0]);
    expect(st().splitWith(fifth)).toBe(false);
    expect(st().split!.ids).toHaveLength(SPLIT_MAX_PANES);
  });

  it("trims a mixed-type split to its showable members, types aside", () => {
    const term = st().addTab({ type: "terminal" });
    const files = st().addTab({ type: "files" });
    const browser = st().addTab({ type: "browser", url: "https://a.example/" });
    st().activateTab(term);
    expect(st().splitWith(files)).toBe(true);
    expect(st().splitWith(browser)).toBe(true);
    expect(st().split!.ids).toEqual([term, files, browser]);
    // Closing the file view drops that member and re-evens the rest; the two
    // survivors are of different types and the split stands.
    st().closeTab(files);
    expect(st().split!.ids).toEqual([term, browser]);
    expect(st().split!.ratios).toEqual([0.5, 0.5]);
    // Down to one member the split dissolves, whatever type is left.
    st().closeTab(browser);
    expect(st().split).toBeNull();
  });
});

describe("the two consumers ask the store, they do not decide", () => {
  beforeEach(reset);

  it("the tab menu's offer matches splittable for every tab shape", () => {
    // The tab in front is a plain awake tab, so the menu's answer for the row
    // can only differ from splittable's if the menu is deciding for itself.
    const active: Tab = {
      id: "active-front",
      type: "browser",
      title: "front",
      groupId: null,
    };
    for (const { name, tab } of shapes()) {
      expect(
        canSplitWithActive(tab, active, null),
        `${name} as the row`
      ).toBe(splittable(tab));
      // And with the shape on the ACTIVE side instead: the menu asks about
      // both tabs, so both sides have to be derived.
      expect(
        canSplitWithActive(active, tab, null),
        `${name} as the tab in front`
      ).toBe(splittable(tab));
    }
  });

  it("the sidebar's drag arming matches splittable for every tab shape", () => {
    const active: Tab = {
      id: "active-front",
      type: "browser",
      title: "front",
      groupId: null,
    };
    for (const { name, tab } of shapes()) {
      expect(armsSplitDrag(tab, active), `${name} dragged`).toBe(
        splittable(tab)
      );
      expect(armsSplitDrag(active, tab), `${name} in front`).toBe(
        splittable(tab)
      );
    }
  });

  it("the sidebar's dragover matches splittable for every tab shape", () => {
    const row: Tab = {
      id: "row-target",
      type: "browser",
      title: "row",
      groupId: null,
    };
    for (const { name, tab } of shapes()) {
      useStore.setState({ tabs: [row, tab], draggingTabIds: [tab.id] });
      expect(splittableDrag(row.id), `${name} dragged over a row`).toBe(
        splittable(tab)
      );
    }
  });

  it("both consumers refuse the same tab twice, and the menu refuses a shared split", () => {
    const one: Tab = { id: "one", type: "terminal", title: "one", groupId: null };
    const two: Tab = { id: "two", type: "browser", title: "two", groupId: null };
    // Splittable on its own, but there is no split to be made with itself.
    expect(splittable(one)).toBe(true);
    expect(canSplitWithActive(one, one, null)).toBe(false);
    expect(armsSplitDrag(one, one)).toBe(false);
    useStore.setState({ tabs: [one, two], draggingTabIds: [one.id] });
    expect(splittableDrag(one.id)).toBe(false);
    // Already sharing the active tab's split: Unsplit is the offer, not Split.
    const together = { ids: [one.id, two.id], ratios: [0.5, 0.5], vertical: false };
    expect(canSplitWithActive(one, two, together)).toBe(false);
    // A standing split the row is NOT part of still offers to be joined.
    const elsewhere = { ids: [two.id, "third"], ratios: [0.5, 0.5], vertical: false };
    expect(canSplitWithActive(one, two, elsewhere)).toBe(true);
  });

  it("a multi-row drag is a reorder, however splittable the tabs are", () => {
    const row: Tab = { id: "row", type: "browser", title: "row", groupId: null };
    const a: Tab = { id: "a", type: "terminal", title: "a", groupId: null };
    const b: Tab = { id: "b", type: "terminal", title: "b", groupId: null };
    useStore.setState({ tabs: [row, a, b], draggingTabIds: [a.id, b.id] });
    expect(splittable(a)).toBe(true);
    expect(splittableDrag(row.id)).toBe(false);
  });
});
