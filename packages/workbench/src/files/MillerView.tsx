import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";
import { LoadingState } from "../state/LoadingState";
import type { FileEntry, FileGitStatus } from "./FileEntry";
import { sortEntries, type SortSpec } from "./sortEntries";
import {
  millerAt,
  millerKey,
  millerPush,
  type MillerState,
} from "./miller";


export interface MillerListing {
  entries: FileEntry[];
  branch: string | null;
  repoRoot: string | null;
}

export interface MillerViewRuntime {
  listDirectory: (dir: string) => Promise<MillerListing>;
}

export interface MillerGitBadge {
  letter: string;
  color: string;
  label: string;
}

export interface MillerViewProps {
  root: string;
  /** The pane's open file, highlighted wherever it is listed. */
  selected: string | null;
  onSelect: (entry: FileEntry) => void;
  onRootChange: (dir: string) => void;
  refreshToken: number;
  onBranch: (branch: string | null, repoRoot: string | null) => void;
  showHidden: boolean;
  sort: SortSpec;
  runtime: MillerViewRuntime;
  badgeFor: (status: FileGitStatus) => MillerGitBadge;
}

/** The four keys the column container answers. */
function isArrow(
  key: string
): key is "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown"
  );
}

export function MillerView({
  root,
  selected,
  onSelect,
  onRootChange,
  refreshToken,
  onBranch,
  showHidden,
  sort,
  runtime,
  badgeFor,
}: MillerViewProps) {
  const [state, setState] = useState<MillerState>(() => millerAt(root));
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [error, setError] = useState<ReturnType<
    typeof describeError
  > | null>(null);
  const branchRef = useRef(onBranch);
  branchRef.current = onBranch;

  // A new root restarts the walk from one column; the same root with a
  // bumped token re-lists what is already up (a save, a mutation).
  useEffect(() => {
    if (!root) return;
    let alive = true;
    setState(millerAt(root));
    (async () => {
      try {
        const l = await runtime.listDirectory(root);
        if (!alive) return;
        setChildren((prev) => new Map(prev).set(root, l.entries));
        setError(null);
        branchRef.current(l.branch, l.repoRoot);
      } catch (e) {
        if (alive)
          setError(describeError(e, STR.errors.actions.readFolder));
      }
    })();
    return () => {
      alive = false;
    };
  }, [root, refreshToken, runtime]);

  /** List one column's directory, quietly. */
  const load = useCallback(async (dir: string) => {
    try {
      const l = await runtime.listDirectory(dir);
      setChildren((prev) => new Map(prev).set(dir, l.entries));
    } catch {
      // A column that cannot list shows its empty state; the root's own
      // failure is the loud one above.
    }
  }, [runtime]);

  // Every column is listed the moment it exists.
  useEffect(() => {
    for (const col of state.columns) {
      if (children.has(col.dir)) continue;
      void load(col.dir);
    }
  }, [state, children, load]);

  // The token bumped: refresh the columns already on screen.
  useEffect(() => {
    if (refreshToken === 0) return;
    for (const col of state.columns) void load(col.dir);
    // Only on token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  /** A column's rows in the pane's display order. */
  const rowsFor = useCallback(
    (dir: string): FileEntry[] =>
      sortEntries(
        (children.get(dir) ?? []).filter(
          (e) => showHidden || !e.name.startsWith(".")
        ),
        sort
      ),
    [children, showHidden, sort]
  );

  // A push decided by the state machine, with the listing asked for.
  const push = useCallback(
    (at: number, dir: string) => {
      setState((prev) => millerPush(prev, at, dir));
      if (!children.has(dir)) void load(dir);
    },
    [children, load]
  );

  const columns = useMemo(
    () =>
      state.columns.map((col, i) => ({
        ...col,
        active: i === state.activeCol,
        rows: rowsFor(col.dir),
        loading: !children.has(col.dir),
      })),
    [state, rowsFor, children]
  );

  return (
    <div className="file-tree miller">
      {error && <ErrorState inline error={error} />}
      {!root && <LoadingState inline label={STR.files.tree.readingFolder} />}
      <div
        className="miller-cols"
        tabIndex={0}
        onKeyDown={(e) => {
          const k = e.key;
          if (!isArrow(k)) return;
          e.preventDefault();
          setState((prev) => millerKey(prev, rowsFor, k));
        }}
      >
        {columns.map((col, i) => (
          <div
            key={col.dir}
            className={`miller-col${col.active ? " active" : ""}`}
          >
            {col.loading ? (
              <LoadingState inline label={STR.files.tree.readingFolder} />
            ) : col.rows.length === 0 ? (
              <div className="tree-empty">{STR.files.tree.emptyFolder}</div>
            ) : (
              col.rows.map((entry) => {
                const badge = entry.git ? badgeFor(entry.git) : null;
                return (
                  <div
                    key={entry.path}
                    className={`miller-row${entry.isDir ? " dir" : ""}${
                      selected === entry.path ? " sel" : ""
                    }${col.aimed === entry.path ? " aimed" : ""}`}
                    title={entry.path}
                    onMouseDown={() =>
                      setState((prev) => {
                        const next = { ...prev };
                        next.columns = prev.columns.map((c, ci) =>
                          ci === i ? { ...c, aimed: entry.path } : c
                        );
                        next.activeCol = i;
                        return next;
                      })
                    }
                    // Single click: a folder pushes its column, a file
                    // previews. NOT the tree's toggleDir — see the header.
                    onClick={() => {
                      if (entry.isDir) push(i, entry.path);
                      else onSelect(entry);
                    }}
                    onDoubleClick={() => {
                      if (entry.isDir) onRootChange(entry.path);
                      else onSelect(entry);
                    }}
                  >
                    <span className={`tree-name${entry.isDir ? " dir" : ""}`}>
                      {entry.name}
                      {entry.isSymlink && <span className="symlink"> ↗</span>}
                    </span>
                    {badge && (
                      <span
                        className="git-badge"
                        style={{ color: badge.color }}
                        title={badge.label}
                      >
                        {badge.letter}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
