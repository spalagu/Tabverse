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
  osc = new Map<number, (data: string) => boolean>();
  parser = {
    registerOscHandler: (id: number, cb: (data: string) => boolean) => {
      this.osc.set(id, cb);
      return { dispose: () => {} };
    },
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
    // Alive at a stable line: blocks must actually form for the remote
    // switch to have anything to read.
    return { line: 5, disposed: false, dispose() {} };
  }
  registerDecoration(options: { marker: { disposed: boolean } }) {
    if (options.marker.disposed) return undefined;
    const deco = {
      marker: options.marker,
      options: { overviewRulerOptions: undefined as { color: string } | undefined },
      disposed: false,
      onRender(_cb: (el: HTMLElement) => void) {
        return { dispose() {} };
      },
      dispose() {
        this.disposed = true;
      },
    };
    return deco;
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
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class {} }));
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
const { STR } = await import("../strings");

const b64 = (s: string) => btoa(s);

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  built.length = 0;
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
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    split: null,
    saveTemplateFor: null,
    broadcastTabs: {},
    remoteTabs: {},
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

/** Mount one terminal tab, active, and let its shell spawn. */
async function mountTab(): Promise<string> {
  const id = useStore.getState().addTab({ type: "terminal" });
  const tab = useStore.getState().tabs.find((t) => t.id === id)!;
  useStore.setState({ activeTabId: id });
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(createElement(TerminalView, { tab, active: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return id;
}

const fireOsc = (id: number, data: string) => {
  act(() => {
    built[0].osc.get(id)!(data);
  });
};

const commandStart = (cmd: string) => fireOsc(133, `C;cmdline_b64=${b64(cmd)}`);
const commandEnd = () => fireOsc(133, "D;0");

const pane = (): HTMLElement => {
  const el = host!.querySelector(".term-pane");
  expect(el, "the pane is mounted").toBeDefined();
  return el as HTMLElement;
};

/** Dispatch a drop carrying the given dataTransfer shape. */
const drop = (dt: { types: string[]; files?: File[] }) => {
  act(() => {
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    pane().dispatchEvent(ev);
  });
};

describe("the remote two-state", () => {
  it("an ssh block puts the pane and the tab into the remote state", async () => {
    const id = await mountTab();
    commandStart("ssh prod.example.com");
    expect(useStore.getState().remoteTabs[id]).toEqual({
      host: "prod.example.com",
    });
    expect(pane().classList.contains("remote")).toBe(true);
    const badge = pane().querySelector(".term-remote-badge");
    expect(badge?.textContent).toBe("prod.example.com");
  });

  it("the block closing restores the local state", async () => {
    const id = await mountTab();
    commandStart("ssh -p 2222 deploy@bastion");
    commandEnd();
    expect(useStore.getState().remoteTabs[id]).toBeUndefined();
    expect(pane().classList.contains("remote")).toBe(false);
    expect(pane().querySelector(".term-remote-badge")).toBeNull();
  });

  it("a plain command never enters it", async () => {
    const id = await mountTab();
    commandStart("cargo build");
    expect(useStore.getState().remoteTabs[id]).toBeUndefined();
    expect(pane().classList.contains("remote")).toBe(false);
  });

  it("a far-side OSC 7 host calibrates the label but never switches it", async () => {
    const id = await mountTab();
    // The local shell's own report (no remote block): nothing happens.
    fireOsc(7, "file://my-laptop/Users/me");
    expect(useStore.getState().remoteTabs[id]).toBeUndefined();
    commandStart("ssh jump");
    // Inside the running ssh block, a report can only be the far side's.
    fireOsc(7, "file://far-side.example.com/home/me");
    expect(useStore.getState().remoteTabs[id]).toEqual({
      host: "far-side.example.com",
    });
    expect(pane().querySelector(".term-remote-badge")?.textContent).toBe(
      "far-side.example.com"
    );
  });

  it("broadcast and remote stack as two distinguishable layers", async () => {
    const id = await mountTab();
    useStore.getState().toggleBroadcast(id);
    commandStart("ssh prod.example.com");
    const el = pane();
    expect(el.classList.contains("broadcast")).toBe(true);
    expect(el.classList.contains("remote")).toBe(true);
    const banner = el.querySelector(".term-broadcast-banner");
    const badge = el.querySelector(".term-remote-badge");
    expect(banner).toBeDefined();
    expect(badge).toBeDefined();
    expect(banner).not.toBe(badge);
    expect(badge?.textContent).toBe("prod.example.com");
  });

  it("never rides the session snapshot", async () => {
    await mountTab();
    commandStart("ssh prod.example.com");
    expect(JSON.stringify(sessionSnapshot(useStore.getState()))).not.toContain(
      "remoteTabs"
    );
  });
});

describe("the scp pull entry", () => {
  const openMenu = () => {
    act(() => {
      pane()
        .querySelector(".term-container")!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        );
    });
  };

  it("appears only in a remote pane, and greyed until a path is hovered", async () => {
    await mountTab();
    openMenu();
    expect(host!.textContent).not.toContain(STR.term.pullFrom({ host: "x" }).split(" ")[0]);
    act(() => {
      // Any open menu closes again.
      pane().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    commandStart("ssh prod.example.com");
    openMenu();
    const item = [...host!.querySelectorAll<HTMLButtonElement>(".ctx-item")]
      .find((b) => b.textContent === STR.term.pullFrom({ host: "prod" }));
    expect(item, "the pull item is offered").toBeDefined();
    expect(item!.disabled).toBe(true); // no hover target yet
    expect(item!.title).toBe(STR.term.pullNeedsPath);

    // A path under the pointer (OSC 8 hover reaches the same tracking):
    act(() => {
      const hover = (built[0].options.linkHandler as {
        hover: (e: unknown, text: string) => void;
      }).hover;
      hover({}, "/var/log/app.log");
    });
    openMenu();
    const armed = [...host!.querySelectorAll<HTMLButtonElement>(".ctx-item")]
      .find((b) => b.textContent === STR.term.pullFrom({ host: "prod" }));
    expect(armed!.disabled).toBe(false);
  });

  it("a pull failure lands in the error state with scp's own words", async () => {
    await mountTab();
    commandStart("ssh prod.example.com");
    act(() => {
      const hover = (built[0].options.linkHandler as {
        hover: (e: unknown, text: string) => void;
      }).hover;
      hover({}, "/var/log/app.log");
    });
    openMenu();
    const armed = [...host!.querySelectorAll<HTMLButtonElement>(".ctx-item")]
      .find((b) => b.textContent === STR.term.pullFrom({ host: "prod" }));
    await act(async () => {
      armed!.click();
    });
    // The mock backend rejects with the honest demo-unavailable string.
    const err = host!.querySelector(".term-transfer-error");
    expect(err).toBeDefined();
    expect(err!.textContent).toContain(STR.term.demoNoTransfer);
  });
});

describe("the drop upload", () => {
  it("external files on a remote pane open the confirm, prefilled host:~", async () => {
    await mountTab();
    commandStart("ssh prod.example.com");
    drop({ types: ["Files"], files: [new File(["x"], "report.txt")] });
    const dialog = host!.querySelector(".term-upload-dialog");
    expect(dialog).toBeDefined();
    const input = dialog!.querySelector<HTMLInputElement>("#term-upload-dest");
    expect(input!.value).toBe("prod.example.com:~");
  });

  it("an internal tab drag never opens it", async () => {
    await mountTab();
    commandStart("ssh prod.example.com");
    drop({ types: ["text/tabverse-tab", "text/plain"] });
    expect(host!.querySelector(".term-upload-dialog")).toBeNull();
  });

  it("files on a local pane are not this feature's to take", async () => {
    await mountTab();
    drop({ types: ["Files"], files: [new File(["x"], "report.txt")] });
    expect(host!.querySelector(".term-upload-dialog")).toBeNull();
  });

  it("a push failure lands in the error state", async () => {
    await mountTab();
    commandStart("ssh prod.example.com");
    drop({ types: ["Files"], files: [new File(["bytes"], "report.txt")] });
    const dialog = host!.querySelector(".term-upload-dialog")!;
    await act(async () => {
      dialog
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((b) => {
          if (b.textContent === STR.term.uploadSubmit) b.click();
        });
    });
    const err = host!.querySelector(".term-transfer-error");
    expect(err).toBeDefined();
    expect(err!.textContent).toContain(STR.term.demoNoTransfer);
  });
});

describe("the mock backend's honest refusal", () => {
  it("rejects both transfers with the demo-unavailable string", async () => {
    await expect(backend.transferPull("h", "/x")).rejects.toThrow(
      STR.term.demoNoTransfer
    );
    await expect(
      backend.transferPush("h", "~", "f", b64("x"))
    ).rejects.toThrow(STR.term.demoNoTransfer);
  });
});
