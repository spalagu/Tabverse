import { describe, expect, it } from "vitest";
import {
  HEX_PAGE,
  clampToRow,
  hexGroups,
  hexRows,
  lastPageStart,
  offsetDigits,
  parseOffsetInput,
} from "./hex";

describe("hexRows", () => {
  it("formats a full 16-byte row with the classic 8+8 grouping", () => {
    const bytes = new Uint8Array([...Array(16).keys()]);
    const [row] = hexRows(bytes, 0, 8);
    expect(row.offset).toBe("00000000");
    expect(row.hex).toBe(
      "00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f"
    );
    expect(row.ascii).toBe("················");
  });

  it("shows printable ASCII in the gutter and dots for the rest", () => {
    const bytes = new Uint8Array([
      0x48, 0x69, 0x21, 0x00, 0x7f, 0x20, 0x7e, 0x0a,
    ]);
    const [row] = hexRows(bytes, 0, 8);
    expect(row.ascii).toBe("Hi!·· ~·");
  });

  it("pads a short final row so the ASCII gutter stays aligned", () => {
    const full = hexRows(new Uint8Array(16), 0, 8)[0];
    const short = hexRows(new Uint8Array([0x41, 0x42, 0x43]), 0, 8)[0];
    expect(short.hex.length).toBe(full.hex.length);
    expect(short.hex.startsWith("41 42 43")).toBe(true);
    expect(short.ascii).toBe("ABC");
  });

  it("numbers rows from the base offset in hex, at the given width", () => {
    const rows = hexRows(new Uint8Array(48), 0x1000, 8);
    expect(rows.map((r) => r.offset)).toEqual([
      "00001000",
      "00001010",
      "00001020",
    ]);
  });

  it("returns no rows for an empty page", () => {
    expect(hexRows(new Uint8Array(0), 0, 8)).toEqual([]);
  });
});

describe("hexGroups", () => {
  it("splits a full row at the seam without either space", () => {
    const [row] = hexRows(
      new Uint8Array([...Array(16).keys()]),
      0,
      8
    );
    expect(hexGroups(row.hex)).toEqual([
      "00 01 02 03 04 05 06 07",
      "08 09 0a 0b 0c 0d 0e 0f",
    ]);
  });

  it("shapes a padded short row exactly like a full one", () => {
    const full = hexRows(new Uint8Array(16), 0, 8)[0];
    const short = hexRows(new Uint8Array([0x41, 0x42]), 0, 8)[0];
    const [fullL, fullR] = hexGroups(full.hex);
    const [shortL, shortR] = hexGroups(short.hex);
    expect(shortL.length).toBe(fullL.length);
    expect(shortR.length).toBe(fullR.length);
    expect(shortL.trimEnd()).toBe("41 42");
    expect(shortR.startsWith("   ")).toBe(true);
  });
});

describe("offsetDigits", () => {
  it("stays at the classic 8 columns for anything that fits", () => {
    expect(offsetDigits(0)).toBe(8);
    expect(offsetDigits(4096)).toBe(8);
    expect(offsetDigits(0xffffffff)).toBe(8);
  });

  it("widens once the last byte's offset needs more digits", () => {
    expect(offsetDigits(0x100000001)).toBe(9);
  });
});

describe("parseOffsetInput", () => {
  it("reads hex with the 0x prefix, any case, ignoring padding", () => {
    expect(parseOffsetInput("0x10")).toBe(16);
    expect(parseOffsetInput("  0X1A  ")).toBe(26);
    expect(parseOffsetInput("0xff")).toBe(255);
  });

  it("reads plain decimal", () => {
    expect(parseOffsetInput("0")).toBe(0);
    expect(parseOffsetInput("4096")).toBe(4096);
  });

  it("rejects everything else", () => {
    expect(parseOffsetInput("")).toBeNull();
    expect(parseOffsetInput("0x")).toBeNull();
    expect(parseOffsetInput("12ab")).toBeNull();
    expect(parseOffsetInput("-5")).toBeNull();
    expect(parseOffsetInput("g")).toBeNull();
  });
});

describe("clampToRow", () => {
  it("aligns to the 16-byte row containing the offset", () => {
    expect(clampToRow(0, 1000)).toBe(0);
    expect(clampToRow(15, 1000)).toBe(0);
    expect(clampToRow(16, 1000)).toBe(16);
    expect(clampToRow(999, 1000)).toBe(992);
  });

  it("clamps past-the-end and negative offsets into the file", () => {
    expect(clampToRow(5000, 1000)).toBe(992);
    expect(clampToRow(-1, 1000)).toBe(0);
    expect(clampToRow(50, 0)).toBe(0);
  });
});

describe("lastPageStart", () => {
  it("is the page holding the final byte", () => {
    expect(lastPageStart(0)).toBe(0);
    expect(lastPageStart(HEX_PAGE)).toBe(0);
    expect(lastPageStart(HEX_PAGE + 1)).toBe(HEX_PAGE);
    expect(lastPageStart(3 * HEX_PAGE)).toBe(2 * HEX_PAGE);
    expect(lastPageStart(12000)).toBe(2 * HEX_PAGE);
  });
});
