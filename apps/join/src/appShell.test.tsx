import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppShareShell,
  defaultFitFor,
  LocalTabsVault,
  type AppShareGroup,
  type AppShareTab,
} from "@tabverse/workbench/app-shell";
import { WorkbenchRuntimeProvider } from "@tabverse/workbench/runtime";
import { remoteRuntime } from "@tabverse/runtime-remote";
import { groupColors } from "@tabverse/workbench/theme";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A controllable MediaQueryList: `matches` reads live state and the
 * listeners are the EventTarget's own, so dispatching a change event is
 * exactly what a real viewport flip delivers. The legacy add/remove
 * listener pair exists only because the interface demands it — the shell
 * uses addEventListener. */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: MediaQueryList["onchange"] = null;
  private attached = 0;

  constructor(
    private readonly read: () => boolean,
    readonly media: string,
  ) {
    super();
  }

  get matches(): boolean {
    return this.read();
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    super.addEventListener(type, listener);
    this.attached += 1;
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    super.removeEventListener(type, listener);
    this.attached -= 1;
  }

  addListener(_listener: unknown): void {}
  removeListener(_listener: unknown): void {}

  /** How many change listeners are currently attached — the observable
   * side of the shell's cleanup contract. */
  get listenerCount(): number {
    return this.attached;
  }
}

/** The viewport under test. The query strings are restated here on
 * purpose: they are the breakpoint contract, and a silent change to the
 * component's copy should turn this file red, not quietly pass. */
const WIDE = "(min-width: 769px)";
const COARSE = "(pointer: coarse)";
const media = { wide: true, coarse: false };
const wideMql = new FakeMediaQueryList(() => media.wide, WIDE);
const coarseMql = new FakeMediaQueryList(() => media.coarse, COARSE);
const realMatchMedia = window.matchMedia;

function setViewport(wide: boolean, coarse: boolean): void {
  media.wide = wide;
  media.coarse = coarse;
}

const TABS: AppShareTab[] = [
  { id: "t1", title: "zsh", type: "terminal", groupId: null },
  { id: "a1", title: "Agent", type: "agent", groupId: null },
  { id: "t2", title: "cargo run", type: "terminal", groupId: null },
];
const TITLES = TABS.map((t) => t.title);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setViewport(true, false);
  window.matchMedia = (query: string): MediaQueryList =>
    query === WIDE ? wideMql : coarseMql;
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = realMatchMedia;
});

/** Render into the shared root. */
function mount(node: ReactNode): void {
  act(() => {
    root.render(
      <WorkbenchRuntimeProvider runtime={remoteRuntime}>
        {node}
      </WorkbenchRuntimeProvider>,
    );
  });
}

/** The shell with the fixture tabs; the pane marker doubles as evidence
 * that the content area carries the caller's children in every form. */
function shell(
  activeId: string | null = "t1",
  onSelect: (id: string) => void = () => {},
): ReactNode {
  return (
    <WorkbenchRuntimeProvider runtime={remoteRuntime}>
      <AppShareShell tabs={TABS} groups={[]} activeId={activeId} onSelect={onSelect}>
        <p className="pane">active pane</p>
      </AppShareShell>
    </WorkbenchRuntimeProvider>
  );
}

const handle = () => host.querySelector<HTMLButtonElement>(".app-drawer-handle");

describe("AppShareShell", () => {
  it("a wide fine-pointer viewport shows the tab rail, not the handle or drawer", () => {
    setViewport(true, false);
    mount(shell("a1"));

    expect(host.querySelector(".app-shell-side")).not.toBeNull();
    expect(handle()).toBeNull();
    expect(host.querySelector(".app-drawer")).toBeNull();

    const rows = [...host.querySelectorAll<HTMLButtonElement>(".app-tab-row")];
    expect(rows.map((r) => r.textContent)).toEqual(TITLES);
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // The rail's tabs point at the content area, and the caller's pane is
    // beside the rail inside it.
    expect(rows[1].getAttribute("aria-controls")).toBe("app-share-panel");
    expect(host.querySelector("#app-share-panel .pane")).not.toBeNull();
  });

  it("a narrow viewport shows the handle instead; a click opens the drawer, a second retracts it", () => {
    setViewport(false, false);
    mount(shell());

    expect(host.querySelector(".app-shell-side")).toBeNull();
    const btn = handle();
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    expect(btn!.getAttribute("aria-controls")).toBe("app-share-drawer");

    // The drawer's list is the same source as the rail's: all three tabs.
    const drawer = host.querySelector("#app-share-drawer");
    expect(drawer).not.toBeNull();
    expect(host.querySelector(".app-shell-drawer")!.className).not.toContain(
      "open",
    );
    expect(
      [...drawer!.querySelectorAll(".app-tab-row")].map((r) => r.textContent),
    ).toEqual(TITLES);

    act(() => btn!.click());
    expect(btn!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".app-shell-drawer")!.className).toContain(
      "open",
    );

    act(() => btn!.click());
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".app-shell-drawer")!.className).not.toContain(
      "open",
    );
  });

  it("a coarse pointer gets the drawer form even on a wide viewport", () => {
    setViewport(true, true);
    mount(shell());

    expect(host.querySelector(".app-shell-side")).toBeNull();
    expect(handle()).not.toBeNull();
  });

  it("a viewport flip re-renders into the other form without a remount", () => {
    setViewport(false, false);
    mount(shell());
    expect(handle()).not.toBeNull();

    setViewport(true, false);
    act(() => {
      wideMql.dispatchEvent(new Event("change"));
      coarseMql.dispatchEvent(new Event("change"));
    });

    expect(host.querySelector(".app-shell-side")).not.toBeNull();
    expect(handle()).toBeNull();
  });

  it("selecting a tab from the drawer reports the id and slides the drawer closed", () => {
    setViewport(false, false);
    const picked: string[] = [];
    mount(shell("t1", (id) => picked.push(id)));

    act(() => handle()!.click());
    act(() => host.querySelectorAll<HTMLButtonElement>(".app-tab-row")[1].click());

    expect(picked).toEqual(["a1"]);
    expect(host.querySelector(".app-shell-drawer")!.className).not.toContain(
      "open",
    );
    expect(handle()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("unmounting the shell detaches both media listeners", () => {
    // Its own root, so the shared afterEach unmount has nothing left to
    // tear down and the counts say only what this mount attached.
    const localHost = document.createElement("div");
    document.body.appendChild(localHost);
    const localRoot = createRoot(localHost);
    act(() => {
      localRoot.render(shell());
    });
    expect(wideMql.listenerCount).toBe(1);
    expect(coarseMql.listenerCount).toBe(1);

    act(() => localRoot.unmount());
    expect(wideMql.listenerCount).toBe(0);
    expect(coarseMql.listenerCount).toBe(0);
    localHost.remove();
  });
});

const PINNED_TABS: AppShareTab[] = [
  { id: "p1", title: "deploy", type: "terminal", groupId: "g-work" },
  { id: "p2", title: "docs", type: "browser", groupId: "g-ops-web" },
  { id: "p3", title: "logs", type: "terminal", groupId: "g-ops" },
  { id: "p4", title: "shell", type: "terminal", groupId: "g-ops" },
  { id: "s1", title: "scratch", type: "terminal", groupId: null },
];
const PINNED_GROUPS: AppShareGroup[] = [
  { id: "g-ops", name: "Ops", colorIndex: 0, collapsed: false },
  { id: "g-ops-web", name: "Web", colorIndex: 1, parentId: "g-ops", collapsed: false },
  { id: "g-work", name: "Work", colorIndex: 2, collapsed: false },
];

function pinnedShell(groups: AppShareGroup[] = PINNED_GROUPS): ReactNode {
  return (
    <AppShareShell
      tabs={PINNED_TABS}
      groups={groups}
      activeId="p3"
      onSelect={() => {}}
    >
      <p className="pane">active pane</p>
    </AppShareShell>
  );
}

describe("AppShareShell's grouped zones", () => {
  it("draws the pinned tree in the host sidebar's order, then the seam, then Today", () => {
    mount(pinnedShell());

    // Folder headers: roots in the host's array order, the nested child
    // under its parent, each labelled with its whole subtree's count.
    expect(
      [...host.querySelectorAll(".app-tab-group-head")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["Ops3", "Web1", "Work1"]);

    expect(
      [...host.querySelectorAll(".app-tab-row")].map((r) => r.textContent),
    ).toEqual(["docs", "logs", "shell", "deploy", "scratch"]);
    expect(host.querySelectorAll(".app-zone-divider")).toHaveLength(1);

    // Nesting reads as nesting: the subfolder's header and row sit one
    // level deeper than the root's own.
    const depthOf = (el: Element) =>
      (el as HTMLElement).style.getPropertyValue("--app-depth");
    const heads = [...host.querySelectorAll(".app-tab-group-head")];
    expect(depthOf(heads[0])).toBe("0");
    expect(depthOf(heads[1])).toBe("1");
    const rows = [...host.querySelectorAll(".app-tab-row")];
    expect(depthOf(rows[0])).toBe("1");
    expect(depthOf(rows[1])).toBe("0");
  });

  it("a collapsed folder peeks its whole subtree out under the header, host-style", () => {
    mount(
      pinnedShell([
        { id: "g-ops", name: "Ops", colorIndex: 0, collapsed: true },
        { id: "g-ops-web", name: "Web", colorIndex: 1, parentId: "g-ops", collapsed: false },
        { id: "g-work", name: "Work", colorIndex: 2, collapsed: false },
      ]),
    );

    expect(
      [...host.querySelectorAll(".app-tab-group-head")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["Ops3", "Work1"]);
    expect(
      host.querySelector(".app-tab-group")!.getAttribute("data-collapsed"),
    ).toBe("true");
    expect(
      [...host.querySelectorAll(".app-tab-row")].map((r) => r.textContent),
    ).toEqual(["docs", "logs", "shell", "deploy", "scratch"]);
  });

  it("a tab whose folder the snapshot never carried degrades to Today, never to invisibility", () => {
    mount(
      <AppShareShell
        tabs={[
          ...PINNED_TABS,
          { id: "orphan", title: "orphan", type: "terminal", groupId: "gone" },
        ]}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={() => {}}
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    expect(
      [...host.querySelectorAll(".app-tab-row")].map((r) => r.textContent),
    ).toEqual(["docs", "logs", "shell", "deploy", "scratch", "orphan"]);
  });

  it("the phone drawer draws the same grouped structure as the rail", () => {
    setViewport(false, false);
    mount(pinnedShell());

    const drawer = host.querySelector("#app-share-drawer");
    expect(drawer).not.toBeNull();
    expect(
      [...drawer!.querySelectorAll(".app-tab-group-head")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["Ops3", "Web1", "Work1"]);
    expect(
      [...drawer!.querySelectorAll(".app-tab-row")].map((r) => r.textContent),
    ).toEqual(["docs", "logs", "shell", "deploy", "scratch"]);
    expect(drawer!.querySelector(".app-zone-divider")).not.toBeNull();
  });

  it("picking a pinned row from a folder still reports the id", () => {
    const picked: string[] = [];
    mount(
      <AppShareShell
        tabs={PINNED_TABS}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={(id) => picked.push(id)}
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    const docs = [...host.querySelectorAll<HTMLButtonElement>(".app-tab-row")]
      .find((r) => r.textContent === "docs")!;
    act(() => docs.click());
    expect(picked).toEqual(["p2"]);
  });

describe("the shared sidebar core renders the shell's rows", () => {
  it("every folder head carries the palette colour its colorIndex picks", () => {
    mount(pinnedShell());
    const folders = [...host.querySelectorAll<HTMLElement>(".group-folder")];
    expect(folders).toHaveLength(3);
    const palette = groupColors("dark");
    expect(folders[0].style.color).toBe(palette[0]);
    expect(folders[1].style.color).toBe(palette[1]);
    expect(folders[2].style.color).toBe(palette[2]);
  });

  it("the flap follows the folder: shut on a collapsed head, open on an expanded one", () => {
    mount(
      pinnedShell([
        { id: "g-ops", name: "Ops", colorIndex: 0, collapsed: true },
        { id: "g-work", name: "Work", colorIndex: 2, collapsed: false },
      ]),
    );
    const folders = [...host.querySelectorAll(".group-folder")];
    // FolderIcon draws one path shut, two open — the glanceable state.
    expect(folders[0].querySelectorAll("path")).toHaveLength(1);
    expect(folders[1].querySelectorAll("path")).toHaveLength(2);
  });

  it("every tab row carries its type icon — the same TAB_ICONS the host sidebar paints", () => {
    mount(pinnedShell());
    const rows = [...host.querySelectorAll<HTMLElement>(".app-tab-row")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector(".tab-icon")).not.toBeNull();
    }
    // The kind mark is per-type: a terminal row and a browser row do not
    // share one glyph.
    const marks = [...host.querySelectorAll(".app-tab-row[data-type]")].map(
      (r) => r.querySelector(".tab-icon")?.outerHTML,
    );
    expect(new Set(marks).size).toBeGreaterThan(1);
  });
});

describe("the new-tab picker (the host menu's shape)", () => {
  it("+ raises the kind rows; a Browser address rides onCreateBrowserTab with the host's scheme default", () => {
    const madeTabs: string[] = [];
    const madeUrls: string[] = [];
    mount(
      <AppShareShell
        tabs={PINNED_TABS}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={() => {}}
        onCreateTab={(type) => madeTabs.push(type)}
        onCreateBrowserTab={(url) => madeUrls.push(url)}
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    act(() => host.querySelector<HTMLButtonElement>(".app-new-button")!.click());
    const menuRows = [...host.querySelectorAll<HTMLButtonElement>(".app-new-menu-row")];
    expect(menuRows.length).toBe(5); // terminal, files, agent, settings, browser
    // A kind row asks for that tab on the host.
    act(() =>
      menuRows.find((r) => r.textContent!.includes("Files"))!.click(),
    );
    expect(madeTabs).toEqual(["files"]);

    // The Browser row expands the address field; a bare host gets the
    // browser default scheme, an explicit one rides as typed.
    act(() => host.querySelector<HTMLButtonElement>(".app-new-button")!.click());
    const again = [...host.querySelectorAll<HTMLButtonElement>(".app-new-menu-row")];
    act(() => again.find((r) => r.textContent!.startsWith("Browser"))!.click());
    const input = host.querySelector<HTMLInputElement>(".app-new-menu-browser input")!;
    const form = host.querySelector<HTMLFormElement>(".app-new-menu-browser")!;
    const setVal = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setVal.call(input, "example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(madeUrls).toEqual(["https://example.com"]);
  });

  it("view level: no + button at all (creation is a write)", () => {
    mount(
      <AppShareShell
        tabs={PINNED_TABS}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={() => {}}
        readOnly
        onCreateTab={() => {}}
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    expect(host.querySelector(".app-new-button")).toBeNull();
  });

  it("a folder head forwards the fold at Steer and renders inert at view", () => {
    const toggled: string[] = [];
    mount(
      <AppShareShell
        tabs={PINNED_TABS}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={() => {}}
        onToggleGroup={(id) => toggled.push(id)}
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    const head = host.querySelector<HTMLElement>(".app-tab-group-head")!;
    expect(head.getAttribute("role")).toBe("button");
    act(() => head.click());
    expect(toggled).toEqual(["g-ops"]);

    mount(
      <AppShareShell
        tabs={PINNED_TABS}
        groups={PINNED_GROUPS}
        activeId="p3"
        onSelect={() => {}}
        readOnly
      >
        <p className="pane">active pane</p>
      </AppShareShell>,
    );
    expect(host.querySelector(".app-tab-group-head")!.getAttribute("role")).toBeNull();
  });
});

describe("defaultFitFor", () => {
  it("a tab-level share always starts fitted — the host grid follows the viewer", () => {
    expect(defaultFitFor("terminal", true)).toBe(true);
    expect(defaultFitFor("terminal", false)).toBe(true);
    expect(defaultFitFor(null, false)).toBe(true);
  });

  it("an app share fits where the rail fits, and starts at 100% on a phone", () => {
    expect(defaultFitFor("app", true)).toBe(true);
    expect(defaultFitFor("app", false)).toBe(false);
  });
});

});

describe("LocalTabsVault", () => {
  it("exactly one of localContent and the app shell is on screen, in both directions", () => {
    mount(
      <LocalTabsVault appActive={false} localContent={<p className="local">local tabs</p>}>
        <p className="app">app shell</p>
      </LocalTabsVault>,
    );
    expect(host.querySelector(".local")).not.toBeNull();
    expect(host.querySelector(".app")).toBeNull();

    // The join arrives: same mount, the swap flips.
    mount(
      <LocalTabsVault appActive={true} localContent={<p className="local">local tabs</p>}>
        <p className="app">app shell</p>
      </LocalTabsVault>,
    );
    expect(host.querySelector(".app")).not.toBeNull();
    expect(host.querySelector(".local")).toBeNull();
  });
});
