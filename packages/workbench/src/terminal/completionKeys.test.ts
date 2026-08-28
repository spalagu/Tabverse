import { describe, expect, it, vi } from "vitest";
import { InputLine } from "./completion";
import {
  handleTerminalCompletionKey,
  type CompletionSelection,
} from "./completionKeys";

function setup(initial: CompletionSelection | null) {
  let current = initial;
  const type = vi.fn();
  const inputLine = new InputLine();
  inputLine.push("git --v");
  const ports = {
    current: () => current,
    update: (next: CompletionSelection | null) => {
      current = next;
    },
    inputLine,
    type,
  };
  return { ports, type, current: () => current };
}

const flags = {
  kind: "flags" as const,
  command: "git",
  word: "--v",
  items: ["--verbose", "--version"],
};

describe("terminal completion keys", () => {
  it("cycles through completion rows", () => {
    const state = setup({ offer: flags, sel: 0 });
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      cancelable: true,
    });
    expect(handleTerminalCompletionKey(event, state.ports)).toBe(true);
    expect(state.current()?.sel).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("types only the missing suffix and closes the popup", () => {
    const state = setup({ offer: flags, sel: 1 });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    handleTerminalCompletionKey(event, state.ports);
    expect(state.type).toHaveBeenCalledWith("ersion ");
    expect(state.ports.inputLine.text).toBe("git --version ");
    expect(state.current()).toBeNull();
  });

  it("leaves unrelated keys for xterm and closes on Escape", () => {
    const state = setup({ offer: flags, sel: 0 });
    expect(
      handleTerminalCompletionKey(
        new KeyboardEvent("keydown", { key: "a" }),
        state.ports
      )
    ).toBe(false);
    handleTerminalCompletionKey(
      new KeyboardEvent("keydown", { key: "Escape" }),
      state.ports
    );
    expect(state.current()).toBeNull();
  });
});
