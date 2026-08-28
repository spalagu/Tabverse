import { describe, expect, it, vi } from "vitest";
import { applySites, previewScope, siteKey } from "./ReplacePreview";
import type { PreviewFile, ReplacePreview } from "../../backend/fs";

// Monaco cannot load in the test environment (compareView.test.ts's mock,
// same reason): the pure functions under test never touch the editor.
vi.mock("./CodeEditor", () => ({
  CodeEditor: () => null,
  disposeEditorState: () => {},
  languageFor: (p: string) => p,
  openEditorFind: () => false,
  currentEditorThemeName: () => "",
}));


const file = (over: Partial<PreviewFile> = {}): PreviewFile => ({
  rel: "a.txt",
  path: "/w/a.txt",
  modified: 1000,
  before: "one two\nthree two\n",
  sites: [
    { line: 1, col: 5, beforeLen: 3, afterLen: 1, context: [] },
    { line: 2, col: 7, beforeLen: 3, afterLen: 1, context: [] },
  ],
  ...over,
});

const preview = (files: PreviewFile[]): ReplacePreview => ({
  files,
  replacements: files.reduce((n, f) => n + f.sites.length, 0),
  filesMatched: files.length,
});

describe("applySites", () => {
  it("with nothing skipped, reproduces the backend rebuild's output", () => {
    // The exact fixture search.rs's trailing-newline test writes.
    expect(applySites(file().before, file().sites, "2", new Set(), "a.txt")).toBe(
      "one 2\nthree 2\n"
    );
  });

  it("an unchecked place keeps its original text", () => {
    const skipped = new Set([siteKey("a.txt", 2, 7)]);
    expect(applySites(file().before, file().sites, "2", skipped, "a.txt")).toBe(
      "one 2\nthree two\n"
    );
  });

  it("splices two places on one line without either shifting the other", () => {
    const f = file({
      before: "two and two\n",
      sites: [
        { line: 1, col: 1, beforeLen: 3, afterLen: 4, context: [] },
        { line: 1, col: 9, beforeLen: 3, afterLen: 4, context: [] },
      ],
    });
    expect(applySites(f.before, f.sites, "four", new Set(), "a.txt")).toBe(
      "four and four\n"
    );
  });
});

describe("previewScope", () => {
  it("quotes the preview's own counts, which differ from any search display's", () => {
    // Five places in the preview while some search display once said
    // three: the preview's five is the only number the confirm may say.
    const p = preview([
      file(),
      file({
        rel: "b.txt",
        path: "/w/b.txt",
        before: "two\ntwo\ntwo\n",
        sites: [
          { line: 1, col: 1, beforeLen: 3, afterLen: 1, context: [] },
          { line: 2, col: 1, beforeLen: 3, afterLen: 1, context: [] },
          { line: 3, col: 1, beforeLen: 3, afterLen: 1, context: [] },
        ],
      }),
    ]);
    expect(p.replacements).toBe(5);
    expect(previewScope(p, new Set())).toEqual({ files: 2, places: 5 });
  });

  it("follows the checkboxes: unchecking a place drops it and its file", () => {
    const p = preview([file()]);
    const skipped = new Set([siteKey("a.txt", 1, 5), siteKey("a.txt", 2, 7)]);
    expect(previewScope(p, skipped)).toEqual({ files: 0, places: 0 });
    const half = new Set([siteKey("a.txt", 2, 7)]);
    expect(previewScope(p, half)).toEqual({ files: 1, places: 1 });
  });
});
