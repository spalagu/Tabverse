import { describe, expect, it } from "vitest";
import type { FsEntry } from "../../backend/fs";
import {
  millerAim,
  millerAt,
  millerKey,
  millerPush,
} from "./miller";


const e = (name: string, isDir = false): FsEntry => ({
  name,
  path: `/r/${name}`,
  isDir,
  isSymlink: false,
  size: isDir ? 0 : 1,
  modified: 1,
  git: null,
  gitFromChildren: false,
});

const d = (name: string): FsEntry => e(name, true);

/** /r lists alpha, beta, file.txt; /r/alpha lists one file; /r/beta is empty. */
const listing: Record<string, FsEntry[]> = {
  "/r": [d("alpha"), d("beta"), e("file.txt")],
  "/r/alpha": [e("inner.txt")],
  "/r/beta": [],
};

const rowsFor = (dir: string): FsEntry[] => listing[dir] ?? [];

describe("millerPush", () => {
  it("single click on a folder in the LAST column appends its column", () => {
    let s = millerAt("/r");
    s = millerPush(s, 0, "/r/alpha");
    expect(s.columns.map((c) => c.dir)).toEqual(["/r", "/r/alpha"]);
    expect(s.activeCol).toBe(1);
  });

  it("clicking a folder in an EARLIER column collapses the branch after it", () => {
    let s = millerAt("/r");
    s = millerPush(s, 0, "/r/alpha");
    s = millerPush(s, 1, "/r/alpha");
    // Click beta back in column 0: the alpha branch is replaced.
    s = millerPush(s, 0, "/r/beta");
    expect(s.columns.map((c) => c.dir)).toEqual(["/r", "/r/beta"]);
    expect(s.activeCol).toBe(1);
  });

  it("clicking the folder the next column already shows walks into it, once", () => {
    let s = millerAt("/r");
    s = millerPush(s, 0, "/r/alpha");
    const again = millerPush(s, 0, "/r/alpha");
    expect(again.columns.map((c) => c.dir)).toEqual(["/r", "/r/alpha"]);
    expect(again.activeCol).toBe(1);
  });
});

describe("millerKey — the arrows", () => {
  it("down and up walk the active column's rows", () => {
    let s = millerAt("/r");
    s = millerKey(s, rowsFor, "ArrowDown");
    expect(s.columns[0].aimed).toBe("/r/alpha");
    s = millerKey(s, rowsFor, "ArrowDown");
    expect(s.columns[0].aimed).toBe("/r/beta");
    s = millerKey(s, rowsFor, "ArrowDown");
    expect(s.columns[0].aimed).toBe("/r/file.txt");
    // Clamped at the end, not wrapped.
    s = millerKey(s, rowsFor, "ArrowDown");
    expect(s.columns[0].aimed).toBe("/r/file.txt");
    s = millerKey(s, rowsFor, "ArrowUp");
    expect(s.columns[0].aimed).toBe("/r/beta");
  });

  it("from nothing, up aims the last row and down the first", () => {
    const down = millerKey(millerAt("/r"), rowsFor, "ArrowDown");
    expect(down.columns[0].aimed).toBe("/r/alpha");
    const up = millerKey(millerAt("/r"), rowsFor, "ArrowUp");
    expect(up.columns[0].aimed).toBe("/r/file.txt");
  });

  it("right on the aimed FOLDER in the last column pushes its column", () => {
    let s = millerAt("/r");
    s = millerKey(s, rowsFor, "ArrowDown");
    s = millerKey(s, rowsFor, "ArrowRight");
    expect(s.columns.map((c) => c.dir)).toEqual(["/r", "/r/alpha"]);
    expect(s.activeCol).toBe(1);
  });

  it("right on an aimed FILE pushes nothing", () => {
    let s = millerAt("/r");
    s = millerKey(s, rowsFor, "ArrowDown");
    s = millerKey(s, rowsFor, "ArrowDown");
    s = millerKey(s, rowsFor, "ArrowDown");
    expect(s.columns[0].aimed).toBe("/r/file.txt");
    const next = millerKey(s, rowsFor, "ArrowRight");
    expect(next.columns).toHaveLength(1);
    expect(next.activeCol).toBe(0);
  });

  it("left aims the parent column at the row this column came from — and right returns", () => {
    let s = millerAt("/r");
    s = millerKey(s, rowsFor, "ArrowDown");
    s = millerKey(s, rowsFor, "ArrowRight");
    expect(s.activeCol).toBe(1);
    s = millerKey(s, rowsFor, "ArrowLeft");
    expect(s.activeCol).toBe(0);
    expect(s.columns[0].aimed).toBe("/r/alpha");
    // Right walks back into the existing column without re-pushing it.
    s = millerKey(s, rowsFor, "ArrowRight");
    expect(s.columns.map((c) => c.dir)).toEqual(["/r", "/r/alpha"]);
    expect(s.activeCol).toBe(1);
  });

  it("left in the first column does nothing", () => {
    const s = millerAt("/r");
    expect(millerKey(s, rowsFor, "ArrowLeft")).toBe(s);
  });

  it("arrows in an empty column stay put", () => {
    let s = millerAt("/r");
    s = millerPush(s, 0, "/r/beta");
    expect(millerKey(s, rowsFor, "ArrowDown")).toBe(s);
    expect(millerKey(s, rowsFor, "ArrowUp")).toBe(s);
    // Right on nothing in the last column pushes nothing.
    expect(millerKey(s, rowsFor, "ArrowRight")).toBe(s);
  });
});

describe("millerAim", () => {
  it("the mouse aims a row and makes its column active", () => {
    let s = millerAt("/r");
    s = millerPush(s, 0, "/r/alpha");
    s = millerAim(s, 0, "/r/beta");
    expect(s.columns[0].aimed).toBe("/r/beta");
    expect(s.activeCol).toBe(0);
  });
});
