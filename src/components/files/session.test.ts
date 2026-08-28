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
  type FilesSessionState,
  type FilesSnapshot,
  type PaneSnapshot,
  type SessionFile,
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
      root: "/jumped/via/location/bar",
      expanded: ["/work/src", "/work/src/deep"],
      open: ["/work/a.ts", "/work/b.md"],
      active: "/work/b.md",
      viewModes: { "/work/b.md": "split" },
      showDiff: false,
      drafts: {},
      term: { open: false, height: PANEL_DEFAULT_PX, cwd: "/work" },
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
    expect(state.drafts).toEqual({
      "/work/a.ts": { text: "my edit", modified: 4242 },
    });
  });

  it("drops a draft that matches disk — there is nothing unsaved", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [pane({ drafts: new Map([["/work/a.ts", "on disk"]]) })],
      })
    );
    expect(state.drafts).toEqual({});
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
    expect(state.drafts).toEqual({});
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
    expect(Object.keys(state.drafts)).toEqual(["/work/b.ts"]);
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
    const total = Object.values(state.drafts).reduce(
      (n, d) => n + d.text.length,
      0
    );
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(skippedDrafts.length).toBe(8 - Object.keys(state.drafts).length);
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
    expect(state.viewModes).toEqual({ "/work/a.ts": "source" });
    expect(state.active).toBe("/work/a.ts");
  });

  it("omits the sort when it is the default, so old and untouched payloads stay identical", () => {
    const { state } = buildFilesSession(snapshot());
    expect("sort" in state).toBe(false);
  });

  it("stores a non-default sort as three plain fields", () => {
    const { state } = buildFilesSession(
      snapshot({
        panes: [pane({ sort: { key: "modified", asc: false, dirsFirst: false } })],
      })
    );
    expect(state.sort).toEqual({ key: "modified", asc: false, dirsFirst: false });
    // And it survives the normalize round trip.
    const back = normalizeFilesState(JSON.parse(JSON.stringify(state)));
    expect(back!.sort).toEqual({ key: "modified", asc: false, dirsFirst: false });
  });

  it("one pane writes NO panes field — the payload is the shape it always was", () => {
    const { state } = buildFilesSession(snapshot());
    expect("panes" in state).toBe(false);
    expect("layout" in state).toBe(false);
    expect("activePane" in state).toBe(false);
  });

  it("two panes write the pair, the arrangement and the front pane, pane 0 in the legacy fields", () => {
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
    // The legacy half describes pane 0, so the oldest reader still sees a
    // complete workspace.
    expect(state.root).toBe("/left");
    expect(state.open).toEqual(["/left/a.ts"]);
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
  it("rejects junk and unknown payload versions", () => {
    expect(normalizeFilesState(null)).toBeNull();
    expect(normalizeFilesState("nonsense")).toBeNull();
    expect(normalizeFilesState({ v: 99, root: "/work" })).toBeNull();
  });

  it("keeps the usable parts of a half-corrupt payload", () => {
    const s = normalizeFilesState({
      v: 1,
      root: "/work",
      expanded: ["/work/src", 7],
      open: ["/work/a.ts", null, "/work/b.ts"],
      active: "/work/gone.ts",
      viewModes: { "/work/a.ts": "source", "/work/gone.ts": "split" },
      showDiff: false,
      drafts: {
        "/work/a.ts": { text: "edit", modified: 12 },
        "/work/b.ts": { text: 5 },
      },
    });
    expect(s).not.toBeNull();
    expect(s!.expanded).toEqual(["/work/src"]);
    expect(s!.open).toEqual(["/work/a.ts", "/work/b.ts"]);
    // The stored active file is not among the open ones: fall back, not crash.
    expect(s!.active).toBe("/work/a.ts");
    expect(s!.viewModes).toEqual({ "/work/a.ts": "source" });
    expect(s!.showDiff).toBe(false);
    expect(s!.drafts).toEqual({ "/work/a.ts": { text: "edit", modified: 12 } });
  });

  it("gives a workspace saved before the panel existed a closed panel", () => {
    // The whole point of not bumping `v` for the new field: this payload is
    // exactly what earlier versions wrote, and it must still restore the
    // files it carries.
    const s = normalizeFilesState({
      v: 1,
      root: "/work",
      expanded: [],
      open: ["/work/a.ts"],
      active: "/work/a.ts",
      viewModes: {},
      showDiff: true,
      drafts: {},
    });
    expect(s).not.toBeNull();
    expect(s!.open).toEqual(["/work/a.ts"]);
    expect(s!.term).toEqual({
      open: false,
      height: PANEL_DEFAULT_PX,
      cwd: "",
    });
  });

  it("brings the panel back as it was left", () => {
    const s = normalizeFilesState({
      v: 1,
      open: [],
      term: { open: true, height: 260, cwd: "/work/src" },
    });
    expect(s!.term).toEqual({ open: true, height: 260, cwd: "/work/src" });
  });

  it("defaults each panel field on its own when it is missing or junk", () => {
    const s = normalizeFilesState({
      v: 1,
      open: [],
      term: { open: "yes", height: "tall", cwd: 7 },
    });
    expect(s!.term).toEqual({
      open: false,
      height: PANEL_DEFAULT_PX,
      cwd: "",
    });
  });

  it("makes a stored height legal rather than trusting the file", () => {
    const s = normalizeFilesState({
      v: 1,
      open: [],
      term: { open: true, height: 4, cwd: "/work" },
    });
    expect(s!.term.height).toBe(PANEL_MIN_PX);
  });

  it("defaults the sort field by field, for a payload without one and for junk", () => {
    // Absent means the default — the reader's contract is `sort ?? DEFAULT_SORT`.
    const before = normalizeFilesState({ v: 1, open: [] });
    expect(before!.sort).toBeUndefined();
    const junk = normalizeFilesState({ v: 1, open: [], sort: { key: "colour" } });
    expect(junk!.sort).toBeUndefined();
    const half = normalizeFilesState({
      v: 1,
      open: [],
      sort: { key: "size", asc: false, dirsFirst: "no" },
    });
    // Half-recognizable keeps the half that parsed.
    expect(half!.sort).toEqual({ key: "size", asc: false, dirsFirst: true });
  });

  it("treats a missing mtime as unknown rather than dropping the draft", () => {
    const s = normalizeFilesState({
      v: 1,
      open: ["/work/a.ts"],
      drafts: { "/work/a.ts": { text: "edit" } },
    });
    expect(s!.drafts["/work/a.ts"]).toEqual({ text: "edit", modified: null });
  });
});

const PRE_DUAL_PAYLOAD = {
  v: 1 as const,
  root: "/work",
  expanded: ["/work/src", "/work/src/deep"],
  open: ["/work/a.ts", "/work/b.md"],
  active: "/work/b.md",
  viewModes: { "/work/b.md": "split" },
  showDiff: false,
  drafts: { "/work/a.ts": { text: "my edit", modified: 4242 } },
  term: { open: true, height: 260, cwd: "/work/src" },
};

describe("storedPanes — the single-pane compatibility rule", () => {
  it("a payload with no panes restores as one pane, field for field", () => {
    const s = normalizeFilesState(PRE_DUAL_PAYLOAD)!;
    expect(s).not.toBeNull();
    expect(s.panes).toBeUndefined();
    const panes = storedPanes(s);
    expect(panes).toHaveLength(1);
    // Field for field, the legacy values come through untouched — this is
    // the "restore = current behavior, field by field" assertion.
    expect(panes[0]).toEqual({
      root: "/work",
      expanded: ["/work/src", "/work/src/deep"],
      open: ["/work/a.ts", "/work/b.md"],
      active: "/work/b.md",
      viewModes: { "/work/b.md": "split" },
      drafts: { "/work/a.ts": { text: "my edit", modified: 4242 } },
      treeModes: {},
      sort: undefined,
    });
  });

  it("a legacy payload that round-trips through a single pane writes back the same shape", () => {
    const s = normalizeFilesState(PRE_DUAL_PAYLOAD)!;
    const one = storedPanes(s);
    // What a restore-then-immediate-save writes: identical to the input it
    // came from (the legacy mirror of pane 0 with nothing added).
    const { state } = buildFilesSession({
      panes: [
        {
          root: one[0].root,
          expanded: one[0].expanded,
          open: [
            file({ path: "/work/a.ts", modified: 4242 }),
            file({ path: "/work/b.md" }),
          ],
          active: one[0].active,
          viewModes: new Map(Object.entries(one[0].viewModes) as [string, "split"][]),
          drafts: new Map([["/work/a.ts", "my edit"]]),
          treeModes: new Map<string, never>(),
          sort: DEFAULT_SORT,
        },
      ],
      layout: "row",
      activePane: 0,
      showDiff: s.showDiff,
      term: s.term,
      panelMode: s.panelMode ?? "tree",
    });
    expect("panes" in state).toBe(false);
    expect(state.root).toBe(PRE_DUAL_PAYLOAD.root);
    expect(state.active).toBe(PRE_DUAL_PAYLOAD.active);
    expect(state.viewModes).toEqual(PRE_DUAL_PAYLOAD.viewModes);
  });

  it("a stored pair restores both panes, and junk in the second falls back to one", () => {
    const dual = normalizeFilesState({
      ...PRE_DUAL_PAYLOAD,
      panes: [
        PRE_DUAL_PAYLOAD,
        {
          root: "/right",
          expanded: [],
          open: ["/right/c.txt"],
          active: "/right/c.txt",
          viewModes: {},
          drafts: {},
          treeModes: { "/right": "miller" },
        },
      ],
      layout: "column",
      activePane: 1,
    })!;
    expect(dual.panes).toHaveLength(2);
    expect(dual.panes![1].root).toBe("/right");
    expect(dual.panes![1].treeModes).toEqual({ "/right": "miller" });
    expect(dual.layout).toBe("column");
    expect(dual.activePane).toBe(1);
    expect(storedPanes(dual)).toHaveLength(2);

    const broken = normalizeFilesState({
      ...PRE_DUAL_PAYLOAD,
      panes: [PRE_DUAL_PAYLOAD, "junk"],
    })!;
    expect(broken.panes).toBeUndefined();
    expect(storedPanes(broken)).toHaveLength(1);
  });
});

const state = (over: Partial<FilesSessionState> = {}): FilesSessionState => ({
  v: 1,
  root: "/work",
  expanded: [],
  open: ["/work/a.ts", "/work/gone.ts", "/work/b.ts"],
  active: "/work/gone.ts",
  viewModes: { "/work/gone.ts": "split", "/work/b.ts": "source" },
  showDiff: true,
  drafts: {},
  term: { open: false, height: PANEL_DEFAULT_PX, cwd: "/work" },
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
  it("is written only when it differs from the tree default", () => {
    const { state } = buildFilesSession(snapshot({ panelMode: "search" }));
    expect(state.panelMode).toBe("search");
    const { state: tree } = buildFilesSession(snapshot({ panelMode: "tree" }));
    // Absent on write means default — byte-identical to a payload from
    // before the field existed.
    expect("panelMode" in tree).toBe(false);
  });

  it("restores through normalize, with absence and junk both meaning tree", () => {
    const saved = normalizeFilesState(
      buildFilesSession(snapshot({ panelMode: "changes" })).state
    );
    expect(saved?.panelMode).toBe("changes");
    expect(normalizeFilesState(null)?.panelMode).toBeUndefined();
    // A payload with no panelMode at all: the reader fills the tree in.
    const legacy = buildFilesSession(snapshot()).state;
    delete (legacy as Partial<FilesSessionState>).panelMode;
    expect(normalizeFilesState(legacy)?.panelMode).toBe("tree");
    const junk = buildFilesSession(snapshot()).state as unknown as Record<
      string,
      unknown
    >;
    junk.panelMode = "sideways";
    expect(normalizeFilesState(junk)?.panelMode).toBe("tree");
  });
});
