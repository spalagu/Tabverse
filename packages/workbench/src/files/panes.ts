import { DEFAULT_SORT, type SortSpec } from "./sortEntries";
import { trimTrailingSlashes } from "./pathStrings";

export {
  selectionAll,
  selectionCleared,
  selectionExtended,
  selectionLanded,
  selectionToggled,
} from "@tabverse/workbench/files/file-selection";


/** How the sidebar presents this pane's directory: tree or Miller columns. */
export type TreeMode = "tree" | "miller";

/** How two panes are arranged: side by side, or stacked. */
export type PaneLayout = "row" | "column";

/** The only file fact required by pane bookkeeping. */
export interface PaneFile {
  path: string;
}

export interface NavStack {
  back: string[];
  fwd: string[];
}

export interface PaneState<File extends PaneFile = PaneFile> {
  root: string;
  /** VS Code semantics, per pane: many files open, one active, a draft each. */
  open: File[];
  activePath: string | null;
  drafts: Map<string, string>;
  /** path → preview/split/source per open file. */
  viewModes: Map<string, string>;
  expanded: Set<string>;
  treeModes: Map<string, TreeMode>;
  selectedPaths: string[];
  /** Where a range selection counts from — the last row picked on its own. */
  selectionAnchor: string | null;
  sort: SortSpec;
  conflicts: Set<string>;
  nav: NavStack;
}

export function newPane<File extends PaneFile = PaneFile>(
  root: string
): PaneState<File> {
  return {
    root,
    open: [],
    activePath: null,
    drafts: new Map(),
    viewModes: new Map(),
    expanded: new Set(),
    treeModes: new Map(),
    selectedPaths: [],
    selectionAnchor: null,
    sort: DEFAULT_SORT,
    conflicts: new Set(),
    nav: { back: [], fwd: [] },
  };
}

export function paneForPath(
  panes: readonly PaneState[],
  path: string,
  active: number
): number {
  if (active < 0 || active >= panes.length) active = 0;
  const contains = (root: string): boolean => {
    const r = trimTrailingSlashes(root) || "/";
    return path === r || path.startsWith(`${r === "/" ? "" : r}/`);
  };
  // The active pane wins its own ties, so a file under both roots stays
  // where the user is looking rather than jumping to the lower index.
  if (contains(panes[active].root)) return active;
  for (let i = 0; i < panes.length; i++) {
    if (contains(panes[i].root)) return i;
  }
  return active;
}

/** A file opened into a pane: appended once, and made the active one. */
export function openInPane<File extends PaneFile>(
  pane: PaneState<File>,
  meta: File
): PaneState<File> {
  if (pane.open.some((f) => f.path === meta.path)) {
    return pane.activePath === meta.path ? pane : { ...pane, activePath: meta.path };
  }
  return { ...pane, open: [...pane.open, meta], activePath: meta.path };
}

/** A keystroke's draft for one file. */
export function draftedPane<File extends PaneFile>(
  pane: PaneState<File>,
  path: string,
  text: string
): PaneState<File> {
  return { ...pane, drafts: new Map(pane.drafts).set(path, text) };
}

/**
 * A save that landed: the draft is gone (unless keystrokes raced the write —
 * the caller checks that), the dispute is settled, and the open file wears
 * what disk now says.
 */
export function savedPane<File extends PaneFile>(
  pane: PaneState<File>,
  path: string,
  fresh: File,
  racedDraft: string | null
): PaneState<File> {
  const drafts = new Map(pane.drafts);
  if (racedDraft === null) drafts.delete(path);
  else drafts.set(path, racedDraft);
  const conflicts = pane.conflicts.has(path)
    ? new Set([...pane.conflicts].filter((p) => p !== path))
    : pane.conflicts;
  return {
    ...pane,
    open: pane.open.map((f) => (f.path === path ? fresh : f)),
    drafts,
    conflicts,
  };
}

export function closedPane<File extends PaneFile>(
  pane: PaneState<File>,
  paths: readonly string[]
): PaneState<File> {
  if (paths.length === 0) return pane;
  const gone = new Set(paths);
  const survivors = pane.open.filter((f) => !gone.has(f.path));
  let activePath = pane.activePath;
  if (activePath && gone.has(activePath)) {
    const at = pane.open.findIndex((f) => f.path === activePath);
    const right = pane.open.slice(at + 1).find((f) => !gone.has(f.path));
    activePath = right?.path ?? survivors[survivors.length - 1]?.path ?? null;
  }
  const drafts = new Map(pane.drafts);
  for (const p of gone) drafts.delete(p);
  const conflicts = pane.conflicts.size
    ? new Set([...pane.conflicts].filter((p) => !gone.has(p)))
    : pane.conflicts;
  return {
    ...pane,
    open: survivors,
    activePath,
    drafts,
    conflicts,
  };
}

/** A pane's workspace remembered view mode. */
export function modeSetPane<File extends PaneFile>(
  pane: PaneState<File>,
  path: string,
  mode: string
): PaneState<File> {
  return { ...pane, viewModes: new Map(pane.viewModes).set(path, mode) };
}


/** A root change landed: the root left behind goes on the back stack. */
export function pushNav<File extends PaneFile>(
  pane: PaneState<File>,
  from: string
): PaneState<File> {
  if (!from || pane.nav.back[pane.nav.back.length - 1] === from) return pane;
  return { ...pane, nav: { back: [...pane.nav.back, from], fwd: [] } };
}

/**
 * Go back: the back stack's top becomes the root, the root left behind
 * goes on the front stack. Null when there is nowhere to go — the caller
 * decides what nothing does (usually: nothing).
 */
export function navBackPane<File extends PaneFile>(
  pane: PaneState<File>
): { pane: PaneState<File>; to: string } | null {
  const to = pane.nav.back[pane.nav.back.length - 1];
  if (!to || to === pane.root) return null;
  return {
    to,
    pane: {
      ...pane,
      root: to,
      nav: {
        back: pane.nav.back.slice(0, -1),
        fwd: [pane.root, ...pane.nav.fwd],
      },
    },
  };
}

/** Go forward: the mirror of going back. */
export function navForwardPane<File extends PaneFile>(
  pane: PaneState<File>
): { pane: PaneState<File>; to: string } | null {
  const to = pane.nav.fwd[0];
  if (!to || to === pane.root) return null;
  return {
    to,
    pane: {
      ...pane,
      root: to,
      nav: {
        back: [...pane.nav.back, pane.root],
        fwd: pane.nav.fwd.slice(1),
      },
    },
  };
}

/** A disputed draft answered: kept (banner down only) or discarded. */
export function conflictResolvedPane<File extends PaneFile>(
  pane: PaneState<File>,
  path: string,
  keepDraft: boolean
): PaneState<File> {
  const conflicts = pane.conflicts.has(path)
    ? new Set([...pane.conflicts].filter((p) => p !== path))
    : pane.conflicts;
  if (keepDraft) return { ...pane, conflicts };
  const drafts = new Map(pane.drafts);
  drafts.delete(path);
  return { ...pane, conflicts, drafts };
}

export type PaneFileAction<File extends PaneFile = PaneFile> =
  | { kind: "open"; meta: File; pane: number }
  | { kind: "draft"; path: string; text: string }
  | { kind: "save"; path: string; fresh: File; racedDraft: string | null }
  | { kind: "close"; paths: string[] };

export function applyPaneAction<File extends PaneFile>(
  panes: readonly PaneState<File>[],
  active: number,
  action: PaneFileAction<File>
): PaneState<File>[] {
  if (active < 0 || active >= panes.length) active = 0;
  const at = action.kind === "open" ? action.pane : active;
  const next = panes.slice();
  switch (action.kind) {
    case "open":
      next[at] = openInPane(panes[at], action.meta);
      break;
    case "draft":
      next[at] = draftedPane(panes[at], action.path, action.text);
      break;
    case "save":
      next[at] = savedPane(panes[at], action.path, action.fresh, action.racedDraft);
      break;
    case "close":
      next[at] = closedPane(panes[at], action.paths);
      break;
  }
  return next;
}
