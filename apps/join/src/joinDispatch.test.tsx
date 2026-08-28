import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { b64encode } from "@tabverse/remote-client/b64";
import { CLIP_MAX_BYTES, resetHostClip } from "@tabverse/remote-client/clipboard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const h = vi.hoisted(() => {
  const termInstances: Array<{ write: ReturnType<typeof vi.fn> }> = [];
  const onDataHandlers: Array<(data: string) => void> = [];
  const events: Array<(json: string) => void> = [];
  const tickets: string[] = [];
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return { termInstances, onDataHandlers, events, tickets, calls };
});

vi.mock("@tabverse/runtime-remote/wasm-loader", () => ({
  loadWasm: async () => ({
    joinShare: async (
      ticket: string,
      _name: string,
      onEvent: (json: string) => void
    ) => {
      h.tickets.push(ticket);
      h.events.push(onEvent);
      return {
        sendInput: (b64: string) => h.calls.push({ fn: "sendInput", args: [b64] }),
        ping: () => {},
        viewport: (cols: number, rows: number) =>
          h.calls.push({ fn: "viewport", args: [cols, rows] }),
        leave: () => h.calls.push({ fn: "leave", args: [] }),
        sendPrompt: (text: string) =>
          h.calls.push({ fn: "sendPrompt", args: [text] }),
        sendAnswer: (callId: string, allow: boolean) =>
          h.calls.push({ fn: "sendAnswer", args: [callId, allow] }),
        sendCancel: () => h.calls.push({ fn: "sendCancel", args: [] }),
        sendAction: (name: string, args: unknown) =>
          h.calls.push({ fn: "sendAction", args: [name, args] }),
        sendRpc: (id: bigint, cmd: string, args: unknown) =>
          h.calls.push({ fn: "sendRpc", args: [id, cmd, args] }),
        sendClipPush: (text: string) =>
          h.calls.push({ fn: "sendClipPush", args: [text] }),
        sendProxyReq: (id: bigint, head: string, body?: string) =>
          h.calls.push({ fn: "sendProxyReq", args: [id, head, body] }),
      };
    },
  }),
}));

// The construction spy the dispatch claims rest on: every `new Terminal()`
// lands in h.termInstances, and open() plants the .xterm marker the DOM
// assertions look for.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = { fontSize: 13 };
    unicode = { activeVersion: "" };
    write = vi.fn();
    getSelection = vi.fn(() => "");
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
    onData(cb: (data: string) => void) {
      h.onDataHandlers.push(cb);
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
vi.mock("@tabverse/workbench/terminal/font", () => ({
  TERMINAL_FONT_STACK: "monospace",
  // The app-shell import chain reaches the store, which reaches profiles.
  // The join test never draws a terminal font; every setter and reader on
  // this path is a static stub, listed once so a new export on the real
  // module fails here loudly instead of silently skipping.
  setProfileFontFamilies: () => {},
  setProfileLigatures: () => {},
  profileFontFamilies: () => ({}),
  terminalLigatures: () => null,
  terminalFont: () => null,
}));
vi.mock("@tabverse/workbench/terminal/keys", () => ({ installMacKeyConventions: () => {} }));
vi.mock("@tabverse/workbench/terminal/scale-to-fit", () => ({
  scheduleScaleToFit: () => {},
  unscaleTerminal: () => {},
}));

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

/** An app share's first mirror frame: two tabs, the terminal fronting —
 * the v1 snapshot state a v3 host broadcasts, in the guarded wire shape
 * readSnapshot accepts. */
const APP_SNAPSHOT = {
  version: 1,
  tabs: [
    { id: "t1", type: "terminal", title: "zsh" },
    { id: "a1", type: "agent", title: "Agent" },
  ],
  groups: [],
  activeTabId: "t1",
};

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
  h.onDataHandlers.length = 0;
  h.events.length = 0;
  h.tickets.length = 0;
  h.calls.length = 0;
  location.hash = "#tabv-test-ticket";
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  location.hash = "";
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** Mount the page; the hash ticket auto-connects. Returns the host→viewer
 * event callback, driven by hand from the tests. */
async function mountJoined() {
  await act(async () => {
    root.render(createElement(App));
  });
  for (let i = 0; i < 40 && h.events.length === 0; i++) {
    await flush();
  }
  expect(h.events.length).toBe(1);
  return (frame: Record<string, unknown>) =>
    act(async () => {
      h.events[0](JSON.stringify(frame));
    });
}

/** Mount into the app shell: the welcome names the whole app, the mirror
 * snapshot fills the tab list, and the host's mode frame sets the access
 * level. Returns the frame callback for transitions the test drives. */
async function mountAppShare(readOnly: boolean) {
  const send = await mountJoined();
  await send(welcome({ tabType: "app" }));
  await send({ type: "appSnapshot", state: APP_SNAPSHOT });
  await send({ type: "mode", readOnly });
  await flush();
  return send;
}

const sent = (fn: string) => h.calls.filter((c) => c.fn === fn);

describe("join page renderer dispatch", () => {
  it("auto-connects with the hash ticket and mounts no renderer before the welcome", async () => {
    await mountJoined();
    expect(h.tickets).toEqual(["tabv-test-ticket"]);
    expect(h.termInstances).toHaveLength(0);
    expect(host.querySelector(".xterm")).toBeNull();
    expect(host.querySelector(".agent-view")).toBeNull();
    expect(host.querySelector(".remote-connecting")).not.toBeNull();
  });

  it("an agent welcome never constructs a Terminal and renders the transcript", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "agent" }));
    expect(h.termInstances).toHaveLength(0);
    expect(host.querySelector(".xterm")).toBeNull();
    expect(host.querySelector(".agent-view")).not.toBeNull();
    // Agent frames flow into the same fold the app uses.
    await send({
      type: "agentSnapshot",
      events: [
        { type: "user_prompt", text: "hello from the host" },
        { type: "turn_started", turn: 1 },
        { type: "assistant_text", delta: "hi there" },
      ],
    });
    expect(h.termInstances).toHaveLength(0);
    expect(host.textContent).toContain("hello from the host");
    expect(host.textContent).toContain("hi there");
  });

  it("agent composer and approvals drive the wasm session's agent methods", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "agent" }));
    await send({ type: "mode", readOnly: false, access: "approve" });

    // Steer: the composer sends a prompt through sendPrompt.
    const input = host.querySelector<HTMLTextAreaElement>(".agent-input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      const proto = Object.getPrototypeOf(input) as object;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
      setter.call(input, "run the tests");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Send"
    )!;
    await act(async () => sendBtn.click());
    expect(sent("sendPrompt")).toEqual([
      { fn: "sendPrompt", args: ["run the tests"] },
    ]);

    // Approve: a pending permission renders Allow/Deny wired to sendAnswer.
    await send({
      type: "agentEvent",
      event: {
        type: "permission_requested",
        call_id: "call-1",
        name: "bash",
        input: { command: "rm -rf build" },
      },
    });
    const allow = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Allow"
    )!;
    await act(async () => allow.click());
    expect(sent("sendAnswer")).toEqual([
      { fn: "sendAnswer", args: ["call-1", true] },
    ]);
  });

  it("a terminal welcome constructs exactly one Terminal and feeds it the snapshot", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "terminal" }));
    await flush();
    expect(h.termInstances).toHaveLength(1);
    expect(host.querySelector(".xterm")).not.toBeNull();
    expect(host.querySelector(".agent-view")).toBeNull();
    await send({
      type: "snapshot",
      b64: btoa("hello grid"),
      cols: 100,
      rows: 30,
    });
    expect(h.termInstances).toHaveLength(1);
    const term = h.termInstances[0];
    const wroteSnapshot = term.write.mock.calls.some(
      (c) =>
        c[0] instanceof Uint8Array &&
        new TextDecoder().decode(c[0]).includes("hello grid")
    );
    expect(wroteSnapshot).toBe(true);
  });

  it("a v1 welcome without tabType still means a terminal", async () => {
    const send = await mountJoined();
    await send(welcome());
    await flush();
    expect(h.termInstances).toHaveLength(1);
    expect(host.querySelector(".xterm")).not.toBeNull();
  });

  it("typed input reaches the wire base64-encoded; sticky Ctrl turns c into 0x03", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "terminal" }));
    await flush();
    expect(h.onDataHandlers.length).toBeGreaterThan(0);
    const type = (data: string) =>
      act(async () => h.onDataHandlers.forEach((cb) => cb(data)));

    await type("ls");
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("ls")],
    });

    // Arm the sticky Ctrl on the toolbar, then type c: the wire carries the
    // interrupt, and the modifier disarms itself.
    const ctrl = [...host.querySelectorAll<HTMLButtonElement>("button.key-btn")].find(
      (b) => b.textContent === "ctrl"
    )!;
    expect(ctrl).not.toBeNull();
    await act(async () => ctrl.click());
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    await type("c");
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("\x03")],
    });
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    await type("c");
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("c")],
    });
  });

  it("toolbar keys send their terminal encodings", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "terminal" }));
    await flush();
    const byText = (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button.key-btn")].find(
        (b) => b.textContent === text
      )!;
    await act(async () => byText("esc").click());
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("\x1b")],
    });
    await act(async () => byText("↑").click());
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("\x1b[A")],
    });
  });

  it("read-only mode gates typed input locally", async () => {
    const send = await mountJoined();
    await send(welcome({ tabType: "terminal" }));
    await send({ type: "mode", readOnly: true });
    await flush();
    const before = sent("sendInput").length;
    await act(async () => h.onDataHandlers.forEach((cb) => cb("x")));
    expect(sent("sendInput").length).toBe(before);
  });

  it("an app share in view mode renders an inert selector and sends nothing on click", async () => {
    await mountAppShare(true);
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".app-tab-row")];
    expect(rows).toHaveLength(2);
    // The shell shows its read-only form: the list announces it and the
    // class carries the pointer-events none paint.
    const list = host.querySelector(".app-tab-list")!;
    expect(list.getAttribute("aria-readonly")).toBe("true");
    expect(list.className).toContain("readonly");

    await act(async () => rows[1].click());
    // No wire traffic, and no optimistic replay either: view level means
    // the click changed nothing locally.
    expect(sent("sendAction")).toEqual([]);
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  it("an app share in steer mode sends tab selection to the host and replays it locally", async () => {
    await mountAppShare(false);
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>(".app-tab-row")[1].click()
    );
    expect(sent("sendAction")).toEqual([
      { fn: "sendAction", args: ["activateTab", "a1"] },
    ]);
    // The optimistic replay answered the click before the host's
    // actionApplied broadcast confirms it.
    const rows = [...host.querySelectorAll(".app-tab-row")];
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
  });

  it("an app share whose active tab is a terminal renders the live TerminalViewer; the placeholder is gone", async () => {
    const send = await mountAppShare(false);
    // APP_SNAPSHOT fronts the terminal row (t1), so the mount already
    // carries the viewer: exactly one xterm, no placeholder, and the
    // host's terminal snapshot reached its grid.
    await flush();
    expect(h.termInstances).toHaveLength(1);
    expect(host.querySelector(".xterm")).not.toBeNull();
    expect(host.querySelector(".app-share-content")).toBeNull();
    await send({
      type: "snapshot",
      b64: btoa("the host's screen"),
      cols: 120,
      rows: 40,
    });
    const term = h.termInstances[0];
    expect(
      term.write.mock.calls.some(
        (c) =>
          c[0] instanceof Uint8Array &&
          new TextDecoder().decode(c[0]).includes("the host's screen")
      )
    ).toBe(true);
    // And its keystrokes ride the Input frame the app share's hub arm
    // now forwards (the host writes them into ITS active terminal).
    await act(async () => h.onDataHandlers.forEach((cb) => cb("ls\r")));
    expect(sent("sendInput").at(-1)).toEqual({
      fn: "sendInput",
      args: [b64encode("ls\r")],
    });
  });

  it("switching the app share to an agent row mounts the agent pane with the session's transcript", async () => {
    const send = await mountAppShare(false);
    await flush();
    expect(host.querySelector(".xterm")).not.toBeNull();
    // The host fronts the agent row: the terminal's mount goes, the
    // agent pane arrives (its events fold into agentState the same way
    // a tab-level agent share's do), and no second Terminal is built.
    await send({ type: "actionApplied", name: "activateTab", args: "a1" });
    await flush();
    expect(host.querySelector(".xterm")).toBeNull();
    expect(host.querySelector(".agent-view")).not.toBeNull();
    expect(host.querySelector(".app-share-content")).toBeNull();
    expect(h.termInstances).toHaveLength(1);
    // A session event the host streams lands in the pane.
    await send({ type: "agentEvent", event: { type: "turn_started", turn: 1 } });
    await flush();
    expect(host.querySelector(".agent-view")).not.toBeNull();
  });

  it("a mode frame from view to steer re-enables the app share's selector", async () => {
    const send = await mountAppShare(true);
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>(".app-tab-row")[1].click()
    );
    expect(sent("sendAction")).toEqual([]);

    // The host grants Steer: the shell's inert form lifts and the same
    // click now reaches the wire.
    await send({ type: "mode", readOnly: false });
    await flush();
    expect(
      host.querySelector(".app-tab-list")!.getAttribute("aria-readonly")
    ).toBe("false");
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>(".app-tab-row")[1].click()
    );
    expect(sent("sendAction")).toEqual([
      { fn: "sendAction", args: ["activateTab", "a1"] },
    ]);
  });

  it("a steer-level Terminal pick sends addTab and the row lands on the host's confirmation", async () => {
    const send = await mountAppShare(false);
    // The + button raises the kind picker (the host menu's shape); the
    // Terminal row inside it is the ask.
    const plus = host.querySelector<HTMLButtonElement>(".app-new-button")!;
    expect(plus).not.toBeNull();
    await act(async () => plus.click());
    const menuRows = [...host.querySelectorAll<HTMLButtonElement>(".app-new-menu-row")];
    const terminal = menuRows.find((r) => r.textContent!.includes("Terminal"))!;
    await act(async () => terminal.click());
    // The ask leaves as one action frame — the tab is created on the
    // HOST (PTY included), never here.
    expect(sent("sendAction")).toEqual([
      { fn: "sendAction", args: ["addTab", { type: "terminal" }] },
    ]);
    // No optimistic creation: addTab is off the optimistic whitelist.
    expect(host.querySelectorAll(".app-tab-row")).toHaveLength(2);

    // The host's broadcast (id and title the host generated) replays
    // into the mirror and the row appears.
    await send({
      type: "actionApplied",
      name: "addTab",
      args: { type: "terminal", id: "t9", title: "zsh", lastActiveAt: 48000 },
    });
    await flush();
    const rows = [...host.querySelectorAll(".app-tab-row")];
    expect(rows).toHaveLength(3);
    // Insertion position is the host store's policy (after the active
    // tab), not the mirror's to decide — the assertion cares that the
    // host-named row arrived, not where it sits.
    expect(
      rows.some((r) => (r.textContent ?? "").includes("zsh"))
    ).toBe(true);
  });

  it("view level offers no create affordance", async () => {
    await mountAppShare(true);
    expect(host.querySelector(".app-new-button")).toBeNull();
  });
  it("a host clipSync lands on the joiner's board, and an over-cap one never does", async () => {
    const writeText = vi.fn((): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    resetHostClip();
    const send = await mountAppShare(false);

    await send({ type: "clipSync", seq: 4, text: "copied on the host" });
    await flush();
    expect(writeText).toHaveBeenCalledWith("copied on the host");

    // The frame the sender should never have sent: the cap is enforced
    // again on the receiving side, and the board keeps the last good
    // clip rather than taking the oversized one.
    await send({
      type: "clipSync",
      seq: 5,
      text: "x".repeat(CLIP_MAX_BYTES + 1),
    });
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("a fronting browser tab mounts the proxied pane; the document round-trips through sendProxyReq and proxyRes", async () => {
    const send = await mountAppShare(false);
    // The host fronts a browser row carrying its address.
    await send({
      type: "appSnapshot",
      state: {
        ...APP_SNAPSHOT,
        tabs: [
          ...APP_SNAPSHOT.tabs,
          { id: "b1", type: "browser", title: "Wiki", url: "http://intranet.local/wiki/Home" },
        ],
        activeTabId: "b1",
      },
    });
    await flush();

    // The pane asked the host's network: one ProxyReq, a document GET
    // whose head names the absolute target.
    const reqs = sent("sendProxyReq");
    expect(reqs).toHaveLength(1);
    expect(
      String(reqs[0].args[1]).startsWith(
        "GET http://intranet.local/wiki/Home HTTP/1.1"
      )
    ).toBe(true);
    expect(typeof reqs[0].args[0]).toBe("bigint");

    // The host's answer lands and the mirrored document is on screen;
    // the placeholder the other tab kinds keep is gone.
    // The frame body is base64 now (the host encodes bytes; TLS-terminated
    // https answers ride the same shape).
    await send({
      type: "proxyRes",
      id: Number(reqs[0].args[0]),
      head: "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n",
      body: btoa(
        "<html><head><title>Wiki</title></head><body><h1>Intranet wiki</h1></body></html>"
      ),
    });
    await flush();
    const frame = host.querySelector(".browser-pane-frame");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("srcdoc")).toContain("<h1>Intranet wiki</h1>");
    expect(frame!.getAttribute("srcdoc")).toContain(
      '<base href="/__tabverse_proxy/http/intranet.local/wiki/">'
    );
    expect(host.querySelector(".app-share-content")).toBeNull();

    // The host's error arm is the pane's refusal: an rpcResult with the
    // same id — not a proxyRes — flips a re-asked pane to the link.
    await send({ type: "actionApplied", name: "activateTab", args: "t1" });
    await send({ type: "actionApplied", name: "activateTab", args: "b1" });
    await flush();
    const second = sent("sendProxyReq")[1];
    expect(second).toBeDefined();
    await send({
      type: "rpcResult",
      id: Number(second.args[0]),
      err: "the request named no forwardable host",
    });
    await flush();
    expect(host.querySelector(".browser-pane-unmirrored")).not.toBeNull();
    expect(host.querySelector(".browser-pane-frame")).toBeNull();
  });
});
