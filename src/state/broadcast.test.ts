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
vi.mock("../term/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("../persist", () => ({
  SESSION_SCOPE: "session-test",
  loadState: () => Promise.resolve(null),
  saveState: () => {},
  deleteState: () => {},
  flushAll: () => Promise.resolve(),
}));

const { TerminalView } = await import("../components/TerminalView");
const { backend } = await import("../backend");
const { useStore, withPresetGroups, sessionSnapshot } = await import(
  "../state/store"
);
type Tab = import("../state/store").Tab;
const { getPaneTerm } = await import("../termRegistry");
const { shareBlockedReason } = await import(
  "../share/framework/terminalBlocking"
);

/** What each pane's shell was handed, keyed by the shell's own handle id. */
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

/** Mount both panes (mount order = panes order) and let the shells spawn. */
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

/** Type into the FIRST pane through its terminal's own onData wiring. */
async function typeIntoFirst(text: string) {
  const term = built[0];
  expect(term, "no terminal mounted").toBeDefined();
  await act(async () => {
    term.onDataCbs.forEach((cb) => cb(text));
  });
}

/** The writes the two panes' shells received. */
const writes = (): { first: string[]; second: string[] } => {
  const values = Object.values(shellWrites);
  return {
    first: values[0] ?? [],
    second: values[1] ?? [],
  };
};

describe("broadcast on: one keystroke, every pane", () => {
  it("reaches the other pane's shell unchanged", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    useStore.getState().toggleBroadcast(tab.id);

    await typeIntoFirst("ls -la\n");

    const w = writes();
    expect(w.first).toContain("ls -la\n");
    expect(w.second).toContain("ls -la\n");
  });
});

describe("broadcast off: one keystroke, one pane", () => {
  it("leaves the other pane's shell untouched", async () => {
    const { tab } = splitTab();
    await mountPanes(tab, [tab.id, "p2"]);

    await typeIntoFirst("ls -la\n");

    const w = writes();
    expect(w.first).toContain("ls -la\n");
    expect(w.second).not.toContain("ls -la\n");
  });
});

describe("the negative space", () => {
  it("a Rerun through runCommand does not reach the other pane", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    useStore.getState().toggleBroadcast(tab.id);
    for (const key of Object.keys(shellWrites)) delete shellWrites[key];

    getPaneTerm(tab.id, panes[0])?.runCommand("cargo test");

    const w = writes();
    expect(w.first).toContain("cargo test\n");
    expect(w.second).toEqual([]);
  });
});

describe("the switch and the share", () => {
  it("refuses to turn on while sharing, and blocks the share while on", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().setTabShare(id, {
      shareId: "s",
      ticket: "t",
      joinLink: "https://example.invalid/#t",
      access: "steer",
      viewers: [],
      ttlSecs: 3600,
      startedAt: 1,
    });
    expect(useStore.getState().toggleBroadcast(id)).toEqual({
      on: false,
      refused: "sharing",
    });
    // The other direction: broadcast on, and the share entrance greys even
    // for a single-pane tab (which "panes" would allow).
    const other = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().toggleBroadcast(other);
    const bare = {
      ...useStore.getState().tabs.find((t) => t.id === other)!,
      panes: undefined,
    };
    expect(shareBlockedReason(bare)).toBe("broadcast");
  });

  it("never rides the session snapshot", () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    useStore.getState().toggleBroadcast(id);
    expect(JSON.stringify(sessionSnapshot(useStore.getState()))).not.toContain(
      "broadcast"
    );
  });
});
