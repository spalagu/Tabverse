import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


// ------------------------------------------------------------ the stand-ins

/** Every terminal that was ever constructed, oldest first. */
const built: FakeTerminal[] = [];

interface FakeOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  theme?: unknown;
  [key: string]: unknown;
}

class FakeTerminal {
  options: FakeOptions;
  cols = 80;
  rows = 24;
  unicode = {};
  /** What `loadAddon` was handed, in order — read by the addon wiring
   * assertions (graphemes via terminalLigatures.test.ts, images below). */
  addons: unknown[] = [];
  parser = {
    registerOscHandler: () => ({ dispose: () => {} }),
    registerCsiHandler: () => ({ dispose: () => {} }),
  };
  buffer = { active: { type: "normal", cursorY: 0, viewportY: 0 } };

  constructor(options: FakeOptions) {
    this.options = { ...options };
    built.push(this);
  }
  loadAddon(addon: unknown) {
    this.addons.push(addon);
  }
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
  onData() {
    return { dispose: () => {} };
  }
  onBinary() {
    return { dispose: () => {} };
  }
  onResize() {
    return { dispose: () => {} };
  }
  attachCustomKeyEventHandler() {}
  registerLinkProvider() {
    return { dispose: () => {} };
  }
  registerMarker() {
    return null;
  }
  focus() {}
  clear() {}
  scrollToLine() {}
  dispose() {}
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    // A plausible grid: what matters is that it is finite and stable, so a
    // refit after a font change is not what changes the assertions below.
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
// Records the options it was constructed with — the whole point of the
// storage-limit assertion below.
vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {
    constructor(public options?: Record<string, unknown>) {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
// The key conventions negotiate with a real xterm parser; they have nothing
// to do with fonts.
vi.mock("../term/keys", () => ({ installMacKeyConventions: () => {} }));
// The screen-memory doorway would reach for storage on mount and on unmount.
vi.mock("../persist", () => ({
  loadState: () => Promise.resolve(null),
  saveState: () => {},
  deleteState: () => {},
  flushAll: () => Promise.resolve(),
}));

// Imported after the mocks are declared, so the component under test picks
// them up.
const { TerminalView } = await import("./TerminalView");
const { backend } = await import("../backend");
type CreateTermOpts = import("../backend").CreateTermOpts;
const { ImageAddon } = await import("@xterm/addon-image");
const { setTerminalFont, resetTerminalFontForTest } = await import(
  "../term/font"
);
type TerminalFont = import("../term/font").TerminalFont;
const { setTerminalImageMemoryForTest } = await import("../state/config");
const { useStore } = await import("../state/store");
type Tab = import("../state/store").Tab;

// ------------------------------------------------------------- the harness

/** Sessions the component asked the backend for, in order. */
let sessions: string[] = [];
/** The complete creation request for each spawn attempt. */
let createdWith: CreateTermOpts[] = [];
/** Make the next spawn carrying a cwd fail, to exercise the fallback. */
let failCwdOnce = false;

const FIRST: TerminalFont = {
  family: "Fira Code",
  size: 15,
  lineHeightPercent: 130,
};
const SECOND: TerminalFont = {
  family: "IBM Plex Mono",
  size: 20,
  lineHeightPercent: 160,
};

function aTab(profile?: string): Tab {
  return {
    id: "tab-font-1",
    type: "terminal",
    title: "Terminal",
    groupId: null,
    cwd: "/tmp",
    profile,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  built.length = 0;
  sessions = [];
  createdWith = [];
  failCwdOnce = false;
  resetTerminalFontForTest();
  // React's own flag for "this run may use act()"; without it every render
  // below warns that the environment is not configured for one.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // A laid-out pane. The component refuses to spawn a shell into a container
  // it has not seen a plausible size for, which in a headless run is every
  // container.
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
    createdWith.push({ ...opts });
    if (failCwdOnce && opts.cwd !== undefined) {
      failCwdOnce = false;
      throw new Error("cwd unavailable");
    }
    const handle = await create(opts);
    sessions.push(handle.id);
    return handle;
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
  setTerminalImageMemoryForTest(null);
  vi.restoreAllMocks();
});

/** Mount one terminal pane and let its session start. */
async function mountTerminal(tab: Tab = aTab()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const el = host;
  await act(async () => {
    root = createRoot(el);
    root.render(createElement(TerminalView, { tab, active: true }));
  });
  // The spawn is a promise chain; let it settle so there is a session to
  // claim was kept.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The terminal on screen — the newest built, which under a correct
 * implementation is also the only one. */
const onScreen = (): FakeTerminal => built[built.length - 1];

// ------------------------------------------------------------------ tests

describe("a font change reaches a terminal that is already open", () => {
  it("changes what it draws with, and keeps the session it is running", async () => {
    setTerminalFont(FIRST);
    await mountTerminal();

    expect(built.length, "one terminal was opened").toBe(1);
    expect(sessions.length, "one shell was started").toBe(1);
    const sessionBefore = sessions[0];
    expect(onScreen().options.fontSize).toBe(FIRST.size);

    await act(async () => {
      setTerminalFont(SECOND);
    });

    // Half one: the change is on screen.
    expect(onScreen().options.fontSize).toBe(SECOND.size);
    expect(onScreen().options.lineHeight).toBe(1.6);
    expect(onScreen().options.fontFamily).toContain(`"${SECOND.family}"`);

    // Half two, and the half that judges: it is the SAME terminal, running
    // the SAME shell. An implementation that re-created the terminal to give
    // it the new font passes everything above and fails here — the id below
    // would be a second session's, with the first one's scrollback, history
    // and processes gone.
    expect(sessions, "no second shell was started").toEqual([sessionBefore]);
  });

  it("keeps the icon font behind the family the user named", async () => {
    setTerminalFont(FIRST);
    await mountTerminal();
    await act(async () => {
      setTerminalFont(SECOND);
    });
    // The bundled symbols font is the only source of the Private Use Area
    // glyphs a prompt draws its separators with. A family that replaced the
    // stack instead of leading it turns every one of them into a tofu box.
    const family = String(onScreen().options.fontFamily);
    expect(family).toContain('"Tabverse Symbols"');
    expect(family.indexOf(`"${SECOND.family}"`)).toBeLessThan(
      family.indexOf('"Tabverse Symbols"')
    );
  });

  it("does not start a shell before the font is known", async () => {
    await mountTerminal();
    expect(sessions.length, "the shell started without a font").toBe(1);
    // And when the font arrives afterwards, the terminal that was born
    // without it takes it — still without a second shell.
    await act(async () => {
      setTerminalFont(SECOND);
    });
    expect(onScreen().options.fontSize).toBe(SECOND.size);
    expect(sessions.length).toBe(1);
  });
});

describe("a profile reaches the shell spawn", () => {
  it("passes the tab's profile name to the backend", async () => {
    await mountTerminal(aTab("deploy"));

    expect(createdWith).toHaveLength(1);
    expect(createdWith[0].profile).toBe("deploy");
  });

  it("keeps the profile when an unavailable cwd falls back", async () => {
    failCwdOnce = true;
    await mountTerminal(aTab("deploy"));

    expect(createdWith).toHaveLength(2);
    expect(createdWith[0]).toMatchObject({ cwd: "/tmp", profile: "deploy" });
    expect(createdWith[1].cwd).toBeUndefined();
    expect(createdWith[1].profile).toBe("deploy");
    expect(sessions).toHaveLength(1);
  });
});

describe("the store is left out of it", () => {
  it("does not need a tab in the store to draw with the user's font", () => {
    // The font travels through src/term/font.ts, not through the store —
    // which is what lets a terminal in any container follow the setting.
    expect(useStore.getState().tabs.some((t) => t.id === "tab-font-1")).toBe(
      false
    );
  });
});

describe("the image addon a terminal is created with", () => {
  /** The image stand-in on the newest terminal, with its ctor options. */
  const imageAddon = (t: FakeTerminal) =>
    t.addons.find(
      (a): a is InstanceType<typeof ImageAddon> & {
        options?: Record<string, unknown>;
      } => a instanceof ImageAddon
    );

  it("carries the configured per-pane storage limit", async () => {
    setTerminalImageMemoryForTest(64);
    await mountTerminal();

    const addon = imageAddon(onScreen());
    expect(addon, "the image addon was loaded").toBeDefined();
    expect(addon!.options?.sixelSupport).toBe(true);
    expect(addon!.options?.iipSupport).toBe(true);
    // THE judged value: what the configuration published is what the addon
    // was constructed with. An implementation that hard-coded the default
    // here would pass every settings-page test and still give every pane a
    // limit the user cannot change.
    expect(addon!.options?.storageLimit, "the configured limit").toBe(64);
  });

  it("passes no limit when nothing has been published", async () => {
    // Null is "not read yet" — and the honest answer is to pass nothing and
    // let the addon's own default apply, never a number written down here.
    setTerminalImageMemoryForTest(null);
    await mountTerminal();
    const addon = imageAddon(onScreen());
    expect(addon).toBeDefined();
    expect(addon!.options?.storageLimit).toBeUndefined();
  });
});
