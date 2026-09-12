import { describe, expect, it } from "vitest";
import { PANEL_DEFAULT_PX, PANEL_MIN_PX } from "./termSync";
import { DEFAULT_SORT } from "./sortEntries";
import {
  MAX_DRAFT_BYTES,
  buildFilesSession,
  decideDraft,
  mtimeUnchanged,
  normalizeFilesState,
  pruneWorkspace,
  storedPanes,
  utf8Bytes,
  type FilesSnapshot,
  type PaneSnapshot,
  type SessionFile,
  type StoredPane,
} from "./session";

const file = (over: Partial<SessionFile> & { path: string }): SessionFile => ({
  text: "on disk",
  modified: 1000,
  readOnlyReason: null,
  ...over,
});

const pane = (over: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  root: "/work",
  expanded: ["/work/src"],
  open: [file({ path: "/work/a.ts" })],
  active: "/work/a.ts",
  viewModes: new Map(),
  drafts: new Map(),
  treeModes: new Map(),
  sort: DEFAULT_SORT,
  ...over,
});

const snapshot = (over: Partial<FilesSnapshot> = {}): FilesSnapshot => ({
  panes: [pane()],
  layout: "row",
  activePane: 0,
  showDiff: true,
  term: { open: false, height: PANEL_DEFAULT_PX, cwd: "/work" },
  panelMode: "tree",
  ...over,
});

describe("buildFilesSession", () => {
  it("stores the workspace: root, expansion, open files, active, modes", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [
          pane({
            root: "/jumped/via/location/bar",
            expanded: ["/work/src", "/work/src/deep"],
            open: [file({ path: "/work/a.ts" }), file({ path: "/work/b.md" })],
            active: "/work/b.md",
            viewModes: new Map([["/work/b.md", "split"]]),
          }),
        ],
        showDiff: false,
      })
    );
    expect(state).toEqual({
      v: 1,
      showDiff: false,
      term: { open: false, height: PANEL_DEFAULT_PX, cwd: "/work" },
      panes: [
        {
          root: "/jumped/via/location/bar",
          expanded: ["/work/src", "/work/src/deep"],
          open: ["/work/a.ts", "/work/b.md"],
          active: "/work/b.md",
          viewModes: { "/work/b.md": "split" },
          drafts: {},
          treeModes: {},
        },
      ],
      layout: "row",
      activePane: 0,
      panelMode: "tree",
    });
  });

  it("stores the terminal panel: shown, how tall, where its shell was", () => {
    const { state } = buildFilesSession(
      snapshot({
        term: { open: true, height: 310, cwd: "/work/src" },
      })
    );
    expect(state.term).toEqual({ open: true, height: 310, cwd: "/work/src" });
  });

  it("stores a legal height even when handed one that is not", () => {
    const { state } = buildFilesSession(
      snapshot({ term: { open: true, height: 3, cwd: "/work" } })
    );
    expect(state.term.height).toBe(PANEL_MIN_PX);
  });

  it("stores a draft with the file's mtime at the time it was taken", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [
          pane({
            open: [file({ path: "/work/a.ts", modified: 4242 })],
            drafts: new Map([["/work/a.ts", "my edit"]]),
          }),
        ],
      })
    );
    expect(state.panes[0].drafts).toEqual({
      "/work/a.ts": { text: "my edit", modified: 4242 },
    });
  });

  it("drops a draft that matches disk — there is nothing unsaved", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [pane({ drafts: new Map([["/work/a.ts", "on disk"]]) })],
      })
    );
    expect(state.panes[0].drafts).toEqual({});
  });

  it("never stores a draft for a file that could not be written back", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [
          pane({
            open: [file({ path: "/work/a.ts", readOnlyReason: "too large" })],
            drafts: new Map([["/work/a.ts", "my edit"]]),
          }),
        ],
      })
    );
    expect(state.panes[0].drafts).toEqual({});
  });

  it("skips a draft above the per-draft cap and names it", () => {
    const huge = "x".repeat(MAX_DRAFT_BYTES + 1);
    const { state, skippedDrafts } = buildFilesSession(
      snapshot({
        panes: [
          pane({
            open: [file({ path: "/work/a.ts" }), file({ path: "/work/b.ts" })],
            drafts: new Map([
              ["/work/a.ts", huge],
              ["/work/b.ts", "small edit"],
            ]),
          }),
        ],
      })
    );
    expect(skippedDrafts).toEqual(["/work/a.ts"]);
    expect(Object.keys(state.panes[0].drafts)).toEqual(["/work/b.ts"]);
  });

  it("keeps the total under the budget when many drafts are large", () => {
    const big = "y".repeat(MAX_DRAFT_BYTES);
    const open = [];
    const drafts = new Map<string, string>();
    for (let i = 0; i < 8; i++) {
      open.push(file({ path: `/work/f${i}.ts` }));
      drafts.set(`/work/f${i}.ts`, big);
    }
    const { state, skippedDrafts } = buildFilesSession(
      snapshot({ panes: [pane({ open, drafts })] })
    );
    const total = Object.values(state.panes[0].drafts).reduce(
      (n, d) => n + d.text.length,
      0
    );
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(skippedDrafts.length).toBe(
      8 - Object.keys(state.panes[0].drafts).length
    );
  });

  it("keeps view modes and the active file tied to what is open", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [
          pane({
            open: [file({ path: "/work/a.ts" })],
            active: "/work/closed.ts",
            viewModes: new Map([
              ["/work/a.ts", "source"],
              ["/work/closed.ts", "split"],
            ]),
          }),
        ],
      })
    );
    expect(state.panes[0].viewModes).toEqual({ "/work/a.ts": "source" });
    expect(state.panes[0].active).toBe("/work/a.ts");
  });

  it("omits the sort when it is the default, so old and untouched payloads stay identical", () => {
    const { state } = buildFilesSession(snapshot());
    expect("sort" in state.panes[0]).toBe(false);
  });

  it("stores a non-default sort as three plain fields", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [pane({ sort: { key: "modified", asc: false, dirsFirst: false } })],
      })
    );
    expect(state.panes[0].sort).toEqual({
      key: "modified",
      asc: false,
      dirsFirst: false,
    });
    // And it survives the normalize round trip.
    const back = normalizeFilesState(JSON.parse(JSON.stringify(state)));
    expect(back!.panes[0].sort).toEqual({
      key: "modified",
      asc: false,
      dirsFirst: false,
    });
  });

  it("one pane writes the current explicit pane list", () => {
    const { state } = buildFilesSession(snapshot());
    expect(state.panes).toHaveLength(1);
    expect(state.layout).toBe("row");
    expect(state.activePane).toBe(0);
  });

  it("two panes write the pair, the arrangement and the front pane", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [
          pane({ root: "/left", open: [file({ path: "/left/a.ts" })] }),
          pane({
            root: "/right",
            expanded: ["/right/sub"],
            open: [file({ path: "/right/b.md" })],
            active: "/right/b.md",
            treeModes: new Map([["/right", "miller"]]),
            sort: { key: "size", asc: false, dirsFirst: true },
          }),
        ],
        layout: "column",
        activePane: 1,
      })
    );
    expect(state.panes).toHaveLength(2);
    expect(state.panes![1].root).toBe("/right");
    expect(state.panes![1].expanded).toEqual(["/right/sub"]);
    expect(state.panes![1].treeModes).toEqual({ "/right": "miller" });
    expect(state.panes![1].sort).toEqual({ key: "size", asc: false, dirsFirst: true });
    expect(state.layout).toBe("column");
    expect(state.activePane).toBe(1);
  });

  it("shares one draft budget across both panes — it is one stored scope", () => {
    const big = "z".repeat(MAX_DRAFT_BYTES);
    const mk = (root: string, n: number) => {
      const open = [];
      const drafts = new Map<string, string>();
      for (let i = 0; i < n; i++) {
        open.push(file({ path: `${root}/f${i}.ts` }));
        drafts.set(`${root}/f${i}.ts`, big);
      }
      return pane({ root, open, drafts });
    };
    // Three 1 MiB drafts per pane = 6 MiB against a 4 MiB tab ceiling: the
    // first four in stripe order survive, the last two are named as skipped
    // — one budget for the whole scope, whichever pane produced the bytes.
    const { state, skippedDrafts } = buildFilesSession(
      snapshot({ panes: [mk("/left", 3), mk("/right", 3)] })
    );
    expect(skippedDrafts).toEqual(["/right/f1.ts", "/right/f2.ts"]);
    expect(Object.keys(state.panes![0].drafts)).toEqual([
      "/left/f0.ts",
      "/left/f1.ts",
      "/left/f2.ts",
    ]);
    expect(Object.keys(state.panes![1].drafts)).toEqual(["/right/f0.ts"]);
  });
});

describe("utf8Bytes", () => {
  it("counts ASCII by length and multi-byte text by its real size", () => {
    expect(utf8Bytes("plain")).toBe(5);
    expect(utf8Bytes("\u65e5\u672c")).toBe(6);
  });
});

describe("normalizeFilesState", () => {
  it("accepts the current explicit pane list", () => {
    const raw = buildFilesSession(snapshot()).state;
    const state = normalizeFilesState(JSON.parse(JSON.stringify(raw)));
    expect(state).not.toBeNull();
    expect(storedPanes(state!)).toHaveLength(1);
    expect(state!.panes[0].root).toBe("/work");
  });

  it("rejects missing panes and unknown payload versions", () => {
    expect(normalizeFilesState(null)).toBeNull();
    expect(normalizeFilesState({ v: 1 })).toBeNull();
    expect(normalizeFilesState({ v: 99, panes: [] })).toBeNull();
  });
});

const state = (over: Partial<StoredPane> = {}): StoredPane => ({
  root: "/work",
  expanded: [],
  open: ["/work/a.ts", "/work/gone.ts", "/work/b.ts"],
  active: "/work/gone.ts",
  viewModes: { "/work/gone.ts": "split", "/work/b.ts": "source" },
  drafts: {},
  treeModes: {},
  ...over,
});

describe("pruneWorkspace", () => {
  it("drops paths that no longer exist and moves the active file", () => {
    const r = pruneWorkspace(state(), new Set(["/work/a.ts", "/work/b.ts"]));
    expect(r.open).toEqual(["/work/a.ts", "/work/b.ts"]);
    expect(r.active).toBe("/work/a.ts");
    expect([...r.viewModes]).toEqual([["/work/b.ts", "source"]]);
  });

  it("keeps the stored active file when it survived", () => {
    const r = pruneWorkspace(
      state({ active: "/work/b.ts" }),
      new Set(["/work/a.ts", "/work/b.ts"])
    );
    expect(r.active).toBe("/work/b.ts");
  });

  it("opens cleanly when every path moved", () => {
    const r = pruneWorkspace(state(), new Set());
    expect(r.open).toEqual([]);
    expect(r.active).toBeNull();
    expect(r.viewModes.size).toBe(0);
  });
});

describe("decideDraft", () => {
  it("restores silently when the file on disk is untouched", () => {
    const r = decideDraft(
      "/work/a.ts",
      { text: "my edit", modified: 1000 },
      file({ path: "/work/a.ts", modified: 1000 })
    );
    expect(r).toEqual({ kind: "restore", path: "/work/a.ts", text: "my edit" });
  });

  it("raises a conflict when the file changed under the draft", () => {
    const r = decideDraft(
      "/work/a.ts",
      { text: "my edit", modified: 1000 },
      file({ path: "/work/a.ts", modified: 2000, text: "someone else's work" })
    );
    expect(r).toEqual({
      kind: "conflict",
      path: "/work/a.ts",
      text: "my edit",
      disk: "someone else's work",
    });
  });

  it("raises a conflict when an mtime is missing — unproven is not unchanged", () => {
    const r = decideDraft(
      "/work/a.ts",
      { text: "my edit", modified: null },
      file({ path: "/work/a.ts", modified: 1000 })
    );
    expect(r.kind).toBe("conflict");
  });

  it("drops the draft when the file is gone, without noise", () => {
    const r = decideDraft("/work/a.ts", { text: "my edit", modified: 1000 }, null);
    expect(r).toEqual({ kind: "drop", path: "/work/a.ts", reason: "gone" });
  });

  it("drops a draft whose file can no longer be written or read as text", () => {
    expect(
      decideDraft(
        "/work/a.ts",
        { text: "my edit", modified: 1000 },
        file({ path: "/work/a.ts", readOnlyReason: "binary" })
      ).kind
    ).toBe("drop");
    expect(
      decideDraft(
        "/work/a.ts",
        { text: "my edit", modified: 1000 },
        file({ path: "/work/a.ts", text: null })
      ).kind
    ).toBe("drop");
  });

  it("drops a draft the file already contains, changed mtime or not", () => {
    const r = decideDraft(
      "/work/a.ts",
      { text: "same bytes", modified: 1000 },
      file({ path: "/work/a.ts", modified: 9999, text: "same bytes" })
    );
    expect(r).toEqual({
      kind: "drop",
      path: "/work/a.ts",
      reason: "identical",
    });
  });
});

describe("mtimeUnchanged", () => {
  it("proves nothing changed only when both mtimes are known and equal", () => {
    expect(mtimeUnchanged(1000, 1000)).toBe(true);
    expect(mtimeUnchanged(1000, 2000)).toBe(false);
    // Unknown on either side is unproven, and unproven is not unchanged.
    expect(mtimeUnchanged(null, 1000)).toBe(false);
    expect(mtimeUnchanged(1000, null)).toBe(false);
    expect(mtimeUnchanged(null, null)).toBe(false);
  });
});

describe("panelMode", () => {
  it("is always written in the current representation", () => {
    const { state } = buildFilesSession(snapshot({ panelMode: "search" }));
    expect(state.panelMode).toBe("search");
    const { state: tree } = buildFilesSession(snapshot({ panelMode: "tree" }));
    expect(tree.panelMode).toBe("tree");
  });

  it("restores the current value and rejects missing or invalid values", () => {
    const saved = normalizeFilesState(
      buildFilesSession(snapshot({ panelMode: "changes" })).state
    );
    expect(saved?.panelMode).toBe("changes");
    expect(normalizeFilesState(null)?.panelMode).toBeUndefined();
    const missing = buildFilesSession(snapshot()).state as Partial<
      ReturnType<typeof buildFilesSession>["state"]
    >;
    delete missing.panelMode;
    expect(normalizeFilesState(missing)).toBeNull();
    const junk = buildFilesSession(snapshot()).state as unknown as Record<
      string,
      unknown
    >;
    junk.panelMode = "sideways";
    expect(normalizeFilesState(junk)).toBeNull();
  });
});
