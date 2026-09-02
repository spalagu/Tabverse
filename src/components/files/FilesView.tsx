import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fsApi,
  onFsChanged,
  formatSize,
  gitBadge,
  type FileMeta,
  type FsEntry,
} from "../../backend/fs";
import { onAppCommand } from "../../appCommands";
import { keysFor } from "../../shortcuts";
import { filesKeyAction, onLocalKeys } from "../../localKeys";
import { formatKeys, HINT_KEYS } from "../../strings/formatKeys";
import { coreLog } from "../../errlog";
import { loadState, saveState, tabScope } from "../../persist";
import { useStore, type Tab } from "../../state/store";
import {
  buildFilesSession,
  decideDraft,
  mtimeUnchanged,
  normalizeFilesState,
  pruneWorkspace,
  storedPanes,
} from "./session";
import {
  applyPaneAction,
  closedPane,
  conflictResolvedPane,
  modeSetPane,
  navBackPane,
  navForwardPane,
  newPane,
  paneForPath,
  pushNav,
  selectionAll,
  type PaneLayout,
  type PaneState,
  type TreeMode,
} from "./panes";
import { DEFAULT_SORT } from "./sortEntries";
import { dirtyAmong, discardPrompt, relativePath } from "./editorTabs";
import { claimFileCloseKey } from "./fileCloseKey";
import {
  EMPTY_UNDO,
  forwardFor,
  planUndo,
  popRedo,
  popUndo,
  recordOp,
  settleRedo,
  settleUndo,
  type UndoEntry,
  type UndoState,
} from "./undoStack";
import { PANEL_DEFAULT_PX, clampPanelHeight } from "./termSync";
import { TerminalPanel } from "./TerminalPanel";
import { confirmAsk } from "../Confirm";
import { disposeEditorState, openEditorFind } from "./CodeEditor";
import { SearchPanel } from "./SearchPanel";
import { FileTree } from "./FileTree";
import { MillerView } from "./MillerView";
import { LocBar } from "./LocBar";
import { recordRecentPath } from "./recentPaths";
import { describeError, type ErrorDescription } from "../../strings/errors";
import { STR } from "../../strings";
import {
  FilesWorkspacePane,
  describeFilesWorkspacePane,
} from "./FilesWorkspacePane";
import { FileQuickOpen } from "@tabverse/workbench/files/quick-open";
import { FilesWorkspaceLayout } from "@tabverse/workbench/files/workspace-layout";
import { FilesWorkspace } from "@tabverse/workbench/files/workspace";
import { type FilesPanelMode } from "@tabverse/workbench/files/sidebar-controls";
import {
  ChangesPanel,
  type FileChangeList,
} from "@tabverse/workbench/files/changes-panel";

interface Props {
  tab: Tab;
  active: boolean;
}

/** The folder a path sits in, for rooting a tab at the file it was handed. */
function parentDir(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

const walkQuickOpen = async (root: string, showHidden: boolean) =>
  (await fsApi.walk(root, showHidden)).paths;

const loadFileChanges = async (root: string): Promise<FileChangeList> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FileChangeList>("fs_changes", { root });
};

export function reconcileDiskState(
  panes: readonly PaneState[],
  fresh: ReadonlyMap<string, FileMeta | null>
): { panes: PaneState[]; missing: Set<string> } {
  const missing = new Set<string>();
  const next = panes.map((p) => {
    let pane = p;
    for (const f of p.open) {
      const now = fresh.get(f.path);
      // Not re-read this round (not a draft, not selected, not previously
      // missing): no verdict to apply.
      if (now === undefined) continue;
      if (now === null) {
        missing.add(f.path);
        continue;
      }
      if (!pane.drafts.has(f.path)) continue;
      if (mtimeUnchanged(f.modified, now.modified)) continue;
      pane = {
        ...pane,
        open: pane.open.map((o) => (o.path === f.path ? now : o)),
        conflicts: new Set(pane.conflicts).add(f.path),
      };
    }
    return pane;
  });
  return { panes: next, missing };
}

export function FilesView({ tab, active }: Props) {
  const [panes, setPanes] = useState<PaneState[]>(() => [
    newPane(tab.cwd ?? (tab.openPath ? parentDir(tab.openPath) : "")),
  ]);
  const [activePane, setActivePane] = useState(0);
  // Round twelve: the sort wall collapsed into one chip + popover.
  const [layout, setLayout] = useState<PaneLayout>("row");
  const [showDiff, setShowDiff] = useState(true);
  const [branch, setBranch] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | ErrorDescription | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHidden, setShowHidden] = useState(
    () => localStorage.getItem("tabverse.showHidden") === "1"
  );
  const [locOpen, setLocOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<FilesPanelMode>("tree");
  // Where a search result wants the editor to land, cleared once used so
  // re-opening the same file later does not jump again.
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const previewBody = useRef<HTMLDivElement>(null);
  const showingPreviewNow = useRef(false);
  // Nothing is written back until the stored workspace has been read, or the
  // empty first render would overwrite the session it is about to restore.
  const [restored, setRestored] = useState(false);
  const [compares, setCompares] = useState<
    ({ a: string; b: FileMeta } | null)[]
  >([]);
  const [comparePick, setComparePick] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(PANEL_DEFAULT_PX);
  // Where the panel's shell is. Normally the active pane's directory — that
  // is the whole point of the sync — and stored separately because the shell
  // has to come back somewhere even when the stored root no longer lists.
  const [termCwd, setTermCwd] = useState("");
  // The tab directory already handed to the panel, so restoring a stored
  // panel directory is not immediately overwritten by the root it came with.
  const pushedRoot = useRef<string | null>(null);

  // The latest panes/pointer for callbacks that must not close over a
  // stale render (routing a reveal, the root-change funnel).
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const activeRef = useRef(activePane);
  activeRef.current = activePane;
  // The missing-set twin of panesRef, for the same reason: the recheck
  // builds its read list after awaits and must see the latest set.
  const missingRef = useRef(missing);
  missingRef.current = missing;
  // The compares twin: the ⌘W claim reads them inside a callback that must
  // not close over a stale render.
  const comparesRef = useRef(compares);
  comparesRef.current = compares;

  const setTabTitle = useStore((s) => s.setTabTitle);
  // The header's git chip carries a theme color; repaint it on a switch.
  const resolvedTheme = useStore((s) => s.resolvedTheme);
  const scope = useMemo(() => tabScope("files", tab.id), [tab.id]);

  const pane = panes[Math.min(activePane, panes.length - 1)];
  const { root, activePath } = pane;
  // The live open-file fact the app-share mirror reads (the store's
  // filesOpenPath, keyed by this tab's id): synced from the ACTIVE PANE's
  // state rather than any one call site, so every way a file comes to
  // front — a tree click, a reveal, the workspace restore on remount —
  // reports the same truth. Null (no file, a folder view) clears it.
  // The pane's ROOT rides the same stroke: it is the live directory the
  // joiner's folder view lists, where tab.cwd is only the spawn hint.
  useEffect(() => {
    useStore.getState().setFilesOpenPath(tab.id, activePath);
  }, [tab.id, activePath]);
  useEffect(() => {
    useStore.getState().setFilesOpenDir(tab.id, root);
  }, [tab.id, root]);
  const treeMode = pane.treeModes.get(root) ?? "tree";
  const isDirty = useCallback(
    (f: FileMeta) => {
      const d = pane.drafts.get(f.path);
      return d !== undefined && d !== (f.text ?? "");
    },
    [pane.drafts]
  );

  /** Rewrite one pane; the others are carried through untouched. */
  const updatePane = useCallback(
    (idx: number, fn: (p: PaneState) => PaneState) => {
      setPanes((prev) => {
        if (idx < 0 || idx >= prev.length) return prev;
        const next = prev.slice();
        next[idx] = fn(prev[idx]);
        return next;
      });
    },
    []
  );

  const setPaneRoot = useCallback(
    (idx: number, dir: string) => {
      const prevRoot = panesRef.current[idx]?.root ?? "";
      updatePane(idx, (p) => (p.root === dir ? p : { ...p, root: dir }));
      if (!prevRoot || prevRoot === dir) return;
      void fsApi.list(dir).then(
        () => updatePane(idx, (p) => pushNav(p, prevRoot)),
        () => {}
      );
    },
    [updatePane]
  );
  const setRoot = useCallback(
    (dir: string) => setPaneRoot(activeRef.current, dir),
    [setPaneRoot]
  );

  const navMove = useCallback(
    (idx: number, dir: -1 | 1) => {
      const p = panesRef.current[idx];
      if (!p) return;
      const step = dir === -1 ? navBackPane(p) : navForwardPane(p);
      if (!step) return;
      updatePane(idx, () => step.pane);
    },
    [updatePane]
  );

  useEffect(() => {
    useStore
      .getState()
      .setTabDirty(tab.id, panes.some((p) => p.open.some(isDirty)));
  }, [tab.id, panes, isDirty]);

  // Home is the fallback, not the default: it must not race the stored root
  // and make the tree load a directory the user left long ago. An answer
  // that is not a usable directory is ignored rather than written — writing
  // it would clear the root again and re-arm this effect forever.
  useEffect(() => {
    if (!restored) return;
    for (let i = 0; i < panes.length; i++) {
      if (panes[i].root) continue;
      void fsApi.home().then((home) => {
        if (typeof home === "string" && home) setPaneRoot(i, home);
      });
    }
  }, [restored, panes, setPaneRoot]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = normalizeFilesState(await loadState<unknown>(scope));
      if (!alive) return;
      if (!saved) {
        setRestored(true);
        return;
      }
      setShowDiff(saved.showDiff);
      setPanelMode(saved.panelMode ?? "tree");
      // Every pane restores on its own and drops on its own: between two
      // runs directories are renamed and files move, and a session where
      // half the paths are gone must still open with the half that
      // survived — silently, never as a wall of errors. A payload with no
      // `panes` is one pane here, parsed by the same reader a stored pair
      // uses, so the legacy shape restores field for field.
      const stored = storedPanes(saved);
      const live = new Map<string, FileMeta>();
      await Promise.all(
        stored.flatMap((sp) =>
          sp.open.map((p) =>
            fsApi.read(p).then(
              (m) => {
                live.set(m.path, m);
              },
              () => {}
            )
          )
        )
      );
      if (!alive) return;
      const restoredPanes = await Promise.all(
        stored.map(async (sp) => {
          // The root is proven by listing it; a root that vanished leaves
          // the pane on its own default rather than on a directory that is
          // not there.
          const savedRoot = sp.root
            ? await fsApi.list(sp.root).then(
                () => sp.root,
                () => ""
              )
            : "";
          const plan = pruneWorkspace(sp, new Set(live.keys()));
          const drafts = new Map<string, string>();
          const disputed = new Set<string>();
          for (const [path, draft] of Object.entries(sp.drafts)) {
            const outcome = decideDraft(path, draft, live.get(path) ?? null);
            if (outcome.kind === "drop") continue;
            drafts.set(path, outcome.text);
            if (outcome.kind === "conflict") disputed.add(path);
          }
          return {
            ...newPane(savedRoot),
            open: plan.open.map((p) => live.get(p)!),
            activePath: plan.active,
            viewModes: plan.viewModes,
            drafts,
            treeModes: new Map(
              Object.entries(sp.treeModes) as [string, TreeMode][]
            ),
            sort: sp.sort ?? DEFAULT_SORT,
            conflicts: disputed,
          };
        })
      );
      if (!alive) return;
      // Restores write state directly, never through the root funnel: the
      // place a tab comes back from is where it started, not something to
      // go "back" to.
      setPanes(restoredPanes);
      if (saved.panes && saved.activePane === 1 && restoredPanes[1]) {
        setActivePane(1);
      }
      if (saved.panes) setLayout(saved.layout ?? "row");
      setTermOpen(saved.term.open);
      setTermHeight(saved.term.height);
      // Claimed before the root effect can run, so the panel comes back in
      // the directory it was in rather than being cd'd on sight.
      pushedRoot.current = restoredPanes[0]?.root ?? null;
      setTermCwd(saved.term.cwd || restoredPanes[0]?.root || "");
      setRestored(true);
    })();
    return () => {
      alive = false;
    };
  }, [scope]);

  /** Paths already reported as too big to store, so the log says it once. */
  const loggedSkips = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!restored) return;
    const { state, skippedDrafts } = buildFilesSession({
      panes: panes.map((p) => ({
        root: p.root,
        expanded: p.expanded,
        open: p.open,
        active: p.activePath,
        viewModes: p.viewModes,
        drafts: p.drafts,
        treeModes: p.treeModes,
        sort: p.sort,
      })),
      layout,
      activePane,
      showDiff,
      term: { open: termOpen, height: termHeight, cwd: termCwd || pane.root },
      panelMode,
    });
    saveState(scope, state);
    for (const path of skippedDrafts) {
      if (loggedSkips.current.has(path)) continue;
      loggedSkips.current.add(path);
      coreLog(
        "warn",
        `draft too large to store, it will not survive a restart: ${path}`
      );
    }
  }, [
    restored,
    scope,
    panes,
    layout,
    activePane,
    showDiff,
    termOpen,
    termHeight,
    termCwd,
    pane.root,
    panelMode,
  ]);

  useEffect(() => {
    if (!root) return;
    const short = root.split("/").filter(Boolean).pop() ?? root;
    setTabTitle(tab.id, short);
  }, [root, tab.id, setTabTitle]);

  useEffect(() => {
    if (!root || !restored) return;
    if (pushedRoot.current === root) return;
    pushedRoot.current = root;
    setTermCwd(root);
  }, [root, restored]);


  /**
   * What one merged window does beyond the token bump: re-read the files
   * whose disk state is worth knowing — every drafted file (a changed
   * mtime under a draft is a dispute to surface, not a fact to overwrite
   * with), each pane's selected file (the missing mark's subject), and
   * files already marked (so one that comes back loses the mark).
   */
  const recheckDiskState = useCallback(async () => {
    const targets = new Set<string>();
    for (const p of panesRef.current) {
      for (const path of p.drafts.keys()) targets.add(path);
      if (p.activePath) targets.add(p.activePath);
      for (const path of missingRef.current) {
        if (p.open.some((f) => f.path === path)) targets.add(path);
      }
    }
    if (targets.size === 0) return;
    const fresh = new Map<string, FileMeta | null>();
    await Promise.all(
      [...targets].map(async (path) => {
        try {
          fresh.set(path, await fsApi.read(path));
        } catch {
          fresh.set(path, null);
        }
      })
    );
    const out = reconcileDiskState(panesRef.current, fresh);
    setPanes(out.panes);
    setMissing(out.missing);
  }, []);

  // Arm the watcher at the root being shown (the ACTIVE pane's — the one
  // tree that exists follows the front window, and a pane switched to
  // re-lists on activation anyway). Re-arming replaces server-side, so
  // every root change is a stop+start, and an unwatchable root is a
  // logged degradation, not an error banner: the tab still works, minus
  // the refresh nobody promised on a directory it cannot watch.
  useEffect(() => {
    if (!restored || !root) return;
    void fsApi.watchTab(tab.id, root).catch((e) => {
      coreLog("warn", `directory watcher failed to arm for ${root}: ${e}`);
    });
  }, [restored, tab.id, root]);

  // Release on unmount: a dormant tab unmounts this view (that is what
  // dormant means), and so does a closed one. Watching on with nobody to
  // refresh would be a leak with a fan attached.
  useEffect(
    () => () => {
      void fsApi.unwatchTab(tab.id).catch(() => {});
    },
    [tab.id]
  );

  const watchWindow = useRef<number | null>(null);
  useEffect(() => {
    const off = onFsChanged((tabId) => {
      if (tabId !== tab.id) return;
      if (watchWindow.current !== null) return; // inside a window: merged
      watchWindow.current = window.setTimeout(() => {
        watchWindow.current = null;
        void recheckDiskState();
        setRefreshToken((n) => n + 1);
      }, 300);
    });
    return () => {
      off();
      if (watchWindow.current !== null) {
        window.clearTimeout(watchWindow.current);
        watchWindow.current = null;
      }
    };
  }, [tab.id, recheckDiskState]);

  const openPath = useCallback(
    async (path: string, focusPane = true) => {
      const target = paneForPath(panesRef.current, path, activeRef.current);
      if (focusPane) setActivePane(target);
      try {
        const meta = await fsApi.read(path);
        setPanes((prev) => {
          const at = Math.min(target, prev.length - 1);
          return applyPaneAction(prev, at, { kind: "open", meta, pane: at });
        });
        setError(null);
        // It read, so it exists: whatever the last recheck thought about
        // this path, the missing mark is stale now.
        setMissing((prev) =>
          prev.has(path)
            ? new Set([...prev].filter((p) => p !== path))
            : prev
        );
      } catch (e) {
        setError(describeError(e, STR.errors.actions.openFile));
      }
    },
    []
  );

  /**
   * The file the system asked for, opened once.
   *
   * Waits for the workspace restore because a brand-new tab still runs it, and
   * opening before it finishes would have the restore's own setOpen replace
   * this file a moment later — the tab would land on the folder and the user
   * would see their double-click do nothing.
   */
  // A tool call the user clicked. Unlike `openPath` this fires again for the
  // same file, which is the normal case: automation references one file many
  // times over a run, and each click has to land.
  const lastReveal = useRef(0);
  useEffect(() => {
    const reveal = tab.reveal;
    if (!restored || !reveal || reveal.nonce === lastReveal.current) return;
    lastReveal.current = reveal.nonce;
    void openPath(reveal.path);
    setRevealLine(reveal.line ?? null);
  }, [restored, tab.reveal, openPath]);

  const handedOver = useRef(false);
  useEffect(() => {
    if (!restored || handedOver.current || !tab.openPath) return;
    handedOver.current = true;
    void openPath(tab.openPath);
  }, [restored, tab.openPath, openPath]);

  const openEntry = useCallback(
    async (entry: FsEntry) => {
      if (!entry.isDir) await openPath(entry.path, false);
    },
    [openPath]
  );

  /**
   * Drop tabs, asking nothing, from ONE pane. Whether anything unsaved is
   * being thrown away is settled before this runs, so a caller told "no"
   * simply never calls it — which is what makes cancelling leave the strip
   * exactly as it was.
   */
  const applyClose = useCallback(
    (paths: readonly string[], idx: number) => {
      if (paths.length === 0) return;
      for (const p of paths) disposeEditorState(p);
      updatePane(idx, (p) => closedPane(p, paths));
      // The mark outlives nothing it describes: a closed file has no row
      // to carry it, and the set must not become a ledger of past paths.
      const gone = new Set(paths);
      setMissing((prev) => {
        const next = new Set([...prev].filter((p) => !gone.has(p)));
        return next.size === prev.size ? prev : next;
      });
    },
    [updatePane]
  );

  /**
   * Close a set of tabs — one, or everything the tab menu picked out.
   *
   * The files carrying unsaved work are named in a single question, because
   * the answer to "3 files have unsaved changes" is to cancel and close them
   * one at a time, which is the work the menu exists to save. Cancelling
   * closes nothing at all: a half-applied "close all" would leave a strip
   * nobody asked for and drafts nobody can account for.
   */
  const closeTabs = useCallback(
    // Asking is asynchronous now that the app asks with its own dialog, so
    // this is too — the close happens after the answer, not before it.
    async (paths: readonly string[], idx: number) => {
      if (paths.length === 0) return;
      const target = panesRef.current[Math.min(idx, panesRef.current.length - 1)];
      const byPath = new Map(target.open.map((f) => [f.path, f]));
      const dirty = (p: string) => {
        const f = byPath.get(p);
        return !!f && target.drafts.get(p) !== undefined && target.drafts.get(p) !== (f.text ?? "");
      };
      const atRisk = dirtyAmong(paths, dirty);
      if (atRisk.length > 0) {
        const names = atRisk.map((p) => relativePath(target.root, p));
        if (!(await confirmAsk(discardPrompt(names), { confirmLabel: "Discard" })))
          return;
      }
      applyClose(paths, idx);
    },
    [applyClose]
  );

  const closeFile = useCallback(
    (path: string, idx: number) => closeTabs([path], idx),
    [closeTabs]
  );

  const save = useCallback(
    async (target?: FileMeta) => {
      const idx = Math.min(activeRef.current, panesRef.current.length - 1);
      const selected = target ?? panesRef.current[idx]?.open.find(
        (f) => f.path === panesRef.current[idx]?.activePath
      );
      if (!selected) return;
      const pane = panesRef.current[idx];
      const current = pane.drafts.get(selected.path);
      if (current === undefined) return;
      if (selected.readOnlyReason) {
        setError(`Not saved — ${selected.readOnlyReason}.`);
        return;
      }
      setSaving(true);
      try {
        await fsApi.write(selected.path, current);
        const fresh = await fsApi.read(selected.path);
        // Settled through the pane dispatcher, so the save lands on the pane
        // the file was opened in — the active one, because save answers the
        // window in front. Keystrokes that landed while the write was in
        // flight are a NEW draft; deleting it made the dirty dot lie and the
        // next ⌘S a no-op until another keystroke re-dirtied the file.
        setPanes((prev) =>
          applyPaneAction(prev, Math.min(idx, prev.length - 1), {
            kind: "save",
            path: selected.path,
            fresh,
            racedDraft:
              panesRef.current[idx]?.drafts.get(selected.path) !== current
                ? (panesRef.current[idx]?.drafts.get(selected.path) ?? null)
                : null,
          })
        );
        setError(null);
        setRefreshToken((n) => n + 1);
      } catch (e) {
        setError(describeError(e, STR.errors.actions.saveFile));
      } finally {
        setSaving(false);
      }
    },
    []
  );

  /**
   * Answer to the conflict banner. Keeping the draft only dismisses the
   * banner — the file on disk is left exactly as the other writer left it
   * until an explicit save. Discarding drops the editor's cached model too,
   * because it still holds the draft text and outlives the widget.
   */
  const resolveConflict = useCallback(
    (path: string, keepDraft: boolean, idx = activeRef.current) => {
      if (!keepDraft) disposeEditorState(path);
      updatePane(idx, (p) =>
        conflictResolvedPane(p, path, keepDraft)
      );
    },
    [updatePane]
  );

  const openCompare = useCallback(async (aPath: string, bPath: string) => {
    try {
      const [a, b] = await Promise.all([fsApi.read(aPath), fsApi.read(bPath)]);
      if (a.kind !== "text" || b.kind !== "text") {
        setError(STR.files.view.compareTextOnly);
        return;
      }
      const target = paneForPath(panesRef.current, aPath, activeRef.current);
      setActivePane(target);
      setPanes((prev) => {
        const at = Math.min(target, prev.length - 1);
        // Open A first (it becomes active), then hand the strip to the
        // comparison — one pass, so no intermediate render flickers A in.
        const opened = applyPaneAction(prev, at, {
          kind: "open",
          meta: a,
          pane: at,
        });
        return opened.map((p, i) =>
          i === at ? { ...p, activePath: null } : p
        );
      });
      setCompares((prev) => {
        const next = prev.slice();
        while (next.length <= target) next.push(null);
        next[target] = { a: aPath, b };
        return next;
      });
      setError(null);
    } catch (e) {
      setError(describeError(e, STR.errors.actions.openFile));
    }
  }, []);

  /**
   * Close a pane's comparison. The strip's last file takes the front — a
   * closed comparison should not strand the pane on its placeholder.
   */
  const closeCompare = useCallback(
    (idx: number) => {
      setCompares((prev) => {
        if (idx >= prev.length) return prev;
        const next = prev.slice();
        next[idx] = null;
        return next;
      });
      updatePane(idx, (p) =>
        p.activePath === null
          ? { ...p, activePath: p.open[p.open.length - 1]?.path ?? null }
          : p
      );
    },
    [updatePane]
  );

  const undoRef = useRef<UndoState>(EMPTY_UNDO);
  /** One inverse at a time: a second ⌘Z mid-flight must not interleave. */
  const undoBusy = useRef(false);
  const recordUndo = useCallback((entry: UndoEntry) => {
    undoRef.current = recordOp(undoRef.current, entry);
  }, []);

  const [packing, setPacking] = useState<string | null>(null);
  const compressSelection = useCallback(
    (paths: string[], destDir: string, format: "zip" | "tgz") => {
      setPacking(
        STR.files.tree.packing({
          n: paths.length,
          format: format === "zip" ? "zip" : ".tgz",
        })
      );
      void (async () => {
        try {
          const landed = await fsApi.compress(paths, destDir, format);
          recordUndo({ kind: "create", path: landed, dir: false });
          setError(null);
          setRefreshToken((n) => n + 1);
        } catch (e) {
          setError(describeError(e, STR.errors.actions.compressItems));
        } finally {
          setPacking(null);
        }
      })();
    },
    [recordUndo]
  );

  /**
   * One step of ⌘Z: take the newest entry, run its inverse (a transfer
   * into a directory, or a trash — never a bare rename), and leave the
   * forward op for redo. The two refused inverses are CONSUMED with the
   * honest sentence rather than skipped: the stack records trash and
   * overwrite steps precisely so the key can say what it cannot do.
   */
  const stepUndo = useCallback(async () => {
    if (undoBusy.current) return;
    const top = popUndo(undoRef.current);
    if (!top) return;
    undoRef.current = top.state;
    const plan = planUndo(top.entry);
    if (plan.undo === "none") {
      setError(
        plan.why === "trash"
          ? STR.files.tree.undoTrashHonest({ path: plan.path })
          : STR.files.tree.undoReplaceHonest({ path: plan.path })
      );
      return;
    }
    undoBusy.current = true;
    try {
      let inverseLanding: string | null = null;
      if (plan.undo === "trash") {
        await fsApi.trash(plan.path);
      } else {
        inverseLanding = await fsApi.transfer(plan.from, plan.into, true);
      }
      undoRef.current = settleUndo(undoRef.current, forwardFor(top.entry, inverseLanding));
      setError(null);
      setRefreshToken((n) => n + 1);
    } catch (e) {
      // The inverse did not happen, so the step is not spent. Pushed
      // straight back rather than through recordOp — an undo that failed
      // must not also wipe the redo branch.
      undoRef.current = {
        ...undoRef.current,
        undo: [...undoRef.current.undo, top.entry],
      };
      setError(describeError(e, STR.errors.actions.applyFileChange));
    } finally {
      undoBusy.current = false;
    }
  }, []);

  /**
   * One step of ⇧⌘Z: replay the most recently undone operation, with its
   * FRESH landing recorded (free_name may have yielded again).
   */
  const stepRedo = useCallback(async () => {
    if (undoBusy.current) return;
    const top = popRedo(undoRef.current);
    if (!top) return;
    undoRef.current = top.state;
    undoBusy.current = true;
    try {
      if (top.op.op === "create") {
        await fsApi.create(top.op.path, top.op.dir);
        undoRef.current = settleRedo(undoRef.current, {
          kind: "create",
          path: top.op.path,
          dir: top.op.dir,
        });
      } else {
        const landed = await fsApi.transfer(top.op.from, top.op.into, top.op.cut);
        undoRef.current = settleRedo(undoRef.current, {
          kind: "transfer",
          cut: top.op.cut,
          src: top.op.from,
          landed,
        });
      }
      setError(null);
      setRefreshToken((n) => n + 1);
    } catch (e) {
      // Same rule as undo: a redo that did not happen is not a step lost.
      undoRef.current = settleUndo(undoRef.current, top.op);
      setError(describeError(e, STR.errors.actions.applyFileChange));
    } finally {
      undoBusy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    return onLocalKeys(filesKeyAction, (action, e) => {
      switch (action.command) {
        case "find":
          if (showingPreviewNow.current) {
            e.preventDefault();
            setFindOpen(true);
            return;
          }
          if (openEditorFind(action.replace)) e.preventDefault();
          return;
        case "quick-open":
          e.preventDefault();
          e.stopPropagation();
          setQuickOpen(true);
          return;
        case "save-file":
          e.preventDefault();
          e.stopPropagation();
          void save();
          return;
        case "terminal-panel":
          e.preventDefault();
          e.stopPropagation();
          setTermOpen((v) => !v);
          return;
        case "undo":
        case "redo": {
          const t = e.target;
          if (
            t instanceof HTMLElement &&
            (t.tagName === "INPUT" ||
              t.tagName === "TEXTAREA" ||
              t.isContentEditable ||
              t.closest(".monaco-editor") !== null)
          ) {
            return;
          }
          e.preventDefault();
          void (action.command === "undo" ? stepUndo() : stepRedo());
          return;
        }
      }
    });
  }, [active, save, stepUndo, stepRedo]);

  useEffect(() => {
    if (!active) return;
    return claimFileCloseKey(() => {
      // An empty strip is the only thing that lets the key through, so no
      // combination of state can spend one ⌘W on a tab that still holds
      // open files. The strip in question is the ACTIVE pane's: the key
      // answers the window in front, exactly like the other local keys.
      const at = activeRef.current;
      const strip = panesRef.current[Math.min(at, panesRef.current.length - 1)];
      if (strip.activePath === null && comparesRef.current[at]) {
        closeCompare(at);
        return true;
      }
      if (strip.open.length === 0) return false;
      closeFile(strip.activePath ?? strip.open[strip.open.length - 1].path, at);
      return true;
    });
  }, [active, panes, closeFile, closeCompare]);

  useEffect(() => {
    if (!active) return;
    return onAppCommand((cmd) => {
      if (cmd === "location-bar") {
        setLocOpen((v) => !v);
        return;
      }
      const at = Math.min(activeRef.current, panesRef.current.length - 1);
      if (cmd === "back") navMove(at, -1);
      else if (cmd === "forward") navMove(at, 1);
    });
  }, [active, navMove]);

  if (!fsApi.available) {
    return (
      <div className="placeholder">
        <div className="placeholder-title">{STR.files.demoTitle}</div>
        <div className="placeholder-blurb">{STR.files.demoBlurb}</div>
      </div>
    );
  }

  const act = describeFilesWorkspacePane(pane);
  // Updated on every render, unlike the handler that reads it.
  showingPreviewNow.current =
    !act.inSource &&
    (act.showRendered ||
      act.showInspect ||
      (!!act.sel && act.sel.kind !== "text"));
  const setMode = (mode: string, idx: number) => {
    updatePane(idx, (p) => {
      const path = p.activePath;
      return path ? modeSetPane(p, path, mode) : p;
    });
  };

  useEffect(() => {
    if (!active || panes.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return; // modifiers exclude a shortcut chord; bare Tab accepts the completion
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setActivePane((i) => (i + 1) % 2);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, panes.length]);

  /** Enter dual-pane mode beside the current one; leave it, keeping the front. */
  const setDual = (on: boolean) => {
    if (on) {
      // The new window copies the current root — two views of the same
      // place to start from, which is where diverging navigation begins.
      // The front pane does not change: opening a second window is not a
      // reason to yank the user's focus out of the one they are in.
      setPanes((prev) =>
        prev.length === 2 ? prev : [...prev, newPane(prev[0]?.root ?? "")]
      );
    } else {
      setPanes((prev) => (prev.length === 1 ? prev : [prev[activeRef.current]]));
      setActivePane(0);
    }
  };

  const renderPane = (i: number) => {
    const current = panes[i];
    return (
      <FilesWorkspacePane
        key={i}
        pane={current}
        active={i === activePane}
        missing={missing}
        comparison={compares[i] ?? null}
        restored={restored}
        error={error}
        saving={saving}
        showDiff={showDiff}
        findOpen={findOpen}
        revealLine={revealLine}
        terminalOpen={termOpen}
        containerRef={previewBody}
        keyHints={{
          save: formatKeys(keysFor("save-file")),
          quickOpen: formatKeys(keysFor("quick-open")),
          locationBar: formatKeys(keysFor("location-bar")),
          terminalPanel: formatKeys(keysFor("terminal-panel")),
        }}
        formatSize={formatSize}
        badgeFor={(file) =>
          file.git ? gitBadge(file.git, resolvedTheme) : null
        }
        onActivate={() => setActivePane(i)}
        onPaneChange={(change) => updatePane(i, change)}
        onCloseFile={(path) => {
          void closeFile(path, i);
        }}
        onCloseTabs={(paths) => {
          void closeTabs(paths, i);
        }}
        onCompareWith={(path) => setComparePick(path)}
        onCloseCompare={() => closeCompare(i)}
        onSave={(file) => {
          void save(file);
        }}
        onResolveConflict={(path, keepDraft) =>
          resolveConflict(path, keepDraft, i)
        }
        onModeChange={(mode) => setMode(mode, i)}
        onShowDiffChange={setShowDiff}
        onTerminalOpenChange={setTermOpen}
        onErrorChange={setError}
        onFindOpenChange={setFindOpen}
        onReveal={(path) => {
          void fsApi.reveal(path);
        }}
        onOpenHtmlInBrowser={(path) =>
          useStore.getState().addTab({
            type: "browser",
            url: fsApi.url(path),
          })
        }
      />
    );
  };

  return (
    <FilesWorkspace
      overlays={[
        locOpen ? (
          <LocBar
            root={root}
            onClose={() => setLocOpen(false)}
            onSubmit={(resolved) => {
              setRoot(resolved);
              void fsApi.list(resolved).then(
                () => recordRecentPath(resolved),
                () => {}
              );
            }}
          />
        ) : null,
        quickOpen ? (
          <FileQuickOpen
            walk={walkQuickOpen}
            showHidden={showHidden}
            root={root}
            onPick={(rel) => {
              setQuickOpen(false);
              void openPath(`${root.replace(/\/$/, "")}/${rel}`);
            }}
            onClose={() => setQuickOpen(false)}
          />
        ) : null,
        comparePick !== null ? (
          <FileQuickOpen
            walk={walkQuickOpen}
            showHidden={showHidden}
            root={root}
            placeholder={STR.files.view.comparePickerPlaceholder}
            onPick={(rel) => {
              const b = `${root.replace(/\/$/, "")}/${rel}`;
              const a = comparePick;
              setComparePick(null);
              void openCompare(a, b);
            }}
            onClose={() => setComparePick(null)}
          />
        ) : null,
      ]}
      sidebar={{
        panelMode,
        treeMode,
        header: {
          root,
          canGoBack: pane.nav.back.length > 0,
          canGoForward: pane.nav.fwd.length > 0,
          parentLabel: HINT_KEYS.up,
          onBack: () => navMove(activePane, -1),
          onForward: () => navMove(activePane, 1),
          onParent: () => setRoot(root.replace(/\/[^/]*$/, "") || "/"),
          onPanelModeChange: setPanelMode,
        },
        toolbar: {
          sort: pane.sort,
          dual: panes.length === 2,
          layout,
          ascendingLabel: HINT_KEYS.up,
          descendingLabel: HINT_KEYS.down,
          onSortChange: (sort) =>
            updatePane(activePane, (current) => ({ ...current, sort })),
          onTreeModeChange: (mode) =>
            updatePane(activePane, (current) => ({
              ...current,
              treeModes: new Map(current.treeModes).set(current.root, mode),
            })),
          onDualChange: setDual,
          onLayoutChange: setLayout,
        },
        searchPanel: (
          <SearchPanel
            root={root}
            includeHidden={showHidden}
            onOpen={(path, line) => {
              setRevealLine(line);
              void openPath(path);
            }}
            onSelectPaths={(relPaths) => {
              const base = root.replace(/\/$/, "");
              const abs = relPaths.map((relative) => `${base}/${relative}`);
              updatePane(activePane, (current) => selectionAll(current, abs));
              setPanelMode("tree");
            }}
          />
        ),
        changesPanel: (
          <ChangesPanel
            root={root}
            refreshToken={refreshToken}
            selected={activePath}
            loadChanges={loadFileChanges}
            onOpen={(path) => void openPath(path)}
          />
        ),
        columnsView: (
          <MillerView
            root={root}
            selected={activePath}
            onSelect={(entry) => void openEntry(entry)}
            onRootChange={setRoot}
            refreshToken={refreshToken}
            onBranch={setBranch}
            showHidden={showHidden}
            sort={pane.sort}
          />
        ),
        treeView: (
          <FileTree
            root={root}
            selected={activePath}
            onSelect={(entry) => void openEntry(entry)}
            onRootChange={setRoot}
            refreshToken={refreshToken}
            onBranch={setBranch}
            showHidden={showHidden}
            onMutate={() => setRefreshToken((current) => current + 1)}
            expanded={pane.expanded}
            setExpanded={(updater) =>
              updatePane(activePane, (current) => ({
                ...current,
                expanded:
                  typeof updater === "function"
                    ? updater(current.expanded)
                    : updater,
              }))
            }
            sort={pane.sort}
            selectedPaths={pane.selectedPaths}
            applySelection={(action) =>
              updatePane(activePane, (current) => action(current))
            }
            recordUndo={recordUndo}
            onCompress={compressSelection}
            onCompare={(paths) => void openCompare(paths[0], paths[1])}
          />
        ),
      }}
      main={<FilesWorkspaceLayout
        paneViews={panes.map((_, i) => renderPane(i))}
        layout={layout}
        packing={packing}
        terminalPanel={
          <TerminalPanel
            cwd={termCwd || pane.root}
            visible={termOpen}
            height={termHeight}
            onCwdChange={(dir) => {
              pushedRoot.current = dir;
              setTermCwd(dir);
              setPaneRoot(activeRef.current, dir);
            }}
            onHeightChange={(px) => setTermHeight(clampPanelHeight(px))}
            onClose={() => setTermOpen(false)}
          />
        }
        pathBar={{
          paneCount: panes.length,
          activePane,
          root,
          branch,
          showHidden,
          onActivePaneChange: setActivePane,
          onRootChange: setRoot,
          onShowHiddenChange: (next) => {
            localStorage.setItem("tabverse.showHidden", next ? "1" : "0");
            setShowHidden(next);
          },
        }}
      />}
    />
  );
}
