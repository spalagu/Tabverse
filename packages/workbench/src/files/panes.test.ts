import { describe, expect, it } from "vitest";
import { DEFAULT_SORT } from "./sortEntries";
import {
  applyPaneAction,
  closedPane,
  conflictResolvedPane,
  draftedPane,
  modeSetPane,
  navBackPane,
  navForwardPane,
  newPane as createPane,
  openInPane,
  paneForPath,
  pushNav,
  selectionAll,
  selectionCleared,
  selectionExtended,
  selectionLanded,
  selectionToggled,
  type PaneState as SharedPaneState,
} from "./panes";

interface FileMeta {
  path: string;
  name: string;
  size: number;
  kind: string;
  mime: string;
  text: string | null;
  truncated: boolean;
  readOnlyReason: string | null;
  headText: string | null;
  git: string | null;
  modified: number | null;
}

type PaneState = SharedPaneState<FileMeta>;
const newTestPane = (root: string): PaneState => createPane<FileMeta>(root);


const meta = (path: string, over: Partial<FileMeta> = {}): FileMeta => ({
  path,
  name: path.split("/").pop() ?? path,
  size: 10,
  kind: "text",
  mime: "text/plain",
  text: "on disk",
  truncated: false,
  readOnlyReason: null,
  headText: null,
  git: null,
  modified: 1000,
  ...over,
});

const paneWith = (root: string, path: string): PaneState => ({
  ...newTestPane(root),
  open: [meta(path)],
  activePath: path,
});

/** A dirty draft sits on the pane's one open file. */
const dirtyPane = (root: string, path: string): PaneState => ({
  ...paneWith(root, path),
  drafts: new Map([[path, "edited"]]),
});

describe("paneForPath", () => {
  it("routes a path to the pane whose root contains it", () => {
    const panes = [newTestPane("/work/alpha"), newTestPane("/work/beta")];
    expect(paneForPath(panes, "/work/beta/src/x.ts", 0)).toBe(1);
    expect(paneForPath(panes, "/work/alpha/x.ts", 1)).toBe(0);
  });

  it("containment is exact: /wo does not contain /work/x", () => {
    const panes = [newTestPane("/wo"), newTestPane("/elsewhere")];
    expect(paneForPath(panes, "/work/x.ts", 1)).toBe(1);
  });

  it("a path under both roots stays with the active pane; elsewhere goes active", () => {
    const panes = [newTestPane("/work"), newTestPane("/work")];
    expect(paneForPath(panes, "/work/x.ts", 1)).toBe(1);
    expect(paneForPath(panes, "/etc/hosts", 0)).toBe(0);
  });

  it("the root itself belongs to its pane", () => {
    const panes = [newTestPane("/work"), newTestPane("/other")];
    expect(paneForPath(panes, "/work", 1)).toBe(0);
  });

  it("routes a root with many trailing separators in linear time", () => {
    const panes = [
      newTestPane(`/work${"/".repeat(100_000)}`),
      newTestPane("/other"),
    ];
    expect(paneForPath(panes, "/work/src/x.ts", 1)).toBe(0);
  });
});

describe("applyPaneAction — the four local keys' pane routing", () => {
  it("save settles the ACTIVE pane's draft and leaves the other pane's alone", () => {
    const panes = [dirtyPane("/a", "/a/x.ts"), dirtyPane("/b", "/b/y.ts")];
    const next = applyPaneAction(panes, 1, {
      kind: "save",
      path: "/b/y.ts",
      fresh: meta("/b/y.ts"),
      racedDraft: null,
    });
    // The background pane is untouched: its draft survives verbatim.
    expect(next[0].drafts.get("/a/x.ts")).toBe("edited");
    expect(next[0].open[0].text).toBe("on disk");
    // The active pane's save landed: draft gone, meta refreshed.
    expect(next[1].drafts.has("/b/y.ts")).toBe(false);
    expect(next[1].open[0].text).toBe("on disk");
  });

  it("a keystroke's draft lands on the active pane only", () => {
    const panes = [paneWith("/a", "/a/x.ts"), paneWith("/b", "/b/y.ts")];
    const next = applyPaneAction(panes, 1, {
      kind: "draft",
      path: "/b/y.ts",
      text: "typed",
    });
    expect(next[1].drafts.get("/b/y.ts")).toBe("typed");
    expect(next[0].drafts.size).toBe(0);
  });

  it("closing in the active pane picks the strip's own successor", () => {
    const panes = [
      { ...newTestPane("/a"), open: [meta("/a/keep.ts")], activePath: "/a/keep.ts" },
      {
        ...newTestPane("/b"),
        open: [meta("/b/one.ts"), meta("/b/two.ts"), meta("/b/three.ts")],
        activePath: "/b/one.ts",
      },
    ];
    const next = applyPaneAction(panes, 1, { kind: "close", paths: ["/b/one.ts"] });
    expect(next[1].open.map((f) => f.path)).toEqual(["/b/two.ts", "/b/three.ts"]);
    expect(next[1].activePath).toBe("/b/two.ts");
    expect(next[0].open.map((f) => f.path)).toEqual(["/a/keep.ts"]);
  });

  it("an open carries its own routing — a handed-over file names its pane", () => {
    const panes = [newTestPane("/a"), newTestPane("/b")];
    const next = applyPaneAction(panes, 0, {
      kind: "open",
      meta: meta("/b/handed.ts"),
      pane: 1,
    });
    expect(next[1].open.map((f) => f.path)).toEqual(["/b/handed.ts"]);
    expect(next[1].activePath).toBe("/b/handed.ts");
    expect(next[0].open).toHaveLength(0);
  });

  it("opening the same file twice does not duplicate it, and makes it active", () => {
    let p = openInPane(paneWith("/a", "/a/x.ts"), meta("/a/y.ts"));
    p = openInPane(p, meta("/a/y.ts"));
    expect(p.open.map((f) => f.path)).toEqual(["/a/x.ts", "/a/y.ts"]);
    expect(p.activePath).toBe("/a/y.ts");
  });
});

describe("closedPane", () => {
  it("closing the active file with no survivor empties the strip cleanly", () => {
    const p = closedPane(paneWith("/a", "/a/x.ts"), ["/a/x.ts"]);
    expect(p.open).toEqual([]);
    expect(p.activePath).toBeNull();
    expect(p.drafts.size).toBe(0);
  });

  it("closing from the end leaves the last survivor active", () => {
    const p: PaneState = {
      ...newTestPane("/a"),
      open: [meta("/a/one.ts"), meta("/a/two.ts")],
      activePath: "/a/two.ts",
    };
    const r = closedPane(p, ["/a/two.ts"]);
    expect(r.activePath).toBe("/a/one.ts");
  });
});

describe("draftedPane / modeSetPane / conflictResolvedPane", () => {
  it("drafts and view modes are per-file, maps copied not mutated", () => {
    const p = paneWith("/a", "/a/x.ts");
    const d = draftedPane(p, "/a/x.ts", "text");
    const m = modeSetPane(d, "/a/x.ts", "source");
    expect(p.drafts.size).toBe(0);
    expect(m.drafts.get("/a/x.ts")).toBe("text");
    expect(m.viewModes.get("/a/x.ts")).toBe("source");
  });

  it("keeping a disputed draft only lowers the flag; discarding drops the draft", () => {
    const p: PaneState = {
      ...dirtyPane("/a", "/a/x.ts"),
      conflicts: new Set(["/a/x.ts"]),
    };
    const kept = conflictResolvedPane(p, "/a/x.ts", true);
    expect(kept.conflicts.has("/a/x.ts")).toBe(false);
    expect(kept.drafts.get("/a/x.ts")).toBe("edited");
    const dropped = conflictResolvedPane(p, "/a/x.ts", false);
    expect(dropped.conflicts.has("/a/x.ts")).toBe(false);
    expect(dropped.drafts.has("/a/x.ts")).toBe(false);
  });
});

describe("root navigation history", () => {
  it("a jump leaves the old root on the back stack and clears the way forward", () => {
    const p = pushNav({ ...newTestPane("/a"), root: "/b" }, "/a");
    expect(p.nav).toEqual({ back: ["/a"], fwd: [] });
  });

  it("going back moves the root, keeping the place for going forward again", () => {
    const p = pushNav({ ...newTestPane("/a"), root: "/b" }, "/a");
    const back = navBackPane(p)!;
    expect(back.to).toBe("/a");
    expect(back.pane.root).toBe("/a");
    expect(back.pane.nav).toEqual({ back: [], fwd: ["/b"] });
    // And forward returns: ⌘] then ⌘[ are each other's inverse.
    const fwd = navForwardPane(back.pane)!;
    expect(fwd.to).toBe("/b");
    expect(fwd.pane.root).toBe("/b");
    expect(fwd.pane.nav).toEqual({ back: ["/a"], fwd: [] });
  });

  it("nowhere to go is nowhere to go, in either direction", () => {
    const p = newTestPane("/a");
    expect(navBackPane(p)).toBeNull();
    expect(navForwardPane(p)).toBeNull();
    // A fresh jump clears the forward stack: going back then jumping anew
    // abandons the branch that was forward — and there is no "forward" to
    // the place you already are.
    const jumped = pushNav({ ...newTestPane("/a"), root: "/b" }, "/a");
    const back = navBackPane(jumped)!;
    const jumpedAgain = pushNav({ ...back.pane, root: "/c" }, "/a");
    expect(jumpedAgain.nav).toEqual({ back: ["/a"], fwd: [] });
    expect(navForwardPane(jumpedAgain)).toBeNull();
  });

  it("a repeat of the top of the back stack is not pushed twice", () => {
    let p = newTestPane("/a");
    p = pushNav({ ...p, root: "/b" }, "/a");
    p = pushNav(p, "/a");
    expect(p.nav.back).toEqual(["/a"]);
  });
});

describe("newPane", () => {
  it("starts everywhere-empty with the default sort and no navigation history", () => {
    const p = newTestPane("/w");
    expect(p.root).toBe("/w");
    expect(p.open).toEqual([]);
    expect(p.sort).toEqual(DEFAULT_SORT);
    expect(p.treeModes.size).toBe(0);
    expect(p.nav).toEqual({ back: [], fwd: [] });
  });
});

describe("tree-row multi-selection ops", () => {
  // The drawn sequence the range counts in: sdk, sub, a.txt, c.txt — the
  // same contract the tree hands these functions, unexpanded children out.
  const VISIBLE = ["/w/sdk", "/w/sub", "/w/a.txt", "/w/c.txt"];

  it("toggle adds, anchors on the row, and takes it back out", () => {
    let p = newTestPane("/w");
    p = selectionToggled(p, "/w/a.txt");
    expect(p.selectedPaths).toEqual(["/w/a.txt"]);
    expect(p.selectionAnchor).toBe("/w/a.txt");
    p = selectionToggled(p, "/w/c.txt");
    expect(p.selectedPaths).toEqual(["/w/a.txt", "/w/c.txt"]);
    p = selectionToggled(p, "/w/a.txt");
    expect(p.selectedPaths).toEqual(["/w/c.txt"]);
    expect(p.selectionAnchor).toBe("/w/a.txt");
  });

  it("extend ranges over the drawn sequence, both directions, and starts fresh when the anchor left it", () => {
    let p = newTestPane("/w");
    p = selectionToggled(p, "/w/sub");
    p = selectionExtended(p, "/w/c.txt", VISIBLE);
    expect(p.selectedPaths).toEqual(["/w/sub", "/w/a.txt", "/w/c.txt"]);
    // Backwards: anchor below, row above — the same span.
    p = selectionToggled(p, "/w/c.txt");
    p = selectionExtended(p, "/w/sdk", VISIBLE);
    expect(p.selectedPaths).toEqual(["/w/sdk", "/w/sub", "/w/a.txt", "/w/c.txt"]);
    // An anchor no row can see (collapsed under, filtered out) starts a
    // new range rather than reaching across the invisible.
    p = selectionToggled(p, "/w/gone");
    p = selectionExtended(p, "/w/c.txt", ["/w/a.txt", "/w/c.txt"]);
    expect(p.selectedPaths).toEqual(["/w/c.txt"]);
    expect(p.selectionAnchor).toBe("/w/c.txt");
  });

  it("select-all takes the sequence it is given and anchors at its first row", () => {
    let p = newTestPane("/w");
    p = selectionAll(p, VISIBLE.slice(2));
    expect(p.selectedPaths).toEqual(["/w/a.txt", "/w/c.txt"]);
    expect(p.selectionAnchor).toBe("/w/a.txt");
    p = selectionAll(p, []);
    expect(p.selectedPaths).toEqual([]);
    expect(p.selectionAnchor).toBeNull();
  });

  it("cleared empties both halves and is a no-op on an empty picking", () => {
    let p = newTestPane("/w");
    expect(selectionCleared(p)).toBe(p);
    p = selectionToggled(p, "/w/a.txt");
    const q = selectionCleared(p);
    expect(q.selectedPaths).toEqual([]);
    expect(q.selectionAnchor).toBeNull();
  });

  it("landed points at the answers — not the requested names — anchored at the last", () => {
    let p = newTestPane("/w");
    p = selectionToggled(p, "/w/a.txt");
    p = selectionLanded(p, ["/w/sub/a 2.txt", "/w/sub/c 2.txt"]);
    expect(p.selectedPaths).toEqual(["/w/sub/a 2.txt", "/w/sub/c 2.txt"]);
    expect(p.selectionAnchor).toBe("/w/sub/c 2.txt");
    expect(selectionLanded(p, []).selectedPaths).toEqual([]);
  });
});
