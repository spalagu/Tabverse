import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installMacKeyConventions } from "./keys";

/** Stub terminal: CSI handler registry + the custom key handler hook. */
function stubTerm() {
  const csi = new Map<string, (params: number[]) => boolean>();
  let keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
  const pasteSpy = vi.fn();
  const term = {
    parser: {
      registerCsiHandler(
        sel: { prefix?: string; final: string },
        cb: (params: number[]) => boolean
      ) {
        csi.set(`${sel.prefix ?? ""}${sel.final}`, cb);
        return { dispose() {} };
      },
    },
    attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean) {
      keyHandler = cb;
    },
    hasSelection: () => false,
    getSelection: () => "",
    paste: pasteSpy,
  };
  const press = (init: Partial<KeyboardEvent>): boolean =>
    keyHandler!({
      type: "keydown",
      key: "",
      code: "",
      keyCode: 0,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...init,
    } as KeyboardEvent);
  return { term: term as unknown as Terminal, csi, press, pasteSpy };
}

const shiftEnter = { key: "Enter", shiftKey: true };

describe("kitty keyboard negotiation and Shift+Enter", () => {
  let sent: string[];
  let pasted: string[];
  let t: ReturnType<typeof stubTerm>;

  beforeEach(() => {
    sent = [];
    pasted = [];
    t = stubTerm();
    installMacKeyConventions(
      t.term,
      (d) => sent.push(d),
      (text) => pasted.push(text)
    );
  });

  it("falls back to ESC CR before any negotiation", () => {
    expect(t.press(shiftEnter)).toBe(false);
    expect(sent).toEqual(["\x1b\r"]);
  });

  it("sends CSI 13;2u while the app has the protocol pushed, ESC CR after pop", () => {
    t.csi.get(">u")!([1]); // push
    t.press(shiftEnter);
    t.csi.get("<u")!([]); // pop, default count 1
    t.press(shiftEnter);
    expect(sent).toEqual(["\x1b[13;2u", "\x1b\r"]);
  });

  it("pop honours its count parameter", () => {
    t.csi.get(">u")!([1]);
    t.csi.get(">u")!([1]);
    t.csi.get("<u")!([2]); // pop both at once — decrementing by one leaks
    t.press(shiftEnter);
    expect(sent).toEqual(["\x1b\r"]);
  });

  it("set edits the current entry: mode 3 clears, mode 2 ors back in", () => {
    t.csi.get(">u")!([1]);
    t.csi.get("=u")!([1, 3]); // clear the disambiguate bit
    t.press(shiftEnter);
    t.csi.get("=u")!([1, 2]); // or it back
    t.press(shiftEnter);
    expect(sent).toEqual(["\x1b\r", "\x1b[13;2u"]);
  });

  it("answers a query with the current flags", () => {
    t.csi.get("?u")!([]);
    t.csi.get(">u")!([1]);
    t.csi.get("?u")!([]);
    expect(sent).toEqual(["\x1b[?0u", "\x1b[?1u"]);
  });

  it("recognises Return by keyCode alone — automation sends empty key fields", () => {
    expect(t.press({ keyCode: 13, shiftKey: true })).toBe(false);
    expect(sent).toEqual(["\x1b\r"]);
  });

  it("Cmd+C without a selection swallows the key and sends no control code", () => {
    const clip = { writeText: vi.fn(), readText: vi.fn() };
    Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
    expect(t.press({ key: "c", metaKey: true })).toBe(false);
    expect(sent).toEqual([]);
    expect(clip.writeText).not.toHaveBeenCalled();
  });

  it("Cmd+V hands the clipboard text to the pane's paste route, not term.paste", async () => {
    const clip = { writeText: vi.fn(), readText: vi.fn(() => Promise.resolve("a\nb")) };
    Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
    expect(t.press({ key: "v", metaKey: true })).toBe(false);
    await vi.waitFor(() => expect(pasted).toEqual(["a\nb"]));
    // The guard's entry, not xterm's: nothing reaches the terminal's own
    // paste (which would bypass the multi-line asking) from here.
    expect(t.pasteSpy).not.toHaveBeenCalled();
  });
});

describe("copy and paste off the Mac (the join page's keyboards)", () => {
  let sent: string[];
  let copied: string[];
  let pasted: string[];
  let has: boolean;
  let selection: string;
  let t: ReturnType<typeof stubTerm>;

  beforeEach(() => {
    sent = [];
    copied = [];
    pasted = [];
    has = false;
    selection = "";
    const base = stubTerm();
    // A selection the test can stand up and take down. The stub above owns
    // the shape being re-pointed, so the writes stay inside the stub's own
    // surface.
    const mutable = base.term as unknown as Record<string, unknown>;
    mutable.hasSelection = () => has;
    mutable.getSelection = () => selection;
    t = base;
    installMacKeyConventions(
      t.term,
      (d) => sent.push(d),
      (text) => pasted.push(text),
      (text) => copied.push(text)
    );
  });

  it("Ctrl+Shift+C copies a standing selection", () => {
    has = true;
    selection = "picked text";
    expect(
      t.press({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true })
    ).toBe(false);
    expect(copied).toEqual(["picked text"]);
    expect(sent).toEqual([]);
  });

  it("Ctrl+C with a selection copies instead of signalling the shell", () => {
    has = true;
    selection = "running output";
    expect(t.press({ key: "c", code: "KeyC", ctrlKey: true })).toBe(false);
    expect(copied).toEqual(["running output"]);
    expect(sent).toEqual([]);
  });

  it("Ctrl+C with NO selection still reaches the shell as SIGINT", () => {
    expect(t.press({ key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    expect(copied).toEqual([]);
  });

  it("Ctrl+Shift+V pastes through the pane's route", async () => {
    const clip = {
      writeText: vi.fn(),
      readText: vi.fn(() => Promise.resolve("x\ny")),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: clip,
      configurable: true,
    });
    expect(
      t.press({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true })
    ).toBe(false);
    await vi.waitFor(() => expect(pasted).toEqual(["x\ny"]));
  });
});
