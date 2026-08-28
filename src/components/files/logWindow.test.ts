import { describe, expect, it } from "vitest";
import {
  alignToLineStart,
  decodeLossy,
  prependCapped,
  utf8Len,
} from "./logWindow";

const enc = (s: string) => new TextEncoder().encode(s);

describe("alignToLineStart", () => {
  it("keeps a window at the start of the file untouched", () => {
    const r = alignToLineStart(enc("first\nsecond\n"), true);
    expect(decodeLossy(r.bytes)).toBe("first\nsecond\n");
    expect(r.droppedBytes).toBe(0);
  });

  it("drops through the first newline of a mid-file window", () => {
    const r = alignToLineStart(enc("tail-of-line\nfull line\n"), false);
    expect(decodeLossy(r.bytes)).toBe("full line\n");
    expect(r.droppedBytes).toBe("tail-of-line\n".length);
  });

  it("drops only the newline when the window starts exactly on one", () => {
    const r = alignToLineStart(enc("\nabc"), false);
    expect(decodeLossy(r.bytes)).toBe("abc");
    expect(r.droppedBytes).toBe(1);
  });

  it("keeps a mid-file window with no newline — one giant partial line", () => {
    const r = alignToLineStart(enc("no newline anywhere"), false);
    expect(decodeLossy(r.bytes)).toBe("no newline anywhere");
    expect(r.droppedBytes).toBe(0);
  });

  it("returns an empty window when the newline is the last byte", () => {
    const r = alignToLineStart(enc("partial\n"), false);
    expect(r.bytes.length).toBe(0);
    expect(r.droppedBytes).toBe(8);
  });
});

describe("decodeLossy", () => {
  it("round-trips valid UTF-8, multi-byte included", () => {
    expect(decodeLossy(enc("héllo → €10 😀\n"))).toBe("héllo → €10 😀\n");
  });

  it("turns invalid sequences into U+FFFD instead of throwing", () => {
    const bad = new Uint8Array([0x6c, 0x6f, 0x67, 0xff, 0xfe, 0x0a]);
    const out = decodeLossy(bad);
    expect(out.startsWith("log")).toBe(true);
    expect(out).toContain("�");
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("prependCapped", () => {
  it("plainly concatenates while under the cap", () => {
    const r = prependCapped("old\n", "new\n", 100);
    expect(r.text).toBe("old\nnew\n");
    expect(r.cut).toBe("");
  });

  it("cuts whole lines off the newest end when over the cap", () => {
    const r = prependCapped("aaaa\n", "bbbb\ncccc\n", 12);
    // 15 chars total; the boundary at or before 12 is after "bbbb\n".
    expect(r.text).toBe("aaaa\nbbbb\n");
    expect(r.cut).toBe("cccc\n");
  });

  it("keeps a newline landing exactly on the cap boundary", () => {
    const r = prependCapped("aaaa\n", "bbbb\ncc", 10);
    expect(r.text).toBe("aaaa\nbbbb\n");
    expect(r.cut).toBe("cc");
  });

  it("loses nothing overall: text + cut rebuild the join", () => {
    const r = prependCapped("x\ny\n", "z\nw\n", 5);
    expect(r.text + r.cut).toBe("x\ny\nz\nw\n");
    expect(r.text.length).toBeLessThanOrEqual(5);
  });

  it("hard-cuts a single line longer than the cap", () => {
    const r = prependCapped("abcdefgh", "ijklmnop", 10);
    expect(r.text).toBe("abcdefghij");
    expect(r.cut).toBe("klmnop");
  });
});

describe("utf8Len", () => {
  it("counts bytes, not code units", () => {
    expect(utf8Len("abc")).toBe(3);
    expect(utf8Len("€")).toBe(3);
    expect(utf8Len("a€b")).toBe(5);
    expect(utf8Len("😀")).toBe(4);
    expect(utf8Len("")).toBe(0);
  });
});
