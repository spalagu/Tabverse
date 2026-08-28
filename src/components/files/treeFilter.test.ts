import { describe, expect, it } from "vitest";
import type { FsEntry } from "../../backend/fs";
import {
  NO_FILTER,
  entryMatches,
  filterActive,
  filterRows,
  type TreeFilter,
} from "./treeFilter";


const e = (name: string, isDir = false, parent = "/r"): FsEntry => ({
  name,
  path: `${parent}/${name}`,
  isDir,
  isSymlink: false,
  size: 0,
  modified: 0,
  git: null,
  gitFromChildren: false,
});

/** Loaded listings: /r has src, alpha.txt, .secret; /r/src has inner.ts. */
const children = new Map<string, FsEntry[]>([
  ["/r", [e("src", true), e("alpha.txt"), e(".secret")]],
  ["/r/src", [e("inner.ts", false, "/r/src")]],
]);

const f = (over: Partial<TreeFilter> = {}): TreeFilter => ({
  ...NO_FILTER,
  ...over,
});

describe("entryMatches", () => {
  it("substrings the name, case-blind", () => {
    expect(entryMatches(e("Alpha.TXT"), f({ text: "alpha" }))).toBe(true);
    expect(entryMatches(e("alpha.txt"), f({ text: "ALPHA" }))).toBe(true);
    expect(entryMatches(e("beta.txt"), f({ text: "alpha" }))).toBe(false);
    expect(entryMatches(e("beta.txt"), f({ text: "ta.t" }))).toBe(true);
  });

  it("the kind filters keep folders or files, and only them", () => {
    expect(entryMatches(e("any"), f({ kind: "dirs" }))).toBe(false);
    expect(entryMatches(e("any", true), f({ kind: "dirs" }))).toBe(true);
    expect(entryMatches(e("any", true), f({ kind: "files" }))).toBe(false);
    expect(entryMatches(e("any"), f({ kind: "files" }))).toBe(true);
  });
});

describe("filterActive", () => {
  it("no text and no kind is no filter; either alone is", () => {
    expect(filterActive(NO_FILTER)).toBe(false);
    expect(filterActive(f({ text: "a" }))).toBe(true);
    expect(filterActive(f({ kind: "dirs" }))).toBe(true);
  });
});

describe("filterRows", () => {
  it("finds matches in directories the tree never expanded — the data boundary is the view boundary", () => {
    const got = filterRows(children, "/r", false, f({ text: "inner" }));
    expect(got.rows.map((r) => r.entry.path)).toEqual(["/r/src/inner.ts"]);
    // The depth is from the root, wherever the match was hiding.
    expect(got.rows[0].depth).toBe(1);
  });

  it("counts everything visible under the loaded directories, hidden excluded", () => {
    const got = filterRows(children, "/r", false, f({ text: "zzz" }));
    expect(got.rows).toEqual([]);
    // src, alpha.txt (not .secret), inner.ts.
    expect(got.total).toBe(3);
    const withHidden = filterRows(children, "/r", true, f({ text: "zzz" }));
    expect(withHidden.total).toBe(4);
  });

  it("the kind filters narrow the matches themselves", () => {
    const dirs = filterRows(children, "/r", false, f({ kind: "dirs" }));
    expect(dirs.rows.map((r) => r.entry.name)).toEqual(["src"]);
    // The walk is depth-first: src's contents before src's siblings.
    const files = filterRows(children, "/r", false, f({ kind: "files" }));
    expect(files.rows.map((r) => r.entry.name)).toEqual(["inner.ts", "alpha.txt"]);
  });

  it("an empty root has nothing to filter", () => {
    expect(filterRows(children, "", false, f({ text: "a" }))).toEqual({
      rows: [],
      total: 0,
    });
  });
});
