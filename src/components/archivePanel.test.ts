import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


import { ArchivePanel, filterArchiveEntries } from "./ArchivePanel";
import { useStore, type ArchiveEntry } from "../state/store";
import { STR } from "../strings";

const entry = (over: Partial<ArchiveEntry>): ArchiveEntry => ({
  id: crypto.randomUUID(),
  type: "browser",
  title: "",
  archivedAt: 1,
  ...over,
});

describe("filterArchiveEntries", () => {
  const rows = [
    { entry: entry({ title: "Docs review", url: "https://docs.test/x", archivedAt: 3 }), index: 2 },
    { entry: entry({ title: "deploy run", cwd: "/srv/deploy", type: "terminal", archivedAt: 2 }), index: 1 },
    { entry: entry({ title: "shopping", url: "https://shop.test/cart", archivedAt: 1 }), index: 0 },
  ];

  it("matches title, url and cwd each, case-insensitively", () => {
    expect(filterArchiveEntries(rows, "docs review").map((r) => r.index)).toEqual([2]);
    expect(filterArchiveEntries(rows, "DOCS.TEST").map((r) => r.index)).toEqual([2]);
    expect(filterArchiveEntries(rows, "/srv/deploy").map((r) => r.index)).toEqual([1]);
    expect(filterArchiveEntries(rows, "shop").map((r) => r.index)).toEqual([0]);
  });

  it("an empty (or blank) query filters nothing", () => {
    expect(filterArchiveEntries(rows, "")).toHaveLength(3);
    expect(filterArchiveEntries(rows, "   ")).toHaveLength(3);
  });

  it("keeps each row's original index untouched", () => {
    const filtered = filterArchiveEntries(rows, "shop");
    expect(filtered[0].index).toBe(0);
    expect(filtered[0].entry.url).toBe("https://shop.test/cart");
  });
});

describe("ArchivePanel's filter and report", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    useStore.setState({
      tabs: [],
      groups: [],
      activeTabId: null,
      archive: [],
      archiveEvicted: 0,
    });
  });

  const shelf: ArchiveEntry[] = [
    entry({ title: "oldest", url: "https://old.test/", archivedAt: 1 }),
    entry({ title: "middle build", cwd: "/work/build", type: "files", archivedAt: 2 }),
    entry({ title: "newest", url: "https://new.test/", archivedAt: 3 }),
  ];

  const mount = (evicted: number) => {
    useStore.setState({ archive: shelf, archiveEvicted: evicted });
    flushSync(() => {
      root.render(createElement(ArchivePanel, { onClose: () => {} }));
    });
  };

  const filterInput = () =>
    host.querySelector<HTMLInputElement>(".pw-window-head .pw-filter")!;

  const rowTitles = () =>
    [...host.querySelectorAll(".pw-host")].map((n) => n.textContent);

  const type = (text: string) => {
    const input = filterInput();
    const setVal = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    setVal.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync(() => {
      root.render(createElement(ArchivePanel, { onClose: () => {} }));
    });
  };

  it("narrows the rows to what the query names, newest first kept", () => {
    mount(0);
    type("build");
    expect(rowTitles()).toEqual(["middle build"]);
  });

  it("a filtered row still addresses its ORIGINAL archive index", () => {
    mount(0);
    const unarchive = vi.fn(() => null);
    useStore.setState({ unarchiveEntry: unarchive as never });
    type("oldest");
    const row = host.querySelector<HTMLElement>(".archive-row")!;
    row.click();
    // "oldest" is archive[0], though it is the only row on screen —
    // addressing by the filtered position (0 by luck here) proves
    // nothing, so the shelf is re-filtered below to break the tie.
    expect(unarchive).toHaveBeenCalledWith(0);
    // A filter that leaves the row mid-list: "middle build" is archive[1]
    // while sitting first on screen — the address must be 1, not 0.
    useStore.setState({ unarchiveEntry: unarchive as never });
    unarchive.mockClear();
    type("build");
    host.querySelector<HTMLElement>(".archive-row")!.click();
    expect(unarchive).toHaveBeenCalledWith(1);
  });

  it("shows the eviction line only while a filter is typed and evictions exist", () => {
    mount(3);
    expect(host.textContent).not.toContain("had to make way");
    type("build");
    expect(host.textContent).toContain(
      STR.panels.archive.evictedLine({ count: 3 })
    );
    // Nothing evicted + a query: no line either — both halves gate it.
    useStore.setState({ archiveEvicted: 0 });
    type("build");
    expect(host.textContent).not.toContain("had to make way");
  });
});
