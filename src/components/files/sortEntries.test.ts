import { describe, expect, it } from "vitest";
import type { FsEntry } from "../../backend/fs";
import {
  DEFAULT_SORT,
  SORT_KEYS,
  entryKind,
  sameSort,
  sortEntries,
  type SortKey,
  type SortSpec,
} from "./sortEntries";


const e = (over: Partial<FsEntry> & { name: string }): FsEntry => ({
  path: `/d/${over.name}`,
  isDir: false,
  isSymlink: false,
  size: 0,
  modified: 0,
  git: null,
  gitFromChildren: false,
  ...over,
});

// A directory slice in the backend's arrival order is NOT alphabetical
// except within its groups, so a passing sort is not "already sorted".
const dir = (name: string, over: Partial<FsEntry> = {}): FsEntry =>
  e({ name, isDir: true, ...over });
const file = (name: string, over: Partial<FsEntry> = {}): FsEntry =>
  e({ name, ...over });

const NAMES = [
  "zebra.ts",
  "Apple",
  "banana.md",
  "apple.ts",
  "Zebra",
  "cherry.ts",
];

const spec = (over: Partial<SortSpec> = {}): SortSpec => ({
  ...DEFAULT_SORT,
  ...over,
});

describe("sortEntries", () => {
  it("the default IS the backend order: folders first, names case-blind", () => {
    const listing = [
      file("zebra.ts"),
      dir("src"),
      file("Apple"),
      dir("Beta"),
      file("apple.ts"),
    ];
    expect(sortEntries(listing, DEFAULT_SORT).map((x) => x.name)).toEqual([
      "Beta",
      "src",
      "Apple",
      "apple.ts",
      "zebra.ts",
    ]);
  });

  it("name: ascending and descending are each other's reverse", () => {
    const asc = sortEntries(NAMES.map((n) => file(n)), spec({ dirsFirst: false }));
    const desc = sortEntries(
      NAMES.map((n) => file(n)),
      spec({ asc: false, dirsFirst: false })
    );
    expect(asc.map((x) => x.name)).toEqual([
      "Apple",
      "apple.ts",
      "banana.md",
      "cherry.ts",
      "Zebra",
      "zebra.ts",
    ]);
    expect(desc.map((x) => x.name)).toEqual(asc.map((x) => x.name).slice().reverse());
  });

  it("kind: orders by extension, not by whole name", () => {
    const got = sortEntries(
      [file("zebra.ts"), file("banana.md"), file("Apple"), file("cherry.ts")],
      spec({ key: "kind", dirsFirst: false })
    );
    // No extension ("Apple") is the smallest kind; .md before .ts; the two
    // .ts entries tie and keep their arrival order.
    expect(got.map((x) => x.name)).toEqual([
      "Apple",
      "banana.md",
      "zebra.ts",
      "cherry.ts",
    ]);
  });

  it("size: ascending small-to-large, descending the reverse", () => {
    const files = [
      file("mid", { size: 50 }),
      file("big", { size: 900 }),
      file("tiny", { size: 1 }),
    ];
    expect(
      sortEntries(files, spec({ key: "size", dirsFirst: false })).map((x) => x.name)
    ).toEqual(["tiny", "mid", "big"]);
    expect(
      sortEntries(files, spec({ key: "size", asc: false, dirsFirst: false })).map(
        (x) => x.name
      )
    ).toEqual(["big", "mid", "tiny"]);
  });

  it("modified: null mtimes sit at the END in both directions", () => {
    const files = [
      file("unknown", { modified: null }),
      file("old", { modified: 100 }),
      file("new", { modified: 900 }),
      file("also-unknown", { modified: null }),
    ];
    expect(
      sortEntries(files, spec({ key: "modified", dirsFirst: false })).map((x) => x.name)
    ).toEqual(["old", "new", "unknown", "also-unknown"]);
    expect(
      sortEntries(files, spec({ key: "modified", asc: false, dirsFirst: false })).map(
        (x) => x.name
      )
    ).toEqual(["new", "old", "unknown", "also-unknown"]);
  });

  it("dirsFirst holds folders above files under every key and direction", () => {
    const pair = () => [
      file("a-file", { size: 5, modified: 50 }),
      dir("z-dir", { size: 0, modified: 0 }),
    ];
    for (const key of SORT_KEYS) {
      for (const asc of [true, false]) {
        const got = sortEntries(pair(), spec({ key, asc, dirsFirst: true }));
        expect(got[0].name, `${key}/${asc}`).toBe("z-dir");
      }
    }
    // Off, folders compete on the key like everything else: name asc puts
    // the file first while size asc puts the (empty) folder first — the
    // key decides, not the shape of the entry.
    const off = (key: SortKey, asc: boolean) =>
      sortEntries(pair(), spec({ key, asc, dirsFirst: false }))[0].name;
    expect(off("name", true)).toBe("a-file");
    expect(off("name", false)).toBe("z-dir");
    expect(off("size", true)).toBe("z-dir");
    expect(off("size", false)).toBe("a-file");
    expect(off("modified", true)).toBe("z-dir");
    expect(off("modified", false)).toBe("a-file");
    // Neither has an extension, so kind ties and the arrival order stands.
    expect(off("kind", true)).toBe("a-file");
    expect(off("kind", false)).toBe("a-file");
  });

  it("keeps the backend order for entries equal under the key", () => {
    // Equal size, equal kind: neither key distinguishes them, so the backend
    // arrival order ("zebra" before "Apple") must survive the sort.
    const files = [
      file("zebra.ts", { size: 10 }),
      file("Apple.ts", { size: 10 }),
      file("melon.ts", { size: 1 }),
    ];
    expect(
      sortEntries(files, spec({ key: "size", dirsFirst: false })).map((x) => x.name)
    ).toEqual(["melon.ts", "zebra.ts", "Apple.ts"]);
  });

  it("never reorders the caller's array", () => {
    const listing = [file("b"), file("a")];
    sortEntries(listing, spec({ key: "name", dirsFirst: false }));
    expect(listing.map((x) => x.name)).toEqual(["b", "a"]);
  });

  it("a shuffled listing comes back in the backend's canonical order under the default", () => {
    const canonical = ["Beta", "src", "Apple", "apple.ts", "zebra.ts"];
    const shuffled = [file("zebra.ts"), file("apple.ts"), file("Apple"), dir("src"), dir("Beta")];
    expect(sortEntries(shuffled, DEFAULT_SORT).map((x) => x.name)).toEqual(canonical);
    expect(
      sortEntries(sortEntries(shuffled, DEFAULT_SORT), DEFAULT_SORT).map((x) => x.name)
    ).toEqual(canonical);
  });
});

describe("entryKind", () => {
  it("takes the last extension, lower-cased, without the dot", () => {
    expect(entryKind("A.TXT")).toBe("txt");
    expect(entryKind("archive.tar.gz")).toBe("gz");
    expect(entryKind("Makefile")).toBe("");
    expect(entryKind(".hidden")).toBe("");
  });
});

describe("sameSort", () => {
  it("the default equals itself and nothing else that differs by a field", () => {
    expect(sameSort(DEFAULT_SORT, { ...DEFAULT_SORT })).toBe(true);
    expect(sameSort(DEFAULT_SORT, { ...DEFAULT_SORT, asc: false })).toBe(false);
    expect(sameSort(DEFAULT_SORT, { ...DEFAULT_SORT, key: "size" })).toBe(false);
    expect(sameSort(DEFAULT_SORT, { ...DEFAULT_SORT, dirsFirst: false })).toBe(false);
  });
});
