import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";
import { LoadingState } from "../state/LoadingState";
import { sortEntries, type SortSpec } from "./sortEntries";
import {
  selectionAll,
  selectionCleared,
  selectionExtended,
  selectionLanded,
  selectionToggled,
  type FileSelectionState,
} from "./fileSelection";
import {
  NO_FILTER,
  filterActive,
  filterRows,
  type FilterKind,
  type TreeFilter,
} from "./treeFilter";
import type { UndoEntry } from "./undoStack";
import type { FileEntry, FileGitStatus, FileListing } from "./FileEntry";

const DRAG_MIME = "text/tabverse-paths";

/** A payload's paths, or nothing — never a throw, never a non-string. */
function parseDragPaths(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((p) => typeof p === "string")
      ? (v as string[])
      : [];
  } catch {
    return [];
  }
}

/**
 * Whether a drop into `dir` would be a move into itself or its own subtree.
 * The backend rejects exactly this (`dir.starts_with(&src)`), so the drag
 * answers it at dragover — the row says "not here" instead of the drop
 * failing after the user let go.
 */
function blocksDrop(dir: string, paths: readonly string[]): boolean {
  return paths.some((p) => dir === p || dir.startsWith(`${p}/`));
}

/** Context-menu state: which entry, where, and which inline input is open. */
interface TreeMenu {
  entry: FileEntry | null; // null = the root background
  x: number;
  y: number;
  input: "file" | "folder" | "rename" | null;
}

export interface FileTreeClipboard {
  path: string;
  paths?: string[];
  cut: boolean;
}

export interface FileTreeRuntime {
  list: (dir: string) => Promise<FileListing>;
  transfer: (
    from: string,
    into: string,
    cut: boolean,
    overwrite: boolean
  ) => Promise<string>;
  trash: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  create: (path: string, directory: boolean) => Promise<void>;
  clipboardWriteFiles: (paths: string[]) => Promise<void>;
  reveal: (path: string) => Promise<void>;
}

export interface FileTreeGitBadge {
  letter: string;
  color: string;
  label: string;
}

export interface FileTreeConflictOption {
  label: string;
  value: "skip" | "keep-both" | "replace";
  danger?: boolean;
}

export interface FileTreeKeyHints {
  paste: string;
  copy: string;
  cut: string;
  copyPath: string;
}

export interface FileTreeProps<
  Selection extends FileSelectionState = FileSelectionState,
> {
  root: string;
  selected: string | null;
  onSelect: (entry: FileEntry) => void;
  onRootChange: (dir: string) => void;
  refreshToken: number;
  onBranch: (branch: string | null, repoRoot: string | null) => void;
  /** Show dotfiles. Off by default — a home directory is mostly noise. */
  showHidden: boolean;
  /** Called after any create/rename/trash so the owner can refresh. */
  onMutate: () => void;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  sort: SortSpec;
  selectedPaths: string[];
  /** How the picking changes over the host-owned selection state. */
  applySelection: (fn: (state: Selection) => Selection) => void;
  recordUndo?: (entry: UndoEntry) => void;
  onCompress?: (
    paths: string[],
    destDir: string,
    format: "zip" | "tgz"
  ) => void;
  onCompare?: (paths: [string, string]) => void;
  runtime: FileTreeRuntime;
  clipboard: FileTreeClipboard | null;
  setClipboard: (clipboard: FileTreeClipboard | null) => void;
  getDraggingPaths: () => string[];
  setDraggingPaths: (paths: string[]) => void;
  badgeFor: (status: FileGitStatus) => FileTreeGitBadge;
  isComposing: (event: KeyboardEvent) => boolean;
  confirmChoice: (
    message: string,
    options: FileTreeConflictOption[]
  ) => Promise<FileTreeConflictOption["value"] | null>;
  keyHints: FileTreeKeyHints;
}

type Row =
  | { kind: "entry"; entry: FileEntry; depth: number; expanded: boolean }
  | { kind: "empty"; under: string; depth: number };

/**
 * State is keyed by path, never by node identity: React rebuilds the row
 * objects on every render, so identity comparisons silently stop matching and
 * the second click on a folder does nothing.
 */

/** Extension buckets for the tree's type dots (round eleven): a small,
 *  closed vocabulary — code / data / doc / web / media / pack — so the
 *  palette stays inside the theme's semantic slots instead of growing a
 *  color per format. Directories carry the caret instead. */
const EXT_CLASS: Record<string, string> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code",
  cjs: "code", rs: "code", py: "code", go: "code", java: "code",
  c: "code", h: "code", cpp: "code", hpp: "code", swift: "code",
  rb: "code", php: "code", sh: "code", bash: "code", zsh: "code",
  json: "data", yaml: "data", yml: "data", toml: "data", ini: "data",
  cfg: "data", csv: "data", tsv: "data", sql: "data", lock: "data",
  md: "doc", txt: "doc", pdf: "doc", rst: "doc",
  html: "web", css: "web", scss: "web", svg: "web",
  png: "media", jpg: "media", jpeg: "media", gif: "media",
  mp4: "media", mov: "media", mp3: "media", wav: "media", flac: "media",
  zip: "pack", tar: "pack", gz: "pack", tgz: "pack", bz2: "pack",
};

function extClass(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const cls = EXT_CLASS[name.slice(dot + 1).toLowerCase()];
  return cls ? `ext-${cls}` : "";
}

export function FileTree<Selection extends FileSelectionState>({
  root,
  selected,
  onSelect,
  onRootChange,
  refreshToken,
  onBranch,
  showHidden,
  onMutate,
  expanded,
  setExpanded,
  sort,
  selectedPaths,
  applySelection,
  recordUndo,
  onCompress,
  onCompare,
  runtime,
  clipboard,
  setClipboard,
  getDraggingPaths,
  setDraggingPaths,
  badgeFor,
  isComposing,
  confirmChoice,
  keyHints,
}: FileTreeProps<Selection>) {
  const [menu, setMenu] = useState<TreeMenu | null>(null);
  const [aimed, setAimed] = useState<{ path: string; isDir: boolean } | null>(null);
  const [filter, setFilter] = useState<TreeFilter>(NO_FILTER);
  const [dropIntoDir, setDropIntoDir] = useState<string | null>(null);
  const [noDropDir, setNoDropDir] = useState<string | null>(null);
  /** Whether the press being finished turned into a drag — the release
   *  judgement's other half, reset a turn late so the release that ends a
   *  drag never reads as a plain click (the sidebar's draggingRef shape). */
  const draggingRef = useRef(false);
  const springRef = useRef<{ dir: string; t: number } | null>(null);
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<ErrorDescription | null>(null);
  const branchRef = useRef(onBranch);
  branchRef.current = onBranch;

  /**
   * `quiet` is for directories nobody asked for right now — restored or
   * refreshed in the background. One of those having vanished is not news to
   * put on screen; it just stops being expanded.
   */
  const load = useCallback(
    async (dir: string, quiet = false): Promise<FileEntry[] | null> => {
      setLoading((prev) => new Set(prev).add(dir));
      try {
        const l = await runtime.list(dir);
        setChildren((prev) => new Map(prev).set(dir, l.entries));
        setError(null);
        return l.entries;
      } catch (e) {
        if (!quiet) setError(describeError(e, STR.errors.actions.readFolder));
        return null;
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      }
    },
    [runtime]
  );

  /** A background listing that failed: unexpand the path and say nothing. */
  const dropIfGone = useCallback(
    async (dir: string, pending: Promise<FileEntry[] | null>) => {
      if ((await pending) !== null) return;
      setExpanded((prev) => {
        if (!prev.has(dir)) return prev;
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    },
    [setExpanded]
  );

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      const el = document.querySelector(".tree-menu");
      if (el && !el.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", down, { capture: true });
    window.addEventListener("keydown", key, { capture: true });
    return () => {
      window.removeEventListener("mousedown", down, { capture: true });
      window.removeEventListener("keydown", key, { capture: true });
    };
  }, [menu]);

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      setMenu(null);
      onMutate();
    } catch (e) {
      setError(describeError(e, STR.errors.actions.applyFileChange));
      setMenu(null);
    }
  };

  // Root (re)load: drop everything below it, keep expansion of surviving paths.
  useEffect(() => {
    if (!root) return;
    let alive = true;
    (async () => {
      try {
        const l = await runtime.list(root);
        if (!alive) return;
        setChildren((prev) => new Map(prev).set(root, l.entries));
        setError(null);
        branchRef.current(l.branch, l.repoRoot);
      } catch (e) {
        if (alive) setError(describeError(e, STR.errors.actions.readFolder));
      }
    })();
    return () => {
      alive = false;
    };
  }, [root, refreshToken, runtime]);

  // Refresh already-expanded directories when the caller bumps the token
  // (after a save, git status changes and badges must follow).
  useEffect(() => {
    if (refreshToken === 0) return;
    for (const dir of expanded) void dropIfGone(dir, load(dir, true));
    // Only on token change: expanding a dir already loads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const seeding = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const dir of expanded) {
      if (children.has(dir) || seeding.current.has(dir)) continue;
      seeding.current.add(dir);
      void dropIfGone(dir, load(dir, true));
    }
  }, [expanded, children, load, dropIfGone]);

  const expandDir = async (path: string) => {
    setExpanded((prev) => new Set(prev).add(path));
    if (!children.has(path)) await load(path);
  };

  const toggleDir = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    await expandDir(path);
  };

  /** Cancel the pending spring-loaded expansion, if any. */
  const clearSpring = useCallback(() => {
    if (!springRef.current) return;
    window.clearTimeout(springRef.current.t);
    springRef.current = null;
  }, []);
  useEffect(() => clearSpring, [clearSpring]);

  const armSpring = (dir: string) => {
    if (springRef.current?.dir === dir) return;
    clearSpring();
    springRef.current = {
      dir,
      t: window.setTimeout(() => {
        springRef.current = null;
        if (getDraggingPaths().length === 0) return;
        if (expanded.has(dir)) return;
        void expandDir(dir);
      }, 600),
    };
  };

  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    let visible = 0;
    for (const entry of sortEntries(children.get(dir) ?? [], sort)) {
      if (!showHidden && entry.name.startsWith(".")) continue;
      visible++;
      const isOpen = entry.isDir && expanded.has(entry.path);
      rows.push({ kind: "entry", entry, depth, expanded: isOpen });
      if (isOpen && children.has(entry.path)) walk(entry.path, depth + 1);
    }
    // Only a directory that has been listed can be called empty — an
    // unlisted one is still loading, which the caret already says.
    if (visible === 0 && children.has(dir)) {
      rows.push({ kind: "empty", under: dir, depth });
    }
  };
  if (root) walk(root, 0);
  const filtering = filterActive(filter);
  const filtered = filtering
    ? filterRows(
        new Map(
          [...children.entries()].map(([dir, list]) => [
            dir,
            sortEntries(list, sort),
          ])
        ),
        root,
        showHidden,
        filter
      )
    : null;
  const rootLoading = !!root && !children.has(root) && !error;

  // What is actually on screen: the walk's rows, or the filter's matches.
  const displayRows: Row[] = filtered
    ? filtered.rows.map((r) => ({
        kind: "entry" as const,
        entry: r.entry,
        depth: r.depth,
        expanded: false,
      }))
    : rows;

  const visiblePaths: string[] = [];
  for (const row of displayRows) {
    if (row.kind === "entry") visiblePaths.push(row.entry.path);
  }

  const transferBatch = async (paths: string[], into: string, cut: boolean) => {
    const items = paths.map((from) => ({ from, overwrite: false }));
    let skipped = 0;
    if (paths.length >= 2) {
      skipped = await askConflicts(items, into);
      if (skipped < 0) return; // cancelled: nothing moves
    }
    const landed: string[] = [];
    let failed = 0;
    let firstFailure: ErrorDescription | null = null;
    for (const item of items) {
      if (item.from === null) continue; // skipped by the choice
      try {
        const answer = await runtime.transfer(item.from, into, cut, item.overwrite);
        landed.push(answer);
        recordUndo?.(
          item.overwrite
            ? { kind: "overwritten", path: answer }
            : { kind: "transfer", cut, src: item.from, landed: answer }
        );
      } catch (e) {
        failed++;
        firstFailure ??= describeError(e, STR.errors.actions.applyFileChange);
      }
    }
    if (landed.length > 0) {
      applySelection((pane) => selectionLanded(pane, landed));
    }
    onMutate();
    if (failed > 0 || skipped > 0) {
      setError({
        title:
          skipped > 0
            ? STR.files.tree.batchReport({
                added: landed.length,
                skipped,
                failed,
              })
            : STR.files.tree.batchFailed({
                failed,
                total: paths.length,
                first: firstFailure!.title,
              }),
        next: firstFailure?.next ?? undefined,
        detail: firstFailure?.detail ?? "",
      });
    }
  };

  const askConflicts = async (
    items: { from: string | null; overwrite: boolean }[],
    into: string
  ): Promise<number> => {
    let taken: Set<string>;
    try {
      taken = new Set((await runtime.list(into)).entries.map((e) => e.name));
    } catch {
      return 0; // the listing failed; the per-item transfer reports its own
    }
    const clash = items.filter(
      (i) => i.from !== null && taken.has(i.from.split("/").pop()!)
    );
    if (clash.length === 0) return 0;
    const answer = await confirmChoice(
      STR.files.tree.conflictAsk({
        clashes: clash.length,
        total: items.length,
        dir: into.split("/").pop() || "/",
      }),
      [
        { label: STR.files.tree.conflictSkip, value: "skip" },
        { label: STR.files.tree.conflictKeepBoth, value: "keep-both" },
        {
          label: STR.files.tree.conflictReplace,
          value: "replace",
          danger: true,
        },
      ]
    );
    if (answer === null) return -1; // cancel: the safe direction moves nothing
    if (answer === "skip") {
      for (const item of clash) item.from = null;
      return clash.length;
    }
    if (answer === "replace") {
      // Only the clashing items are armed: an innocent name destroyed
      // nothing, so it stays an ordinary (undoable) transfer.
      for (const item of clash) item.overwrite = true;
    }
    return 0;
  };

  /** The clipboard's paths — `path` alone when a single-path writer set it. */
  const clipPaths = (c: { path: string; paths?: string[] }): string[] =>
    c.paths ?? [c.path];

  /** Paste whatever the clipboard holds into a directory, batch and all. */
  const pasteInto = (dir: string) => {
    const moving = clipboard;
    if (!moving) return;
    setClipboard(null);
    void transferBatch(clipPaths(moving), dir, moving.cut);
  };

  /** Trash one row at a time, said together once — the same aggregation a
   *  transfer gets, because a partial trash run must still refresh what
   *  did go and name what did not. */
  const trashBatch = async (paths: string[]) => {
    let failed = 0;
    let firstFailure: ErrorDescription | null = null;
    for (const path of paths) {
      try {
        await runtime.trash(path);
        recordUndo?.({ kind: "trash", path });
      } catch (e) {
        failed++;
        firstFailure ??= describeError(e, STR.errors.actions.applyFileChange);
      }
    }
    applySelection(selectionCleared);
    setMenu(null);
    onMutate();
    if (failed > 0 && firstFailure) {
      setError({
        title: STR.files.tree.batchFailed({
          failed,
          total: paths.length,
          first: firstFailure.title,
        }),
        next: firstFailure.next,
        detail: firstFailure.detail,
      });
    }
  };

  return (
    <div className="file-tree">
      {error && <ErrorState inline error={error} />}
      {rootLoading && (
        <LoadingState inline label={STR.files.tree.readingFolder} />
      )}
      {filtered && (
        <div className="tree-filter" role="status">
          {/* The query is shown, not edited in place: the keyboard is the
              editor, this is the echo — with the count of what survives and
              the two ways to narrow it. */}
          <span className="tree-filter-text" title={filter.text}>
            {filter.text || STR.files.filter.blankQuery}
          </span>
          <span className="tree-filter-count">
            {STR.files.filter.count({
              shown: filtered.rows.length,
              total: filtered.total,
            })}
          </span>
          <span className="tree-bar-group">
            {(
              [
                ["all", STR.files.filter.all],
                ["dirs", STR.files.filter.dirs],
                ["files", STR.files.filter.files],
              ] as [FilterKind, string][]
            ).map(([kind, label]) => (
              <button
                key={kind}
                className={`mini-btn${filter.kind === kind ? " on" : ""}`}
                aria-pressed={filter.kind === kind}
                title={STR.files.filter.kindHint}
                onClick={() => setFilter((f) => ({ ...f, kind }))}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="tree-filter-hint">{STR.files.filter.clearHint}</span>
        </div>
      )}
      <div
        className="tree-rows"
        // Focusable so the keys below reach it, and only it: the same keys
        // in the editor still mean what they mean there.
        tabIndex={0}
        onKeyDown={(e) => {
          if (isComposing(e.nativeEvent)) return;
          if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            if (e.key.length === 1) {
              e.preventDefault();
              setFilter((f) => ({ ...f, text: f.text + e.key }));
              return;
            }
            if (e.key === "Backspace") {
              e.preventDefault();
              setFilter((f) => ({
                ...f,
                text: f.text.slice(0, -1),
              }));
              return;
            }
            if (e.key === "Escape" && filterActive(filter)) {
              e.preventDefault();
              setFilter(NO_FILTER);
              return;
            }
            // Arrows and everything else stay the editor's neighbors'
            // business: a filter is typing, not navigation.
            return;
          }
          if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
          const target = aimed ?? (selected ? { path: selected, isDir: false } : null);
          const key = e.key.toLowerCase();
          if (key === "c" && e.altKey) {
            if (!target) return;
            e.preventDefault();
            void navigator.clipboard?.writeText(target.path);
            return;
          }
          if (e.altKey) return;
          if (key === "a") {
            e.preventDefault();
            applySelection((p) => selectionAll(p, visiblePaths));
            return;
          }
          if (key === "c" || key === "x") {
            // The picked set when there is one; the aimed row (or the open
            // file) when there is not — a single-path habit keeps working.
            const paths =
              selectedPaths.length > 0
                ? selectedPaths
                : target
                  ? [target.path]
                  : [];
            if (paths.length === 0) return;
            e.preventDefault();
            setClipboard({
              path: paths[0],
              paths,
              cut: key === "x",
            });
            return;
          }
          if (key === "v") {
            if (!clipboard) return;
            e.preventDefault();
            // Into the aimed folder, or the aimed file's folder, or the
            // root — the same rule the menu states out loud.
            const into = target
              ? target.isDir
                ? target.path
                : target.path.slice(0, target.path.lastIndexOf("/"))
              : root;
            pasteInto(into);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ entry: null, x: e.clientX, y: e.clientY, input: null });
        }}
      >
        {displayRows.map((row) => {
          if (row.kind === "empty") {
            return (
              <div
                key={`empty:${row.under}`}
                className="tree-empty"
                style={{
                  paddingLeft: 6 + (row.depth + 1) * 13,
                  ["--tree-depth" as string]: row.depth + 1,
                } as React.CSSProperties}
              >
                {STR.files.tree.emptyFolder}
              </div>
            );
          }
          const { entry, depth, expanded: isOpen } = row;
          const badge = entry.git ? badgeFor(entry.git) : null;
          const picked = selectedPaths.includes(entry.path);
          return (
            <div
              key={entry.path}
              className={`tree-row${selected === entry.path ? " sel" : ""}${
                picked ? " picked" : ""
              }${
                entry.isDir && dropIntoDir === entry.path ? " drop-into" : ""
              }${
                entry.isDir && noDropDir === entry.path ? " no-drop" : ""
              }${
                badge && !entry.gitFromChildren ? ` git-${entry.git}` : ""
              }`}
              // The row is what takes focus, so the keys below reach the
              // list they belong to. Focusing the container instead did not
              // survive the click, and the copy then acted on whatever file
              // happened to be open rather than the row under the pointer.
              tabIndex={-1}
              style={
                {
                  paddingLeft: 6 + depth * 13,
                  "--tree-depth": depth,
                } as React.CSSProperties
              }
              draggable
              onDragStart={(e) => {
                draggingRef.current = true;
                // Dragging a row that is part of the picked-out set moves
                // the whole set; dragging any other row is an ordinary
                // single drag and drops the set, because a stale picking
                // must not come along for a ride nobody asked for.
                const paths = picked ? selectedPaths : [entry.path];
                if (!picked) applySelection(selectionCleared);
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
                e.dataTransfer.effectAllowed = "copyMove";
                setDraggingPaths(paths);
                if (paths.length > 1) {
                  // Otherwise the cursor carries one row and nothing says
                  // the other two are coming.
                  const ghost = document.createElement("div");
                  ghost.className = "drag-ghost";
                  ghost.textContent = STR.files.tree.dragCount({
                    n: paths.length,
                  });
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, 12, 12);
                  window.setTimeout(() => ghost.remove(), 0);
                }
              }}
              onDragEnd={() => {
                setDraggingPaths([]);
                clearSpring();
                setDropIntoDir(null);
                setNoDropDir(null);
                // Cleared on the next turn so the release that ends the
                // drag does not read as a plain click on this row.
                window.setTimeout(() => {
                  draggingRef.current = false;
                }, 0);
              }}
              onDragOver={(e) => {
                if (!entry.isDir) return;
                // Either signal is enough: the payload's type or the
                // remembered paths retained from drag start.
                if (
                  getDraggingPaths().length === 0 &&
                  !e.dataTransfer?.types.includes(DRAG_MIME)
                ) {
                  return;
                }
                if (blocksDrop(entry.path, getDraggingPaths())) {
                  setNoDropDir(entry.path);
                  setDropIntoDir(null);
                  return;
                }
                setNoDropDir(null);
                e.preventDefault();
                // ⌥ held at the drop copies; the platform's drag
                // vocabulary, honored at the last moment so a press can
                // change its mind mid-air.
                e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                setDropIntoDir(entry.path);
                // Spring-loaded: hovering a closed directory opens it.
                if (!expanded.has(entry.path)) armSpring(entry.path);
                else clearSpring();
              }}
              onDragLeave={() => {
                if (dropIntoDir === entry.path) setDropIntoDir(null);
                if (noDropDir === entry.path) setNoDropDir(null);
                clearSpring();
              }}
              onDrop={(e) => {
                if (!entry.isDir) return;
                clearSpring();
                setDropIntoDir(null);
                setNoDropDir(null);
                const remembered = getDraggingPaths();
                setDraggingPaths([]);
                // The data store is readable at last; retained paths cover
                // platforms that omit a custom payload.
                const fromPayload = parseDragPaths(
                  e.dataTransfer?.getData(DRAG_MIME) ?? ""
                );
                const paths = fromPayload.length > 0 ? fromPayload : remembered;
                if (paths.length === 0) return;
                if (blocksDrop(entry.path, paths)) return;
                e.preventDefault();
                e.stopPropagation();
                void transferBatch(paths, entry.path, !e.altKey);
              }}
              onMouseDown={(e) => {
                // Aimed at, and focused, before anything else happens: the
                // keys on the list act on the row under the pointer, and a
                // row that never took focus never receives them.
                setAimed({ path: entry.path, isDir: entry.isDir });
                (e.currentTarget as HTMLElement).focus();
                if (e.button !== 0) return;
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  applySelection((p) => selectionToggled(p, entry.path));
                  return;
                }
                if (e.shiftKey) {
                  e.preventDefault();
                  applySelection((p) =>
                    selectionExtended(p, entry.path, visiblePaths)
                  );
                  return;
                }
                // A drag begins with a plain press on a row that is already
                // picked out — so clearing here threw the set away a
                // moment before the drag could read it, and a multi-row
                // drag moved exactly one row. The decision waits for the
                // release instead (the sidebar's release judgement, kept
                // whole): dragged, and the picking stands; released
                // without dragging, and it collapses to this row, which is
                // what a plain click means.
                if (picked) return;
                applySelection(selectionCleared);
              }}
              onMouseUp={(e) => {
                if (e.button !== 0) return;
                if (draggingRef.current || e.metaKey || e.ctrlKey || e.shiftKey) {
                  return;
                }
                // The release half: a press on a picked row that never
                // turned into a drag is a plain click, and the picking
                // collapses — the click itself (open, expand) still runs,
                // in onClick, which no drag can reach.
                if (picked) applySelection(selectionCleared);
              }}
              onClick={(e) => {
                // A modifier click picks rows out; it does not also go
                // there.
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                if (entry.isDir) void toggleDir(entry.path);
                else onSelect(entry);
              }}
              onDoubleClick={() => {
                if (entry.isDir) onRootChange(entry.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setAimed({ path: entry.path, isDir: entry.isDir });
                // Right-clicking outside the picking answers for that row
                // alone (Finder's rule), and the picking is not it.
                if (!picked) applySelection(selectionCleared);
                setMenu({ entry, x: e.clientX, y: e.clientY, input: null });
              }}
              title={entry.path}
            >
              <span
                className={`tree-caret${entry.isDir && isOpen ? " open" : ""}`}
                aria-hidden="true"
              >
                {entry.isDir ? (loading.has(entry.path) ? "·" : "▸") : ""}
              </span>
              {!entry.isDir && (
                <span
                  aria-hidden="true"
                  className={`ext-dot ${extClass(entry.name)}`}
                />
              )}
              <span className={`tree-name${entry.isDir ? " dir" : ""}`}>
                {entry.name}
                {entry.isSymlink && <span className="symlink"> ↗</span>}
              </span>
              {badge && (
                <span
                  className="git-badge"
                  style={{ color: badge.color }}
                  title={
                    entry.gitFromChildren
                      ? STR.files.tree.containsBadgeHint({
                          status: badge.label,
                        })
                      : badge.label
                  }
                >
                  {entry.gitFromChildren ? "•" : badge.letter}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <TreeMenuView
          menu={menu}
          root={root}
          setMenu={setMenu}
          act={act}
          onRootChange={onRootChange}
          actionPaths={
            menu.entry && selectedPaths.includes(menu.entry.path)
              ? selectedPaths
              : menu.entry
                ? [menu.entry.path]
                : []
          }
          onPasteInto={pasteInto}
          onTrash={(paths) => void trashBatch(paths)}
          recordUndo={recordUndo}
          onCompress={onCompress}
          onCompare={onCompare}
          runtime={runtime}
          clipboard={clipboard}
          setClipboard={setClipboard}
          keyHints={keyHints}
        />
      )}
    </div>
  );
}

function TreeMenuView({
  menu,
  root,
  setMenu,
  act,
  onRootChange,
  actionPaths,
  onPasteInto,
  onTrash,
  recordUndo,
  onCompress,
  onCompare,
  runtime,
  clipboard,
  setClipboard,
  keyHints,
}: {
  menu: TreeMenu;
  root: string;
  setMenu: (m: TreeMenu | null) => void;
  act: (fn: () => Promise<void>) => Promise<void>;
  onRootChange: (dir: string) => void;
  /** The rows the batch actions act on, with the count for their labels. */
  actionPaths: string[];
  onPasteInto: (dir: string) => void;
  onTrash: (paths: string[]) => void;
  recordUndo?: (entry: UndoEntry) => void;
  onCompress?: (paths: string[], destDir: string, format: "zip" | "tgz") => void;
  onCompare?: (paths: [string, string]) => void;
  runtime: FileTreeRuntime;
  clipboard: FileTreeClipboard | null;
  setClipboard: (clipboard: FileTreeClipboard | null) => void;
  keyHints: FileTreeKeyHints;
}) {
  const entry = menu.entry;
  const n = actionPaths.length;
  const count = (label: string) => STR.files.tree.withCount({ label, n });
  // New items land inside a directory: the clicked folder, the clicked
  // file's parent, or the tree root.
  const baseDir = entry
    ? entry.isDir
      ? entry.path
      : entry.path.slice(0, entry.path.lastIndexOf("/"))
    : root;
  const x = Math.min(menu.x, window.innerWidth - 230);
  const y = Math.min(menu.y, window.innerHeight - 260);

  if (menu.input) {
    const placeholder =
      menu.input === "rename"
        ? entry?.name
        : STR.files.tree.newNamePlaceholder({ kind: menu.input });
    return (
      <div className="ctx-menu tree-menu" style={{ left: x, top: y }}>
        <input
          className="ctx-input"
          autoFocus
          defaultValue={menu.input === "rename" ? entry?.name : ""}
          placeholder={placeholder}
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key === "Enter" && v) {
              if (menu.input === "rename" && entry) {
                const to = `${baseDir === entry.path ? entry.path.slice(0, entry.path.lastIndexOf("/")) : baseDir}/${v}`;
                void act(async () => {
                  await runtime.rename(entry.path, to);
                  recordUndo?.({ kind: "rename", from: entry.path, to });
                });
              } else {
                void act(async () => {
                  await runtime.create(`${baseDir}/${v}`, menu.input === "folder");
                  recordUndo?.({
                    kind: "create",
                    path: `${baseDir}/${v}`,
                    dir: menu.input === "folder",
                  });
                });
              }
            } else if (e.key === "Escape") {
              setMenu(null);
            }
            e.stopPropagation();
          }}
        />
      </div>
    );
  }

  return (
    <div className="ctx-menu tree-menu" style={{ left: x, top: y }}>
      {entry && <div className="ctx-title">{entry.name}</div>}
      <button
        className="ctx-item"
        onClick={() => setMenu({ ...menu, input: "file" })}
      >
        {STR.files.tree.newFile}
      </button>
      <button
        className="ctx-item"
        onClick={() => setMenu({ ...menu, input: "folder" })}
      >
        {STR.files.tree.newFolder}
      </button>
      <button
            className="ctx-item"
            disabled={!clipboard}
            onClick={() => {
              if (!clipboard) return;
              setMenu(null);
              // Where it will land is said out loud by the label; the
              // transfer itself — batch, landing answers, aggregation —
              // lives with the tree, which owns the picking it lands on.
              onPasteInto(baseDir);
            }}
          >
            {/* Where it will land is said out loud: the clicked folder, or
                the clicked file's folder — not "here", which is ambiguous
                the moment a file rather than a folder was clicked. */}
            {clipboard
              ? STR.files.tree.pasteInto({
                  dir: baseDir.split("/").pop() || "/",
                })
              : STR.files.tree.pasteEmpty}
            <kbd className="ctx-kbd">{keyHints.paste}</kbd>
          </button>
      {entry && (
        <>
          <button
            className="ctx-item"
            onClick={() => setMenu({ ...menu, input: "rename" })}
          >
            {STR.files.tree.rename}
          </button>
          {entry.isDir && (
            <button
              className="ctx-item"
              onClick={() => {
                setMenu(null);
                onRootChange(entry.path);
              }}
            >
              {STR.files.tree.openAsRoot}
            </button>
          )}
          <button
            className="ctx-item"
            onClick={() => {
              setClipboard({
                path: actionPaths[0],
                paths: actionPaths,
                cut: false,
              });
              setMenu(null);
            }}
          >
            {count(STR.files.tree.copy)}
            <kbd className="ctx-kbd">{keyHints.copy}</kbd>
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setClipboard({
                path: actionPaths[0],
                paths: actionPaths,
                cut: true,
              });
              setMenu(null);
            }}
          >
            {count(STR.files.tree.cut)}
            <kbd className="ctx-kbd">{keyHints.cut}</kbd>
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              // Several picked paths go out together, one per line — the
              // shape a shell takes them back in.
              void navigator.clipboard?.writeText(actionPaths.join("\n"));
              setMenu(null);
            }}
          >
            {count(STR.files.tree.copyPath)}
            <kbd className="ctx-kbd">{keyHints.copyPath}</kbd>
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              // Relative to the tree's root, which is the form that goes
              // into a document; the absolute one is what a shell wants.
              const rel = actionPaths.map((p) =>
                p.startsWith(root)
                  ? p.slice(root.length).replace(/^\//, "")
                  : p
              );
              void navigator.clipboard?.writeText(rel.join("\n"));
              setMenu(null);
            }}
          >
            {count(STR.files.tree.copyRelativePath)}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setMenu(null);
              void act(() => runtime.clipboardWriteFiles(actionPaths));
            }}
          >
            {count(STR.files.tree.copyToClipboard)}
          </button>
          <button
            className="ctx-item"
            onClick={() => void act(() => runtime.reveal(entry.path))}
          >
            {STR.files.tree.revealInFinder}
          </button>
          {onCompress && (
            <>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null);
                  onCompress(actionPaths, baseDir, "zip");
                }}
              >
                {count(STR.files.tree.compressZip)}
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null);
                  onCompress(actionPaths, baseDir, "tgz");
                }}
              >
                {count(STR.files.tree.compressTgz)}
              </button>
            </>
          )}
          {onCompare && actionPaths.length === 2 && (
            <button
              className="ctx-item"
              onClick={() => {
                setMenu(null);
                onCompare([actionPaths[0], actionPaths[1]]);
              }}
            >
              {STR.files.tree.compare}
            </button>
          )}
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => onTrash(actionPaths)}
          >
            {count(STR.files.tree.moveToTrash)}
          </button>
        </>
      )}
    </div>
  );
}
