import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TrackerOptions {
  onCwd?: (directory: string) => void;
}

const trackers: Array<{ options: TrackerOptions; disposed: boolean }> = [];

class FakeTerminal {
  static built: FakeTerminal[] = [];
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  buffer = { active: { type: "normal" } };
  writes: Array<string | Uint8Array> = [];
  focused = 0;
  disposed = false;
  private dataListeners = new Set<(data: string) => void>();
  private binaryListeners = new Set<(data: string) => void>();
  private resizeListeners = new Set<
    (size: { cols: number; rows: number }) => void
  >();

  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.built.push(this);
  }

  loadAddon() {}
  open() {}
  write(data: string | Uint8Array) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    return { dispose: () => this.dataListeners.delete(callback) };
  }
  onBinary(callback: (data: string) => void) {
    this.binaryListeners.add(callback);
    return { dispose: () => this.binaryListeners.delete(callback) };
  }
  onResize(callback: (size: { cols: number; rows: number }) => void) {
    this.resizeListeners.add(callback);
    return { dispose: () => this.resizeListeners.delete(callback) };
  }
  focus() {
    this.focused += 1;
  }
  dispose() {
    this.disposed = true;
  }
  emitInput(data: string) {
    this.dataListeners.forEach((callback) => callback(data));
  }
  emitBinary(data: string) {
    this.binaryListeners.forEach((callback) => callback(data));
  }
  emitResize(cols: number, rows: number) {
    this.resizeListeners.forEach((callback) => callback({ cols, rows }));
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 90, rows: 20 };
    }
  },
}));
vi.mock("../terminal/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("../terminal/blocks", () => ({
  BlockTracker: class {
    private record: { options: TrackerOptions; disposed: boolean };
    constructor(_terminal: unknown, options: TrackerOptions) {
      this.record = { options, disposed: false };
      trackers.push(this.record);
    }
    dispose() {
      this.record.disposed = true;
    }
  },
}));

const { TerminalPanel } = await import("./TerminalPanel");
const { cdCommand } = await import("./termSync");
const { resetTerminalFontForTest, setTerminalFont } = await import(
  "../terminal/font"
);

class FakeHandle {
  writes: Array<string | Uint8Array> = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  kills = 0;
  dataUnsubscribes = 0;
  exitUnsubscribes = 0;
  private dataListeners = new Set<(data: Uint8Array) => void>();
  private exitListeners = new Set<(code: number | null) => void>();

  write(data: string | Uint8Array) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }
  kill() {
    this.kills += 1;
  }
  onData(callback: (data: Uint8Array) => void) {
    this.dataListeners.add(callback);
    return () => {
      if (this.dataListeners.delete(callback)) this.dataUnsubscribes += 1;
    };
  }
  onExit(callback: (code: number | null) => void) {
    this.exitListeners.add(callback);
    return () => {
      if (this.exitListeners.delete(callback)) this.exitUnsubscribes += 1;
    };
  }
  emitData(data: Uint8Array) {
    this.dataListeners.forEach((callback) => callback(data));
  }
  emitExit(code: number | null = 0) {
    this.exitListeners.forEach((callback) => callback(code));
  }
}

interface RenderProps {
  cwd?: string;
  visible?: boolean;
  height?: number;
  theme?: string;
  onCwdChange?: (directory: string) => void;
  onHeightChange?: (height: number) => void;
  onClose?: () => void;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let handles: FakeHandle[] = [];
let createCalls: Array<{ cols: number; rows: number; cwd?: string }> = [];
let diagnostics: Array<{ level: string; message: string }> = [];
let failCwdOnce = false;
let offsetWidthDescriptor: PropertyDescriptor | undefined;
let offsetHeightDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;

const runtime = {
  async createTerminal(options: { cols: number; rows: number; cwd?: string }) {
    createCalls.push({ ...options });
    if (failCwdOnce && options.cwd !== undefined) {
      failCwdOnce = false;
      throw new Error("cwd unavailable");
    }
    const handle = new FakeHandle();
    handles.push(handle);
    return handle;
  },
  reportDiagnostic(level: "warn" | "error", message: string) {
    diagnostics.push({ level, message });
  },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  FakeTerminal.built.length = 0;
  trackers.length = 0;
  handles = [];
  createCalls = [];
  diagnostics = [];
  failCwdOnce = false;
  resetTerminalFontForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
  );
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
  );
  clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight"
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 220,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  resetTerminalFontForTest();
  if (offsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
  }
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
  }
  vi.restoreAllMocks();
});

async function renderPanel(props: RenderProps = {}) {
  await act(async () => {
    root?.render(
      <TerminalPanel
        cwd={props.cwd ?? "/work"}
        visible={props.visible ?? true}
        height={props.height ?? 220}
        theme={props.theme ?? "dark"}
        runtime={runtime}
        onCwdChange={props.onCwdChange ?? vi.fn()}
        onHeightChange={props.onHeightChange ?? vi.fn()}
        onClose={props.onClose ?? vi.fn()}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("shared files terminal panel", () => {
  it("creates lazily and keeps the same shell while hidden", async () => {
    await renderPanel({ visible: false });
    expect(createCalls).toEqual([]);
    expect(FakeTerminal.built).toHaveLength(0);

    await renderPanel({ visible: true });
    expect(createCalls).toEqual([{ cols: 90, rows: 20, cwd: "/work" }]);
    expect(handles).toHaveLength(1);

    await renderPanel({ visible: false });
    await renderPanel({ visible: true });
    expect(createCalls).toHaveLength(1);
    expect(handles[0].kills).toBe(0);
  });

  it("keeps an exit visible and creates a fresh shell on reopen", async () => {
    await renderPanel();
    await act(async () => handles[0].emitExit(9));
    expect(FakeTerminal.built[0].writes.join("")).toContain("Shell exited");

    await renderPanel({ visible: false });
    await renderPanel({ visible: true });
    expect(createCalls).toHaveLength(2);
    expect(handles[0].dataUnsubscribes).toBe(1);
    expect(handles[0].exitUnsubscribes).toBe(1);
    expect(handles[0].kills).toBe(1);
  });

  it("falls back to the default directory when cwd spawn fails", async () => {
    failCwdOnce = true;
    await renderPanel({ cwd: "/gone" });

    expect(createCalls).toEqual([
      { cols: 90, rows: 20, cwd: "/gone" },
      { cols: 90, rows: 20 },
    ]);
    expect(diagnostics[0]).toMatchObject({ level: "error" });
    expect(diagnostics[0].message).toContain("/gone");
    expect(FakeTerminal.built[0].writes.join("")).toContain(
      "starting in the default directory"
    );
  });

  it("wires input, binary, output and resize and releases PTY listeners", async () => {
    await renderPanel();
    const terminal = FakeTerminal.built[0];
    const handle = handles[0];

    terminal.emitInput("echo hi\n");
    terminal.emitBinary("\u0001\u00ff");
    terminal.emitResize(120, 40);
    handle.emitData(new Uint8Array([65, 66]));

    expect(handle.writes[0]).toBe("echo hi\n");
    expect(Array.from(handle.writes[1] as Uint8Array)).toEqual([1, 255]);
    expect(handle.resizes).toContainEqual({ cols: 120, rows: 40 });
    expect(terminal.writes.at(-1)).toEqual(new Uint8Array([65, 66]));

    await act(async () => root?.unmount());
    root = null;
    expect(handle.dataUnsubscribes).toBe(1);
    expect(handle.exitUnsubscribes).toBe(1);
    expect(handle.kills).toBe(1);
  });

  it("synchronizes reported shell cwd and updates theme and font in place", async () => {
    const onCwdChange = vi.fn();
    await renderPanel({ cwd: "/work", onCwdChange });
    const terminal = FakeTerminal.built[0];
    const originalTheme = terminal.options.theme;

    await act(async () => trackers[0].options.onCwd?.("/work"));
    await act(async () => trackers[0].options.onCwd?.("/elsewhere"));
    expect(onCwdChange).toHaveBeenCalledWith("/elsewhere");

    await renderPanel({ cwd: "/elsewhere", theme: "light", onCwdChange });
    expect(terminal.options.theme).not.toEqual(originalTheme);
    await act(async () =>
      setTerminalFont({
        family: "Fira Code",
        size: 18,
        lineHeightPercent: 140,
      })
    );
    expect(terminal.options.fontSize).toBe(17);
    expect(createCalls).toHaveLength(1);

    await renderPanel({ cwd: "/next", theme: "light", onCwdChange });
    expect(handles[0].writes).toContain(cdCommand("/next"));
  });

  it("removes drag listeners when unmounted during a gesture", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    await renderPanel();
    const grip = host?.querySelector(".file-term-grip");
    if (!(grip instanceof HTMLElement)) throw new Error("grip not found");

    await act(async () => {
      grip.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientY: 300 })
      );
    });
    await act(async () => root?.unmount());
    root = null;

    expect(remove).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("mouseup", expect.any(Function));
  });
});
