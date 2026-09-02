import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteView } from "./RemoteView";
import type { Tab } from "../state/store";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Shared with the hoisted module mocks below.
const h = vi.hoisted(() => {
  interface MockChannel {
    onmessage: (msg: unknown) => void;
  }
  const termInstances: Array<{ write: ReturnType<typeof vi.fn> }> = [];
  const channels: MockChannel[] = [];
  const invokeCalls: Array<{ cmd: string; args?: unknown }> = [];
  const residentReplays: unknown[] = [];
  return { termInstances, channels, invokeCalls, residentReplays };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (msg: unknown) => void = () => {};
    constructor() {
      h.channels.push(this);
    }
  },
  invoke: async (cmd: string, args?: unknown) => {
    h.invokeCalls.push({ cmd, args });
    if (cmd === "remote_join") return "join-1";
    if (cmd === "resident_poll") {
      return h.residentReplays.shift() ?? { events: [] };
    }
    return undefined;
  },
}));

// The construction spy this whole file is about: every `new Terminal()` in
// RemoteView lands in h.termInstances, and open() plants the .xterm marker
// the DOM assertions look for.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = { fontSize: 13 };
    unicode = { activeVersion: "" };
    parser = { registerCsiHandler: vi.fn() };
    attachCustomKeyEventHandler = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    reset = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    constructor() {
      h.termInstances.push(this);
    }
    loadAddon() {}
    open(el: HTMLElement) {
      const grid = document.createElement("div");
      grid.className = "xterm";
      el.appendChild(grid);
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
// Grid plumbing that needs a real xterm/renderer; none of it decides which
// renderer mounts, which is all this file tests.
vi.mock("../term/font", () => ({
  TERMINAL_FONT_STACK: "monospace",
  waitForTerminalFonts: async () => {},
  terminalFont: () => null,
  xtermFontOptions: () => null,
  subscribeTerminalFont: () => () => {},
  setProfileFontFamilies: () => {},
  setProfileLigatures: () => {},
  setTerminalFont: () => {},
  setTerminalLigatures: () => {},
}));
vi.mock("../term/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("../term/scaleToFit", () => ({ scheduleScaleToFit: () => {} }));

const tab: Tab = {
  id: "remote-test-tab",
  type: "remote",
  title: "remote",
  groupId: null,
  joinTicket: "cbsh-test-ticket",
};

function welcome(extra?: Record<string, unknown>) {
  return {
    type: "welcome",
    proto: 2,
    tabTitle: "host tab",
    cols: 80,
    rows: 24,
    ...extra,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  h.termInstances.length = 0;
  h.channels.length = 0;
  h.invokeCalls.length = 0;
  h.residentReplays.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** Mount the view and wait until remote_join went out; the returned channel
 * is the live host→viewer stream, driven by hand from the tests. */
async function mountJoined() {
  await act(async () => {
    root.render(createElement(RemoteView, { tab, active: true }));
  });
  for (
    let i = 0;
    i < 40 && !h.invokeCalls.some((c) => c.cmd === "remote_join");
    i++
  ) {
    await flush();
  }
  expect(h.invokeCalls.some((c) => c.cmd === "remote_join")).toBe(true);
  return h.channels.at(-1)!;
}

describe("RemoteView renderer dispatch", () => {
  it("joins with the tab's ticket and mounts no renderer before the welcome", async () => {
    await mountJoined();
    // The public seam is unchanged: the join carries tab.joinTicket.
    const join = h.invokeCalls.find((c) => c.cmd === "remote_join")!;
    expect(join.args).toMatchObject({ ticket: "cbsh-test-ticket" });
    // Neither renderer exists yet — the welcome has not named the kind.
    expect(h.termInstances).toHaveLength(0);
    expect(host.querySelector(".xterm")).toBeNull();
    expect(host.querySelector(".remote-connecting")).not.toBeNull();
  });

  it("a terminal welcome constructs exactly one Terminal and feeds it", async () => {
    const ch = await mountJoined();
    await act(async () => {
      ch.onmessage(welcome({ tabType: "terminal" }));
    });
    await flush();
    expect(h.termInstances).toHaveLength(1);
    expect(host.querySelector(".xterm")).not.toBeNull();
    const term = h.termInstances[0];
    // The pre-welcome status line was buffered and replayed on mount.
    expect(
      term.write.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("Connecting to remote session")
      )
    ).toBe(true);
    // Later frames reach the same instance; no second construction.
    await act(async () => {
      ch.onmessage({ type: "snapshot", b64: btoa("hello grid"), cols: 100, rows: 30 });
    });
    expect(h.termInstances).toHaveLength(1);
    const wroteSnapshot = term.write.mock.calls.some(
      (c) =>
        c[0] instanceof Uint8Array &&
        new TextDecoder().decode(c[0]).includes("hello grid")
    );
    expect(wroteSnapshot).toBe(true);
  });

  it("a v1 welcome without tabType still means a terminal", async () => {
    const ch = await mountJoined();
    await act(async () => {
      ch.onmessage(welcome());
    });
    await flush();
    expect(h.termInstances).toHaveLength(1);
    expect(host.querySelector(".xterm")).not.toBeNull();
  });

  it("a resident Remote attaches to Supervisor replay and never starts a GUI-owned join", async () => {
    h.residentReplays.push({
      events: [{ seq: 1, payload: welcome({ tabType: "terminal" }) }],
    });
    await act(async () => {
      root.render(
        createElement(RemoteView, {
          tab,
          active: true,
          residentRuntimeId: "runtime-remote-1",
        }),
      );
    });
    await flush();
    expect(h.invokeCalls).toContainEqual({
      cmd: "resident_poll",
      args: { runtimeId: "runtime-remote-1", lastAckSeq: 0 },
    });
    expect(h.invokeCalls.some((call) => call.cmd === "remote_join")).toBe(false);
    expect(h.termInstances).toHaveLength(1);
  });

});
