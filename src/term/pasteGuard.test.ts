import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  bracketedPaste,
  confirmedPaste,
  countLines,
  guardPaste,
  needsConfirm,
  type PasteGuardPorts,
} from "./pasteGuard";


/** A ports recorder: everything the guard did, and nothing else. */
function recorder(enabled: boolean | null = true) {
  const sent: string[] = [];
  const plain: string[] = [];
  const asked: string[] = [];
  const ports: PasteGuardPorts = {
    sendKeys: (d) => sent.push(d),
    plainPaste: (t) => plain.push(t),
    ask: (t) => asked.push(t),
    enabled: () => enabled,
  };
  return { ports, sent, plain, asked };
}

describe("what counts as multi-line", () => {
  it("a string without a newline is one line", () => {
    expect(countLines("ls -la")).toBe(1);
    expect(needsConfirm("ls -la")).toBe(false);
  });

  it("a newline makes two, and more makes more — the count is by \\n", () => {
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\nc\nd")).toBe(4);
    expect(needsConfirm("a\nb")).toBe(true);
  });

  it("a trailing newline counts as a second line — a paste that would run", () => {
    // The one-word paste that EXECUTES is the exact surprise the guard
    // exists to stop, so "rm -rf build\n" asks even though it reads as one
    // command.
    expect(needsConfirm("rm -rf build\n")).toBe(true);
  });

  it("\\r alone does not count — a line is what \\n says it is", () => {
    expect(needsConfirm("a\rb")).toBe(false);
  });
});

describe("what a confirmed paste carries", () => {
  it("is the edited text verbatim, inside both bracketed-paste markers", () => {
    expect(bracketedPaste("x\ny")).toBe(
      `${BRACKETED_PASTE_START}x\ny${BRACKETED_PASTE_END}`
    );
    // Byte-level, not eyeballed: the markers are CSI 200~ and CSI 201~.
    expect(bracketedPaste("t")).toBe("\x1b[200~t\x1b[201~");
  });

  it("adds nothing of its own — no trailing newline smuggled in", () => {
    expect(bracketedPaste("a\nb")).not.toContain("b\n\x1b");
  });

  it("goes out through the keystroke channel, never plain paste", () => {
    const r = recorder();
    confirmedPaste("a\nb", r.ports);
    expect(r.sent).toEqual([bracketedPaste("a\nb")]);
    expect(r.plain).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it("sends nothing for empty text", () => {
    const r = recorder();
    confirmedPaste("", r.ports);
    expect(r.sent).toEqual([]);
  });
});

describe("the unified entry's routing", () => {
  it("single line, guard on: straight through on the plain channel", () => {
    const r = recorder();
    guardPaste("ls -la", r.ports);
    expect(r.plain).toEqual(["ls -la"]);
    expect(r.asked).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("two lines, guard on: the dialog opens and nothing is sent yet", () => {
    const r = recorder();
    guardPaste("git status\ngit diff", r.ports);
    expect(r.asked).toEqual(["git status\ngit diff"]);
    expect(r.plain).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("guard off: two lines go straight through the plain channel too", () => {
    const r = recorder(false);
    guardPaste("git status\ngit diff", r.ports);
    expect(r.plain).toEqual(["git status\ngit diff"]);
    expect(r.asked).toEqual([]);
  });

  it("nothing read yet (null) is guarded — the safe direction", () => {
    const r = recorder(null);
    guardPaste("a\nb", r.ports);
    expect(r.asked).toEqual(["a\nb"]);
  });

  it("empty text is dropped, not asked about", () => {
    const r = recorder();
    guardPaste("", r.ports);
    expect(r.plain).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});
