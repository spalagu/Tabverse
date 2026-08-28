import { describe, expect, it, vi } from "vitest";
import {
  installTerminalInputController,
  type TerminalInputCompletion,
} from "./inputController";
import type { PasteGuardPorts } from "./pasteGuard";

const spec = {
  version: "2026-08-27",
  commands: [
    {
      name: "git",
      flags: [{ name: "--version" }, { name: "--verbose" }],
    },
  ],
  files: { patterns: [], extensions: [] },
};

function setup() {
  let dataListener!: (data: string) => void;
  let binaryListener!: (data: string) => void;
  let resizeListener!: (size: { cols: number; rows: number }) => void;
  let pastePorts!: PasteGuardPorts;
  let typing!: (data: string) => void;
  let conventionSend!: (data: string) => void;
  let conventionPaste!: (text: string) => void;
  let completion: TerminalInputCompletion | null = null;
  const write = vi.fn();
  const broadcast = vi.fn();
  const resize = vi.fn();
  const plainPaste = vi.fn();
  const askPaste = vi.fn();
  const recordConventionInput = vi.fn();
  const focus = vi.fn();

  const controller = installTerminalInputController({
    write,
    resize,
    broadcast,
    onData: (listener) => {
      dataListener = listener;
    },
    onBinary: (listener) => {
      binaryListener = listener;
    },
    onResize: (listener) => {
      resizeListener = listener;
    },
    plainPaste,
    askPaste,
    pasteGuardEnabled: () => true,
    setPastePorts: (next) => {
      pastePorts = next;
    },
    setTyping: (next) => {
      typing = next;
    },
    setCompletion: (next) => {
      completion = next;
    },
    completionSpec: () => spec,
    installConventions: (send, paste) => {
      conventionSend = send;
      conventionPaste = paste;
    },
    recordConventionInput,
    focus,
  });
  return {
    controller,
    write,
    broadcast,
    resize,
    plainPaste,
    askPaste,
    recordConventionInput,
    focus,
    data: (value: string) => dataListener(value),
    binary: (value: string) => binaryListener(value),
    resizeEvent: (cols: number, rows: number) =>
      resizeListener({ cols, rows }),
    paste: (value: string) => conventionPaste(value),
    convention: (value: string) => conventionSend(value),
    typing: (value: string) => typing(value),
    pastePorts: () => pastePorts,
    completion: () => completion,
  };
}

describe("terminal input controller", () => {
  it("fans typed and convention input through the same broadcast channel", () => {
    const state = setup();
    state.data("git --v");
    state.convention("\x1b\r");
    state.typing("ersion ");

    expect(state.write.mock.calls.map(([data]) => data)).toEqual([
      "git --v",
      "\x1b\r",
      "ersion ",
    ]);
    expect(state.broadcast.mock.calls).toEqual(state.write.mock.calls);
    expect(state.recordConventionInput).toHaveBeenCalledWith("\x1b\r");
    expect(state.completion()?.offer.kind).toBe("flags");
  });

  it("guards multi-line paste and leaves a single line on xterm's paste path", () => {
    const state = setup();
    state.paste("one line");
    state.paste("first\nsecond");

    expect(state.plainPaste).toHaveBeenCalledWith("one line");
    expect(state.askPaste).toHaveBeenCalledWith("first\nsecond");
    state.pastePorts().sendKeys("confirmed");
    expect(state.write).toHaveBeenCalledWith("confirmed");
    expect(state.broadcast).toHaveBeenCalledWith("confirmed");
  });

  it("converts binary strings, forwards resize and focuses the terminal", () => {
    const state = setup();
    state.binary("\x00\xff");
    state.resizeEvent(132, 43);

    expect(Array.from(state.write.mock.calls[0][0] as Uint8Array)).toEqual([
      0, 255,
    ]);
    expect(state.resize).toHaveBeenCalledWith(132, 43);
    expect(state.focus).toHaveBeenCalledOnce();
  });

  it("resets completion state when bracketed paste reaches onData", () => {
    const state = setup();
    state.data("git --v");
    expect(state.completion()).not.toBeNull();
    state.data("\x1b[200~pasted\x1b[201~");
    expect(state.completion()).toBeNull();
    expect(state.controller.inputLine.text).toBe("");
  });
});
