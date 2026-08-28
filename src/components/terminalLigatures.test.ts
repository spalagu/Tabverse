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
  /** Exactly what `loadAddon` was handed, in order — the record every
   * judgement below reads. */
  addons: unknown[] = [];
  cols = 80;
  rows = 24;
  atlasClears = 0;
  refreshes: { start: number; end: number }[] = [];
  unicode: { activeVersion?: string } = {};
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
  clearTextureAtlas() {
    this.atlasClears++;
  }
  refresh(start: number, end: number) {
    this.refreshes.push({ start, end });
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
// The two addons this file is about. Stand-ins rather than the real ones
// because the real WebGL addon wants a GPU context and the real ligature
// addon wants a laid-out element — and because an identity is all that is
// being asked for: which of these two classes did this terminal receive.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class {
    dispose() {}
  },
}));
vi.mock("../term/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("../persist", () => ({
  loadState: () => Promise.resolve(null),
  saveState: () => {},
  deleteState: () => {},
  flushAll: () => Promise.resolve(),
}));

const { TerminalView } = await import("./TerminalView");
const { WebglAddon } = await import("@xterm/addon-webgl");
const { LigaturesAddon } = await import("@xterm/addon-ligatures");
const { UnicodeGraphemesAddon } = await import(
  "@xterm/addon-unicode-graphemes"
);
const {
  LIGATURE_FONT_FAMILY,
  resetTerminalFontForTest,
  setProfileLigatures,
  setTerminalFont,
  setTerminalLigatures,
} = await import("../term/font");
type TerminalFont = import("../term/font").TerminalFont;
type Tab = import("../state/store").Tab;

// ------------------------------------------------------------- the harness

/** A font a test chose. The app's defaults live in `impl Default for Config`
 * and are never restated here. */
const CHOSEN: TerminalFont = {
  family: "IBM Plex Mono",
  size: 15,
  lineHeightPercent: 130,
};

/** The profile the mixed-window case opens its second terminal under. */
const CODE_PROFILE = "Code";

function aTab(id: string, profile?: string): Tab {
  const tab: Tab & { profile?: string } = {
    id,
    type: "terminal",
    title: "Terminal",
    groupId: null,
    cwd: "/tmp",
  };
  if (profile !== undefined) tab.profile = profile;
  return tab;
}

const roots: { root: Root; host: HTMLElement }[] = [];

beforeEach(() => {
  built.length = 0;
  resetTerminalFontForTest();
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
});

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
});

/** Open one terminal pane in this window and let its session start. */
async function mountTerminal(tab: Tab): Promise<FakeTerminal> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    const root = createRoot(host);
    roots.push({ root, host });
    root.render(createElement(TerminalView, { tab, active: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return built[built.length - 1];
}

/** Whether this terminal is running on the GPU renderer — asked of the
 * instance, which is where the answer actually is. */
const hasWebgl = (t: FakeTerminal): boolean =>
  t.addons.some((a) => a instanceof WebglAddon);

/** Whether this terminal was given the ligature addon. */
const hasLigatures = (t: FakeTerminal): boolean =>
  t.addons.some((a) => a instanceof LigaturesAddon);

// ------------------------------------------------------------------ tests

describe("a terminal opened with ligatures on", () => {
  it("runs without the GPU renderer, and carries the ligature addon", async () => {
    setTerminalFont(CHOSEN);
    setTerminalLigatures(true);

    const term = await mountTerminal(aTab("tab-lig-on"));

    expect(hasWebgl(term), "no WebGL addon on a ligature terminal").toBe(false);
    expect(hasLigatures(term), "the ligature addon was loaded").toBe(true);
  });

  it("draws with the bundled ligature face in front, icons still behind it", async () => {
    setTerminalFont(CHOSEN);
    setTerminalLigatures(true);

    const term = await mountTerminal(aTab("tab-lig-stack"));
    const family = String(term.options.fontFamily);

    expect(family.startsWith(`${LIGATURE_FONT_FAMILY}, `)).toBe(true);
    // And IN FRONT OF, not INSTEAD OF. The bundled symbols font is the only
    // source of the Private Use Area glyphs a starship prompt draws with, and
    // the family the user named still draws every codepoint the ligature face
    // does not carry. A stack that was replaced turns both into tofu.
    expect(family).toContain('"Tabverse Symbols"');
    expect(family).toContain(`"${CHOSEN.family}"`);
  });
});

describe("a terminal opened with ligatures off", () => {
  it("still gets the GPU renderer, and no ligature addon", async () => {
    setTerminalFont(CHOSEN);
    setTerminalLigatures(false);

    const term = await mountTerminal(aTab("tab-lig-off"));

    expect(hasWebgl(term), "GPU acceleration is untouched here").toBe(true);
    expect(hasLigatures(term)).toBe(false);
    expect(String(term.options.fontFamily)).not.toContain(
      LIGATURE_FONT_FAMILY
    );
  });
});

describe("a terminal returning from a hidden tab", () => {
  it("repairs its canvas atlas and redraws every visible row", async () => {
    setTerminalLigatures(false);
    const tab = aTab("tab-returning");
    const term = await mountTerminal(tab);
    const entry = roots[roots.length - 1]!;
    const beforeClears = term.atlasClears;
    const beforeRefreshes = term.refreshes.length;

    vi.useFakeTimers();
    await act(async () => {
      entry.root.render(createElement(TerminalView, { tab, active: false }));
    });
    await act(async () => {
      entry.root.render(createElement(TerminalView, { tab, active: true }));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    expect(term.atlasClears).toBe(beforeClears + 1);
    expect(term.refreshes.slice(beforeRefreshes)).toEqual([
      { start: 0, end: term.rows - 1 },
    ]);
  });
});

describe("two terminals in one window", () => {
  it("each follow their own profile — one ligatures, one GPU", async () => {
    setTerminalFont(CHOSEN);
    setTerminalLigatures(false);
    setProfileLigatures({ [CODE_PROFILE]: true });

    const plain = await mountTerminal(aTab("tab-pair-plain"));
    const code = await mountTerminal(aTab("tab-pair-code", CODE_PROFILE));

    expect(hasWebgl(code), "the code profile gave up the GPU renderer").toBe(
      false
    );
    expect(hasLigatures(code)).toBe(true);
    expect(hasWebgl(plain), "the other terminal kept it").toBe(true);
    expect(hasLigatures(plain)).toBe(false);
    // And the fonts they draw with differ in the same direction.
    expect(String(code.options.fontFamily)).toContain(LIGATURE_FONT_FAMILY);
    expect(String(plain.options.fontFamily)).not.toContain(
      LIGATURE_FONT_FAMILY
    );
  });
});

describe("the width provider every terminal loads", () => {
  it("is the grapheme addon, with no activeVersion assignment", async () => {
    setTerminalFont(CHOSEN);
    setTerminalLigatures(false);

    const term = await mountTerminal(aTab("tab-graphemes"));

    // The identity half of the swap: which addon this terminal received.
    // The width behaviour itself is judged by src/term/graphemeWidths.test.ts
    // against a real Terminal — a stand-in has no cell model and cannot be
    // wrong about a width — so here the question is only whether this file's
    // wiring hands the instance the addon the probe measured.
    expect(
      term.addons.some((a) => a instanceof UnicodeGraphemesAddon),
      "the grapheme addon was loaded"
    ).toBe(true);
    // The old provider's protocol was `term.unicode.activeVersion = "11"` —
    // assigning one now would reselect the wcwidth tables and undo the
    // grapheme load. The stand-in starts with an undefined version, so any
    // assignment would leave a value behind.
    expect(term.unicode.activeVersion).toBeUndefined();
  });
});
