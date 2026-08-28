import { describe, expect, it, vi } from "vitest";
import { globGhost, nameAbsPaths } from "./SearchPanel";
import { newPane, selectionAll } from "./panes";

// SearchPanel's preview pane renders a Monaco diff; monaco cannot load in
// the test environment (compareView.test.ts's mock, same reason). The
// functions under test never touch it.
vi.mock("./CodeEditor", () => ({
  CodeEditor: () => null,
  disposeEditorState: () => {},
  languageFor: (p: string) => p,
  openEditorFind: () => false,
  currentEditorThemeName: () => "",
}));

describe("globGhost", () => {
  it("offers **/ for a bare pattern, the one people mean", () => {
    expect(globGhost("*.rs")).toBe("**/*.rs");
    expect(globGhost("notes*")).toBe("**/notes*");
  });

  it("stays quiet once the pattern names a path or a double star", () => {
    // A pattern with a separator says where it means to match — the user
    // has taken over.
    expect(globGhost("src/*.rs")).toBeNull();
    expect(globGhost("**/*.rs")).toBeNull();
    expect(globGhost("")).toBeNull();
  });
});

describe("nameAbsPaths", () => {
  it("roots each relative path once, without doubling the separator", () => {
    expect(nameAbsPaths("/work", ["src/a.ts", "b.md"])).toEqual([
      "/work/src/a.ts",
      "/work/b.md",
    ]);
    expect(nameAbsPaths("/work/", ["b.md"])).toEqual(["/work/b.md"]);
  });

  it("feeds selectionAll unchanged — the shape transferBatch consumes", () => {
    const abs = nameAbsPaths("/work", ["src/a.ts", "b.md"]);
    const picked = selectionAll(newPane("/work"), abs);
    // The pane's picking set holds exactly these absolute paths, anchor
    // on the first — the tree's drag and batch menus act on this array.
    expect(picked.selectedPaths).toEqual(abs);
    expect(picked.selectionAnchor).toBe(abs[0]);
  });
});
