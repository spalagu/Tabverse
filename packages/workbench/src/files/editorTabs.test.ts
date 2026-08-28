import { describe, expect, it } from "vitest";
import {
  dirtyAmong,
  discardPrompt,
  relativePath,
  tabsToClose,
} from "./editorTabs";

const strip = (...paths: string[]) => paths.map((path) => ({ path }));

const OPEN = strip("/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/d.ts");

describe("tabsToClose", () => {
  it("closes only the clicked tab", () => {
    expect(tabsToClose(OPEN, "/w/b.ts", "this")).toEqual(["/w/b.ts"]);
  });

  it("excludes the clicked tab from close-others", () => {
    expect(tabsToClose(OPEN, "/w/b.ts", "others")).toEqual([
      "/w/a.ts",
      "/w/c.ts",
      "/w/d.ts",
    ]);
  });

  it("closes nothing but the clicked tab's neighbours to its right", () => {
    expect(tabsToClose(OPEN, "/w/b.ts", "right")).toEqual([
      "/w/c.ts",
      "/w/d.ts",
    ]);
  });

  it("follows strip order, not alphabetical or path order", () => {
    const reordered = strip("/w/d.ts", "/w/a.ts", "/w/c.ts", "/w/b.ts");
    expect(tabsToClose(reordered, "/w/a.ts", "right")).toEqual([
      "/w/c.ts",
      "/w/b.ts",
    ]);
  });

  it("closes nothing to the right of the last tab", () => {
    expect(tabsToClose(OPEN, "/w/d.ts", "right")).toEqual([]);
  });

  it("closes nothing else when one file is open", () => {
    const one = strip("/w/a.ts");
    expect(tabsToClose(one, "/w/a.ts", "others")).toEqual([]);
    expect(tabsToClose(one, "/w/a.ts", "right")).toEqual([]);
    expect(tabsToClose(one, "/w/a.ts", "all")).toEqual(["/w/a.ts"]);
  });

  it("closes everything under close-all, clicked tab included", () => {
    expect(tabsToClose(OPEN, "/w/c.ts", "all")).toEqual([
      "/w/a.ts",
      "/w/b.ts",
      "/w/c.ts",
      "/w/d.ts",
    ]);
  });

  it("closes nothing for a tab that is no longer in the strip", () => {
    expect(tabsToClose(OPEN, "/w/gone.ts", "this")).toEqual([]);
    expect(tabsToClose(OPEN, "/w/gone.ts", "others")).toEqual([]);
    expect(tabsToClose(OPEN, "/w/gone.ts", "right")).toEqual([]);
  });

  it("still closes the whole strip under close-all with no clicked tab", () => {
    expect(tabsToClose(OPEN, "/w/gone.ts", "all")).toHaveLength(4);
  });
});

describe("dirtyAmong", () => {
  const dirty = new Set(["/w/a.ts", "/w/d.ts"]);
  const isDirty = (p: string) => dirty.has(p);

  it("keeps the given order", () => {
    expect(dirtyAmong(["/w/d.ts", "/w/b.ts", "/w/a.ts"], isDirty)).toEqual([
      "/w/d.ts",
      "/w/a.ts",
    ]);
  });

  it("is empty when nothing in the set has a draft", () => {
    expect(dirtyAmong(["/w/b.ts", "/w/c.ts"], isDirty)).toEqual([]);
  });

  it("ignores unsaved files the action does not close", () => {
    // /w/a.ts has a draft but is the tab that stays, so it is not at risk
    // and must not appear in the question.
    const closing = tabsToClose(OPEN, "/w/a.ts", "right");
    expect(dirtyAmong(closing, isDirty)).toEqual(["/w/d.ts"]);
  });

  it("asks about the clicked tab only when the action takes it", () => {
    expect(dirtyAmong(tabsToClose(OPEN, "/w/a.ts", "others"), isDirty)).toEqual([
      "/w/d.ts",
    ]);
    expect(dirtyAmong(tabsToClose(OPEN, "/w/a.ts", "all"), isDirty)).toEqual([
      "/w/a.ts",
      "/w/d.ts",
    ]);
  });
});

describe("relativePath", () => {
  it("drops the root prefix", () => {
    expect(relativePath("/w", "/w/src/App.tsx")).toBe("src/App.tsx");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(relativePath("/w/", "/w/src/App.tsx")).toBe("src/App.tsx");
  });

  it("keeps the absolute path for a file outside the root", () => {
    expect(relativePath("/w", "/other/App.tsx")).toBe("/other/App.tsx");
  });

  it("handles an uncontrolled root with many trailing separators", () => {
    expect(relativePath(`/w${"/".repeat(100_000)}`, "/w/App.tsx")).toBe(
      "App.tsx"
    );
  });

  it("does not treat a sibling directory as the root", () => {
    expect(relativePath("/w", "/works/App.tsx")).toBe("/works/App.tsx");
  });

  it("falls back to the whole path when there is no root yet", () => {
    expect(relativePath("", "/w/App.tsx")).toBe("/w/App.tsx");
  });
});

describe("discardPrompt", () => {
  it("says nothing when nothing is at risk", () => {
    expect(discardPrompt([])).toBe("");
  });

  it("names the single file", () => {
    expect(discardPrompt(["src/App.tsx"])).toBe(
      "src/App.tsx has unsaved changes. Discard them?"
    );
  });

  it("names every file and says cancelling closes nothing", () => {
    const text = discardPrompt(["a.ts", "b.ts", "c.ts"]);
    expect(text).toContain("Discard unsaved changes in 3 files?");
    expect(text).toContain("• a.ts");
    expect(text).toContain("• b.ts");
    expect(text).toContain("• c.ts");
    expect(text).toContain("Cancel closes nothing.");
    expect(text).not.toContain("more");
  });

  it("counts the rest once the list stops informing", () => {
    const names = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const text = discardPrompt(names, 6);
    expect(text).toContain("Discard unsaved changes in 9 files?");
    expect(text).toContain("• f5.ts");
    expect(text).not.toContain("• f6.ts");
    expect(text).toContain("• …and 3 more");
  });
});
