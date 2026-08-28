import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBarSections, flattenRows } from "./commandBar";
import { CommandBar } from "./components/CommandBar";
import { relativeTime } from "./components/ArchivePanel";
import { useStore, type ArchiveEntry, type Tab } from "./state/store";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  type ConfigValues,
} from "./state/config";


const tab = (partial: Partial<Tab> & { id: string; type: Tab["type"] }): Tab => ({
  title: partial.id,
  groupId: null,
  ...partial,
});

const entry = (over: Partial<ArchiveEntry> & { id: string }): ArchiveEntry => ({
  type: "browser",
  title: over.id,
  archivedAt: 1000,
  ...over,
});

const deps = {
  tabs: [],
  groups: [],
  sites: [],
};

const archive = [
  entry({ id: "old", title: "Old report", url: "https://old.test/", archivedAt: 1000 }),
  entry({ id: "new", title: "New report", url: "https://new.test/", archivedAt: 2000 }),
];

const closed = [
  {
    tab: tab({ id: "c-new", type: "terminal", title: "Fresh build", cwd: "/tmp/fresh" }),
    index: 3,
    closedAt: 2000,
  },
  {
    tab: tab({ id: "c-old", type: "browser", title: "Alpha page", url: "https://alpha.test/" }),
    index: 0,
    closedAt: 1000,
  },
];

describe("the recall sections answer a query", () => {
  it("matches a closed tab by any of its three surfaces, newest first, with its queue slot", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "alpha",
      ...deps,
      closed,
    });
    expect(sections.closed).toHaveLength(1);
    const row = sections.closed[0];
    expect(row.tab.id).toBe("c-old");
    // The slot is the queue's own position: the row reopens itself, not
    // the head. c-old is second in the enumeration, so its slot is 1.
    expect(row.slot).toBe(1);
    // The time note's raw material rides on the row; the drawing turns it
    // into "3m ago" (asserted below, on the mounted bar).
    expect(row.closedAt).toBe(1000);
    expect(
      buildBarSections({ mode: "global", query: "/tmp/fresh", ...deps, closed })
        .closed
    ).toHaveLength(1);
    expect(
      buildBarSections({ mode: "global", query: "alpha.test", ...deps, closed })
        .closed
    ).toHaveLength(1);
  });

  it("matches an archived entry on its own three surfaces, newest first, keeping the store's index", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "report",
      ...deps,
      archive,
    });
    expect(sections.archived.map((r) => r.entry.id)).toEqual(["new", "old"]);
    // The store array is oldest-first; the rows are newest-first; the
    // index is the STORE's, unarchiveEntry's own addressing.
    expect(sections.archived.map((r) => r.index)).toEqual([1, 0]);
    expect(
      buildBarSections({ mode: "global", query: "old.test", ...deps, archive })
        .archived
    ).toHaveLength(1);
    expect(
      buildBarSections({
        mode: "global",
        query: "nothing-of-mine",
        ...deps,
        archive,
      }).archived
    ).toHaveLength(0);
  });

  it("caps the section like every other section", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      tab: tab({ id: `c${i}`, type: "terminal", title: `Closed ${i}` }),
      index: i,
      closedAt: i,
    }));
    const sections = buildBarSections({
      mode: "global",
      query: "closed",
      ...deps,
      closed: many,
    });
    expect(sections.closed).toHaveLength(6);
  });
});

describe("the gating and the position", () => {
  it("an empty query shows neither section — the idle bar stays a start page", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "",
      ...deps,
      closed,
      archive,
    });
    expect(sections.closed).toEqual([]);
    expect(sections.archived).toEqual([]);
  });

  it("flattens below the tabs and behind everything else — the fallback stays Enter's default", () => {
    const sections = buildBarSections({
      mode: "global",
      query: "report",
      tabs: [tab({ id: "t1", type: "terminal", title: "report tab" })],
      groups: [],
      sites: [
        { url: "https://report.example/", title: "Report hub", host: "report.example", visits: 1, lastVisit: Date.now() },
      ],
      closed: [
        {
          tab: tab({ id: "c1", type: "files", title: "Report draft", cwd: "/tmp/report" }),
          index: 2,
          closedAt: 1000,
        },
      ],
      archive,
    });
    const rows = flattenRows(sections);
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe("fallback");
    // Recently closed directly under the open tabs…
    expect(kinds.indexOf("closed")).toBeGreaterThan(kinds.lastIndexOf("tab"));
    // …and never above history…
    expect(kinds.indexOf("site")).toBeGreaterThan(kinds.lastIndexOf("closed"));
    // …while the shelf goes last — behind the commands when any matched,
    // behind everything that did otherwise.
    if (kinds.includes("command")) {
      expect(kinds.lastIndexOf("command")).toBeLessThan(kinds.indexOf("archived"));
    }
    expect(rows[rows.length - 1].kind).toBe("archived");
  });

  it("offers neither section to the new-tab page, which opens addresses", () => {
    const sections = buildBarSections({
      mode: "newtab",
      query: "report",
      ...deps,
      closed,
      archive,
    });
    expect(sections.closed).toEqual([]);
    expect(sections.archived).toEqual([]);
  });

  it("treats a caller with no queue and no shelf as one with neither", () => {
    const sections = buildBarSections({ mode: "global", query: "report", ...deps });
    expect(sections.closed).toEqual([]);
    expect(sections.archived).toEqual([]);
  });
});

describe("the store's read-only channel", () => {
  beforeEach(() => {
    // The closed queue is module-private and shared across this file:
    // drain it through its own door so one test's closes never answer
    // the next test's enumeration. Each reopen re-adds its tab, which the
    // tabs reset that follows clears away.
    while (useStore.getState().reopenClosedTab() !== null) {
      /* pop */
    }
    useStore.setState({
      tabs: [],
      groups: useStore.getState().groups,
      activeTabId: null,
      archive: [],
    });
    localStorage.clear();
  });

  it("enumerates what closing put on the queue, newest first, without lending the queue out", () => {
    const first = useStore.getState().addTab({ type: "terminal", cwd: "/tmp/one" });
    const second = useStore.getState().addTab({ type: "files", cwd: "/tmp/two" });
    useStore.getState().closeTab(first);
    useStore.getState().closeTab(second);
    const seen = useStore.getState().recentlyClosed();
    // Newest first, and the copy is fresh every call — two reads of the
    // same queue are two arrays.
    expect(seen.map((e) => e.tab.id)).toEqual([second, first]);
    expect(seen[0].closedAt).toBeGreaterThan(0);
    expect(useStore.getState().recentlyClosed()).not.toBe(seen);
  });

  it("reopening a named slot pops THAT entry, not the head", () => {
    const first = useStore.getState().addTab({ type: "terminal", cwd: "/tmp/one" });
    const second = useStore.getState().addTab({ type: "terminal", cwd: "/tmp/two" });
    useStore.getState().closeTab(first);
    useStore.getState().closeTab(second);
    const before = useStore.getState().closedCount;
    // Slot 1 is the OLDER closed tab; the head (slot 0) is `second`.
    expect(useStore.getState().reopenClosedTab(1)).toBe(first);
    const s = useStore.getState();
    expect(s.tabs.some((t) => t.id === first)).toBe(true);
    expect(s.closedCount).toBe(before - 1);
    expect(s.recentlyClosed().map((e) => e.tab.id)).toEqual([second]);
    // The default argument stays the sidebar's head-first ⌘⇧T.
    expect(useStore.getState().reopenClosedTab()).toBe(second);
  });
});

// ---------------------------------------------------------- the drawn bar

const w = () => window as unknown as Record<string, unknown>;

const CONFIG: ConfigValues = {
  appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
  browser: {
    search_engine: "duckduckgo",
    custom_search_template: "",
    archive_after: "24h",
  },
  terminal: { profiles: [] },
};

const SCHEMA = [
  {
    key: "appearance.sidebar_width",
    kind: { number: { min: 180, max: 520 } },
    section: "appearance",
    str_key: "settings.appearance.sidebarWidth",
    default: 301,
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

const resetBar = () => {
  // Same drain as the channel tests: the drawn bar reads the real queue.
  while (useStore.getState().reopenClosedTab() !== null) {
    /* pop */
  }
  useStore.setState({
    tabs: [],
    groups: useStore.getState().groups,
    activeTabId: null,
    archive: [],
    commandBarOpen: true,
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  w()[BOOT_CONFIG_KEY] = CONFIG;
  w()[DEMO_SCHEMA_KEY] = SCHEMA;
  localStorage.clear();
  resetBar();
});

afterEach(() => {
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  useStore.setState({ commandBarOpen: false });
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
});

const mountAndType = async (query: string) => {
  const el = host!;
  await act(async () => {
    root = createRoot(el);
    root.render(createElement(CommandBar));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const input = el.querySelector("input");
  expect(input, "the bar has no input").not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, query);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return el;
};

describe("the bar as it is drawn", () => {
  it("draws the archive section with its time note and revives the clicked entry", async () => {
    const shelvedAt = Date.now() - 3 * 60 * 1000; // "3m ago"
    useStore.setState({
      archive: [
        {
          id: "shelved-1",
          type: "browser",
          title: "Quarterly numbers",
          url: "https://numbers.test/q3",
          archivedAt: shelvedAt,
        },
      ],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    const el = await mountAndType("numbers");

    const rows = Array.from(
      el.querySelectorAll('[data-row-kind="archived"]')
    ) as HTMLElement[];
    expect(rows.length, "no archived row was drawn").toBe(1);
    expect(rows[0].textContent).toContain("Quarterly numbers");
    // The time note is drawn — relativeTime, the panel's own annotator.
    expect(rows[0].textContent).toContain(relativeTime(shelvedAt));
    expect(el.textContent).toContain("Archive");

    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const s = useStore.getState();
    // The original entry revived: same id, through unarchiveEntry's own
    // door, and off the shelf in the same motion.
    expect(s.tabs.find((t) => t.id === "shelved-1")?.url).toBe(
      "https://numbers.test/q3"
    );
    expect(s.archive).toHaveLength(0);
    expect(s.commandBarOpen).toBe(false);
  });

  it("draws the closed section, note included, and reopens the clicked row — not the head", async () => {
    const older = useStore.getState().addTab({
      type: "browser",
      url: "https://older.test/alpha",
    });
    const newer = useStore.getState().addTab({
      type: "browser",
      url: "https://newer.test/beta",
    });
    useStore.getState().closeTab(older);
    useStore.getState().closeTab(newer);
    const before = useStore.getState().closedCount;
    const olderClosedAt = useStore
      .getState()
      .recentlyClosed()
      .find((e) => e.tab.id === older)!.closedAt;

    host = document.createElement("div");
    document.body.appendChild(host);
    const el = await mountAndType("alpha");

    const rows = Array.from(
      el.querySelectorAll('[data-row-kind="closed"]')
    ) as HTMLElement[];
    expect(rows.length, "no closed row was drawn").toBe(1);
    // The time note is relativeTime over this row's own closedAt — the
    // head of the queue is the NEWER close, this row is the older one.
    expect(rows[0].textContent).toContain(relativeTime(olderClosedAt));
    // The header says the honest scope of the queue.
    expect(el.textContent).toContain("this session");

    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const s = useStore.getState();
    // The clicked row's own tab came back (slot 1, not the head), the
    // queue popped exactly that entry, and the bar closed as any run does.
    expect(s.tabs.some((t) => t.id === older)).toBe(true);
    expect(s.closedCount).toBe(before - 1);
    expect(s.recentlyClosed().map((e) => e.tab.id)).toEqual([newer]);
    expect(s.commandBarOpen).toBe(false);
  });

  it("draws neither section on an empty query, and no fallback either — the start page, unchanged", async () => {
    useStore.setState({
      archive: [
        {
          id: "shelved-2",
          type: "files",
          title: "Draft notes",
          cwd: "/tmp/notes",
          archivedAt: Date.now(),
        },
      ],
    });
    const someTab = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().closeTab(someTab);

    host = document.createElement("div");
    document.body.appendChild(host);
    const el = await mountAndType("");

    expect(el.querySelectorAll('[data-row-kind="closed"]').length).toBe(0);
    expect(el.querySelectorAll('[data-row-kind="archived"]').length).toBe(0);
    expect(el.textContent).not.toContain("this session");
    expect(el.textContent).not.toContain("Archive");
    // The idle bar is what it always was: commands first, and no fallback.
    const kinds = Array.from(el.querySelectorAll(".command-bar-row")).map(
      (r) => (r as HTMLElement).dataset.rowKind
    );
    expect(kinds[0]).toBe("command");
    expect(kinds).not.toContain("fallback");
  });
});
