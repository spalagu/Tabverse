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
  keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
  pasted: string[] = [];
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
  attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean) {
    this.keyHandler = cb;
  }
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  // xterm's own paste: reaches the shell through onData (mode-aware in the
  // real one; the fake carries no bracketed mode, so the text goes through
  // verbatim — which is exactly what the plain-channel assertions want).
  paste(text: string) {
    this.pasted.push(text);
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
const { bracketedPaste } = await import("../term/pasteGuard");

/** What each pane's shell was handed, keyed by the shell's own handle id. */
const shellWrites: Record<string, string[]> = {};

let root: Root | null = null;
let host: HTMLElement | null = null;

const clip = { writeText: vi.fn(), readText: vi.fn() };

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
  // The guard's switch is module-held config state; the default a test
  // wants is ON, set explicitly rather than inherited from whichever file
  // ran before this one.
  setTerminalPasteGuardForTest(true);
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
  clip.readText.mockReset().mockReturnValue(Promise.resolve(""));
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

/** ⌘V into the first pane, through the real key-convention handler. */
async function pressCmdV(text: string) {
  const term = built[0];
  expect(term, "no terminal mounted").toBeDefined();
  clip.readText.mockReturnValue(Promise.resolve(text));
  await act(async () => {
    const swallowed = term.keyHandler!({
      type: "keydown",
      key: "v",
      code: "",
      keyCode: 0,
      shiftKey: false,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
    } as KeyboardEvent);
    expect(swallowed, "⌘V must not reach the program as a control code").toBe(
      false
    );
    await Promise.resolve();
  });
}

/** A DOM paste into the first pane's container — the native menu's route. */
async function domPaste(text: string) {
  const container = host!.querySelector<HTMLElement>(".term-container");
  expect(container, "no term container mounted").not.toBeNull();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    container!.dispatchEvent(ev);
  });
  expect(ev.defaultPrevented, "the DOM paste must not reach xterm's own wiring").toBe(
    true
  );
}

/** The guard's dialog, once open. */
function dialog(): HTMLTextAreaElement {
  const ta = host!.querySelector<HTMLTextAreaElement>(".term-paste-textarea");
  expect(ta, "the paste dialog is open").not.toBeNull();
  return ta!;
}

/** The writes the two panes' shells received. */
const writes = (): { first: string[]; second: string[] } => {
  const values = Object.values(shellWrites);
  return {
    first: values[0] ?? [],
    second: values[1] ?? [],
  };
};

describe("both paths ask on a multi-line paste", () => {
  it("⌘V with two lines opens the preview and sends nothing yet", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await pressCmdV("git status\ngit diff");

    expect(dialog().value).toBe("git status\ngit diff");
    const w = writes();
    expect(w.first).toEqual([]);
    // xterm's own paste never ran either — that would bypass the asking.
    expect(built[0].pasted).toEqual([]);
  });

  it("a DOM paste with two lines opens the same preview", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await domPaste("one\ntwo\nthree");

    expect(dialog().value).toBe("one\ntwo\nthree");
    expect(writes().first).toEqual([]);
    expect(built[0].pasted).toEqual([]);
  });
});

describe("single lines pass without a dialog, on the plain channel", () => {
  it("⌘V with one line reaches the shell and asks nothing", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await pressCmdV("ls -la");

    expect(
      host!.querySelector(".term-paste-overlay"),
      "one line must not open the dialog"
    ).toBeNull();
    // The channel a single line has always used: xterm's own paste, which
    // reaches the shell through the same onData wiring typing does.
    expect(built[0].pasted).toEqual(["ls -la"]);
    expect(writes().first).toContain("ls -la");
  });

  it("a DOM paste with one line reaches the shell and asks nothing", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await domPaste("echo hi");

    expect(host!.querySelector(".term-paste-overlay")).toBeNull();
    expect(built[0].pasted).toEqual(["echo hi"]);
    expect(writes().first).toContain("echo hi");
  });
});

describe("the confirmed send: wrapped bytes, broadcast-shaped", () => {
  it("Enter in the dialog sends the bracketed paste to every pane", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    useStore.getState().toggleBroadcast(tab.id);

    await domPaste("cargo build\ncargo test");
    const expected = bracketedPaste("cargo build\ncargo test");
    await act(async () => {
      dialog().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    // The judging half: not "something was sent" but the exact bytes —
    // wrapped, verbatim, and fanned out to the pane the keyboard is not in.
    const w = writes();
    expect(w.first).toContain(expected);
    expect(w.second, "broadcast carries the paste to the other pane").toContain(
      expected
    );
    // And the dialog is gone.
    expect(host!.querySelector(".term-paste-overlay")).toBeNull();
  });

  it("sends the EDITED text — the preview is the edit", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await domPaste("rm -rf /\nouch");
    const ta = dialog();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    await act(async () => {
      setter.call(ta, "rm -rf /tmp/scratch\nfine");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(writes().first).toContain(
      bracketedPaste("rm -rf /tmp/scratch\nfine")
    );
    expect(writes().first.join("")).not.toContain("ouch");
  });
});

describe("the negatives", () => {
  it("Escape in the dialog sends nothing", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);

    await domPaste("a\nb");
    await act(async () => {
      dialog().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(writes().first).toEqual([]);
    expect(writes().second).toEqual([]);
    expect(host!.querySelector(".term-paste-overlay")).toBeNull();
  });

  it("the guard switched off lets multi-line text straight in, unwrapped", async () => {
    const { tab, panes } = splitTab();
    await mountPanes(tab, panes);
    setTerminalPasteGuardForTest(false);

    await domPaste("x\ny\nz");

    expect(host!.querySelector(".term-paste-overlay")).toBeNull();
    // Through the plain channel — no dialog, no bracketed markers of ours.
    expect(built[0].pasted).toEqual(["x\ny\nz"]);
    expect(writes().first).toContain("x\ny\nz");
    expect(writes().first.join("")).not.toContain("\x1b[200~");
  });
});
