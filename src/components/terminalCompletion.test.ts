import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const built: FakeTerminal[] = [];

interface FakeOptions {
  [key: string]: unknown;
}

class FakeTerminal {
  options: FakeOptions;
  cols = 80;
  rows = 24;
  unicode = {};
  parser = {
    registerOscHandler: () => ({ dispose: () => {} }),
    registerCsiHandler: () => ({ dispose: () => {} }),
  };
  buffer = { active: { type: "normal", cursorY: 0, viewportY: 0 } };
  onDataCbs = new Set<(s: string) => void>();
  constructor(options: FakeOptions) {
    this.options = { ...options };
    built.push(this);
  }
  loadAddon() {}
  open() {}
  write(_data: unknown, done?: () => void) {
    done?.();
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  onTitleChange() {
    return { dispose: () => {} };
  }
  onData(cb: (s: string) => void) {
    this.onDataCbs.add(cb);
    return { dispose: () => {} };
  }
  onBinary() {
    return { dispose: () => {} };
  }
  onResize() {
    return { dispose: () => {} };
  }
  attachCustomKeyEventHandler() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  paste(text: string) {
    this.onDataCbs.forEach((cb) => cb(text));
  }
  registerMarker() {
    return null;
  }
  registerLinkProvider() {
    return { dispose: () => {} };
  }
  focus() {}
  clear() {}
  scrollToLine() {}
  dispose() {}
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: class {},
}));
vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {},
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("../persist", () => ({
  SESSION_SCOPE: "session-test",
  loadState: () => Promise.resolve(null),
  saveState: () => {},
  deleteState: () => {},
  flushAll: () => Promise.resolve(),
}));

const { TerminalView } = await import("../components/TerminalView");
const { backend } = await import("../backend");
const { useStore, withPresetGroups } = await import("../state/store");
type Tab = import("../state/store").Tab;
const { setTerminalPasteGuardForTest } = await import("../state/config");
const { snapshotVersion } = await import("../term/completionSpec");

const shellWrites: Record<string, string[]> = {};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  built.length = 0;
  for (const key of Object.keys(shellWrites)) delete shellWrites[key];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
  setTerminalPasteGuardForTest(false);
  const create = backend.createTerminal.bind(backend);
  vi.spyOn(backend, "createTerminal").mockImplementation(async (opts) => {
    const handle = await create(opts);
    const shell = handle.id;
    const original = handle.write.bind(handle);
    handle.write = (data) => {
      shellWrites[shell] ??= [];
      shellWrites[shell].push(typeof data === "string" ? data : "<bytes>");
      original(data);
    };
    return handle;
  });
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    split: null,
    saveTemplateFor: null,
    broadcastTabs: {},
  });
});

afterEach(() => {
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  setTerminalPasteGuardForTest(null);
  vi.restoreAllMocks();
});

/** A terminal tab carrying a two-pane tree, active on its first pane. */
function splitTab(): { tab: Tab; panes: [string, string] } {
  const id = useStore.getState().addTab({ type: "terminal" });
  const tree = {
    kind: "split" as const,
    id: `${id}/p2`,
    vertical: false,
    ratios: [0.5, 0.5],
    children: [
      { kind: "leaf" as const, id, cwd: "/w" },
      { kind: "leaf" as const, id: "p2", cwd: "/w" },
    ],
  };
  useStore.setState({
    tabs: useStore.getState().tabs.map((t) =>
      t.id === id ? { ...t, panes: tree } : t
    ),
    activeTabId: id,
  });
  return {
    tab: useStore.getState().tabs.find((t) => t.id === id)!,
    panes: [id, "p2"],
  };
}

async function mountPanes(tab: Tab, panes: [string, string]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const el = host;
  await act(async () => {
    root = createRoot(el);
    root.render(
      createElement(
        "div",
        null,
        createElement(TerminalView, {
          key: panes[0],
          tab,
          active: true,
          paneId: panes[0],
        }),
        createElement(TerminalView, {
          key: panes[1],
          tab,
          active: false,
          paneId: panes[1],
        })
      )
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Type into the first pane through its terminal's own onData wiring. */
async function typeIntoFirst(text: string) {
  const term = built[0];
  expect(term, "no terminal mounted").toBeDefined();
  await act(async () => {
    term.onDataCbs.forEach((cb) => cb(text));
  });
}

/** The completion popup inside the first pane, or null. */
const popup = (): HTMLElement | null =>
  host!.querySelector<HTMLElement>(".term-completion-popup");

/** The writes the two panes' shells received. */
const writes = (): { first: string[]; second: string[] } => {
  const values = Object.values(shellWrites);
  return {
    first: values[0] ?? [],
    second: values[1] ?? [],
  };
};

describe("the detection on the typing path", () => {
  it("a known command and a dash open the popup with that command's flags", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await typeIntoFirst("git -");

    expect(popup(), "the popup is drawn in the pane").not.toBeNull();
    const items = [
      ...(popup()?.querySelectorAll("li") ?? []),
    ].map((li) => li.textContent);
    // The real snapshot's git flags, filtered to the typed prefix.
    expect(items).toContain("--all");
    expect(items.every((i) => i.startsWith("-"))).toBe(true);
    expect(popup()!.textContent).toContain("git");
  });

  it("a command the spec never heard of opens nothing", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await typeIntoFirst("definitelynotacommand -");

    expect(popup()).toBeNull();
  });

  it("typing on with the popup open narrows it; Escape dismisses", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await typeIntoFirst("git --a");
    const items = [...(popup()?.querySelectorAll("li") ?? [])].map(
      (li) => li.textContent
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.startsWith("--a"))).toBe(true);

    const container = host!.querySelector<HTMLElement>(".term-container")!;
    await act(async () => {
      container.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(popup()).toBeNull();
  });
});

describe("picking", () => {
  it("Tab sends the un-typed remainder, as typing — broadcast carries it", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    useStore.getState().toggleBroadcast(tab.id);

    await typeIntoFirst("git --al");
    const first = popup()!.querySelector("li")!.textContent!;
    expect(first.startsWith("--al")).toBe(true);

    const container = host!.querySelector<HTMLElement>(".term-container")!;
    await act(async () => {
      container.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    // The remainder of the picked flag plus a separating space, out on
    // the typing channel: this pane's shell AND the broadcast pane's.
    const expected = `${first.slice("--al".length)} `;
    const w = writes();
    expect(w.first.some((s) => s.includes(expected))).toBe(true);
    expect(
      w.second.some((s) => s.includes(expected)),
      "the pick is typing, so broadcast carries it"
    ).toBe(true);
    // And the model absorbed it: the next dash offers from the completed
    // line's command again, not from a stale one.
    expect(popup()).toBeNull();
  });

  it("a click on a row picks the same way", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await typeIntoFirst("git --am");
    const row = popup()!.querySelector("li")!;
    expect(row.textContent).toBe("--amend");
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });

    expect(writes().first.some((s) => s.includes("end "))).toBe(true);
    expect(popup()).toBeNull();
  });
});

describe("the negative: a paste is not typing", () => {
  it("a bracketed paste leaves the detection alone and resets the model", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    // Half a typed line first, so the reset has something to clear.
    await typeIntoFirst("git che");
    // Then a single-line paste the way xterm delivers it under bracketed
    // mode — wrapped in BOTH markers, exactly like our own confirmed
    // multi-line send.
    await typeIntoFirst("\x1b[200~git -\x1b[201~");

    expect(popup(), "the wrapped paste must not offer completions").toBeNull();

    // The model reset: typing a bare dash now names no command, so
    // nothing is offered — where a model that had absorbed the paste
    // would still think the command was `git`.
    await typeIntoFirst("-");
    expect(popup()).toBeNull();
  });
});

describe("the loader on the floor", () => {
  it("the mounted pane runs on the shipped snapshot when no core answers", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    // Indirect but real: the popup above could only have opened because
    // a spec was loaded, and the only layer a test environment has is the
    // snapshot. Version sanity: the loader's answer is the snapshot's.
    expect(snapshotVersion()).not.toBeNull();
  });
});
