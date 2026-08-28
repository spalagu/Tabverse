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
  unicode = { activeVersion: "11" };
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
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("./term/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("./persist", () => ({
  SESSION_SCOPE: "session-test",
  loadState: () => Promise.resolve(null),
  saveState: () => {},
  deleteState: () => {},
  flushAll: () => Promise.resolve(),
}));

const { TerminalView } = await import("./components/TerminalView");
const { backend } = await import("./backend");
const { useStore, withPresetGroups } = await import("./state/store");

/** What the pane's shell was handed, keyed by the shell's own handle id. */
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
    peekTabId: null,
    selectedTabIds: [],
    newTabMenuOpen: false,
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

/** Mount one plain terminal tab and let its shell spawn. */
async function mountTerminal(tabId: string): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  expect(tab, "the tab must exist before it can be mounted").toBeDefined();
  const el = host;
  await act(async () => {
    root = createRoot(el);
    root.render(
      createElement(TerminalView, { key: tabId, tab: tab!, active: true, paneId: tabId })
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Where the input method composes: xterm's own textarea in the real app, a
 * stood-in one here so the dispatch path (textarea → … → window, capture
 * first) is the real one. Appended to the body, not into the React tree.
 */
function helperTextarea(): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  document.body.appendChild(ta);
  ta.focus();
  return ta;
}

/** The bytes the pane's shell has received so far. */
const writes = (): string[] => Object.values(shellWrites)[0] ?? [];

describe("a composing terminal", () => {
  it("sends zero bytes to the PTY during composition, and delivers the commit after", async () => {
    const id = useStore.getState().addTab({ type: "terminal" });
    await mountTerminal(id);
    const ta = helperTextarea();

    // What got past the interface and back down to the input layer: a
    // bubble-phase listener on the window is the last thing a key event
    // reaches, so it sees exactly the keys nobody swallowed (the shape
    // `newTabMenuKeys.test.ts` uses to stand in for the terminal).
    const through: { key: string; prevented: boolean }[] = [];
    const throughListener = (e: KeyboardEvent) => {
      through.push({ key: e.key, prevented: e.defaultPrevented });
    };
    window.addEventListener("keydown", throughListener);

    try {
      act(() => {
        ta.dispatchEvent(new CompositionEvent("compositionstart"));
      });
      // The strokes an input method takes, in both platform shapes, plus
      // the two keys with somewhere wrong to go: a digit (the ⌘N picker's)
      // and the Escape that cancels the composition.
      const strokes: KeyboardEventInit[] = [
        { key: "Process", keyCode: 229 },
        { key: "a", isComposing: true },
        { key: "3", isComposing: true },
        { key: "Escape", isComposing: true },
      ];
      for (const s of strokes) {
        act(() => {
          ta.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...s })
          );
        });
      }

      // Zero bytes to the PTY, and every stroke let through un-prevented.
      expect(writes(), "nothing reaches the shell mid-composition").toEqual([]);
      expect(through).toEqual(
        strokes.map((s) => ({ key: s.key as string, prevented: false }))
      );

      // The commit: composition ends, the composed text is delivered as
      // input, and it reaches the shell like any other keystroke would.
      act(() => {
        ta.dispatchEvent(new CompositionEvent("compositionend"));
      });
      const term = built[0];
      expect(term, "the terminal must be mounted").toBeDefined();
      await act(async () => {
        term.onDataCbs.forEach((cb) => cb("\u4f60\u597d\n"));
      });
      expect(writes()).toContain("\u4f60\u597d\n");
    } finally {
      window.removeEventListener("keydown", throughListener);
      ta.remove();
    }
  });
});
