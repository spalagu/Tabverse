
import { clampPanelHeight } from "./termSync";
import type { FilesPanelMode } from "@tabverse/workbench/files/sidebar-controls";
import type { PaneLayout, TreeMode } from "./panes";
import {
  DEFAULT_SORT,
  SORT_KEYS,
  sameSort,
  type SortKey,
  type SortSpec,
} from "./sortEntries";

/** One unsaved draft, with the file's mtime at the moment it was taken. */
export interface StoredDraft {
  text: string;
  /** Seconds since the epoch; null when the reader could not stat the file. */
  modified: number | null;
}

export interface StoredSort {
  key: SortKey;
  asc: boolean;
  dirsFirst: boolean;
}

export interface StoredPane {
  root: string;
  expanded: string[];
  open: string[];
  active: string | null;
  /** path → "preview" | "split" | "source"; absent means the default. */
  viewModes: Record<string, string>;
  drafts: Record<string, StoredDraft>;
  treeModes: Record<string, string>;
  /** Absent means the backend's own order. */
  sort?: StoredSort;
}

export interface StoredTermPanel {
  open: boolean;
  height: number;
  cwd: string;
}

/** The whole persisted payload of one file tab, under scope files:<tabId>. */
export interface FilesSessionState {
  /** Current payload version. */
  v: 1;
  showDiff: boolean;
  term: StoredTermPanel;
  panes: StoredPane[];
  layout: PaneLayout;
  activePane: number;
  panelMode: FilesPanelMode;
}

/** The parts of a FileMeta this module reasons about. */
export interface SessionFile {
  path: string;
  text: string | null;
  modified: number | null;
  readOnlyReason: string | null;
}

export interface PaneSnapshot {
  root: string;
  expanded: Iterable<string>;
  open: readonly SessionFile[];
  active: string | null;
  viewModes: ReadonlyMap<string, string>;
  drafts: ReadonlyMap<string, string>;
  treeModes: ReadonlyMap<string, TreeMode>;
  sort: SortSpec;
}

export interface FilesSnapshot {
  panes: readonly PaneSnapshot[];
  layout: PaneLayout;
  activePane: number;
  showDiff: boolean;
  term: StoredTermPanel;
  panelMode: FilesPanelMode;
}

export const MAX_DRAFT_BYTES = 1024 * 1024;
export const MAX_DRAFTS_BYTES = 4 * 1024 * 1024;

/** Expanded directories are cheap but unbounded over a long session. */
const MAX_EXPANDED = 500;

/** Remembered per-root view modes are cheaper still, but also unbounded. */
const MAX_TREE_MODES = 200;

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Exact UTF-8 size, because the budget it feeds is measured in the bytes the
 * store writes, not in JavaScript characters — a CJK draft is three times its
 * length. Pure ASCII, which most source files are, skips the encoding pass
 * and its copy of the whole string.
 */
export function utf8Bytes(text: string): number {
  if (!NON_ASCII.test(text)) return text.length;
  return new TextEncoder().encode(text).length;
}

/**
 * One pane of the payload, from one pane of the snapshot. The draft budget
 * is threaded in from the caller because it belongs to the whole tab: one
 * scope, one ceiling, whichever pane produced the bytes.
 */
function buildPane(
  snap: PaneSnapshot,
  budget: { left: number },
  skippedDrafts: string[]
): StoredPane {
  const openPaths = snap.open.map((f) => f.path);
  const openSet = new Set(openPaths);
  const byPath = new Map(snap.open.map((f) => [f.path, f]));

  const viewModes: Record<string, string> = {};
  for (const [path, mode] of snap.viewModes) {
    if (openSet.has(path)) viewModes[path] = mode;
  }

  const drafts: Record<string, StoredDraft> = {};
  for (const [path, text] of snap.drafts) {
    const file = byPath.get(path);
    // A draft is only worth carrying while its file is open, differs from
    // disk, and could actually be written back — restoring a draft for a
    // file the app refuses to save would resurrect work with nowhere to go.
    if (!file || file.readOnlyReason) continue;
    if (text === (file.text ?? "")) continue;
    const size = utf8Bytes(text);
    if (size > MAX_DRAFT_BYTES || size > budget.left) {
      skippedDrafts.push(path);
      continue;
    }
    budget.left -= size;
    drafts[path] = { text, modified: file.modified };
  }

  const treeModes: Record<string, string> = {};
  let kept = 0;
  for (const [root, mode] of snap.treeModes) {
    if (kept >= MAX_TREE_MODES) break;
    treeModes[root] = mode;
    kept++;
  }

  const expanded = [...snap.expanded].slice(0, MAX_EXPANDED);
  const active =
    snap.active && openSet.has(snap.active) ? snap.active : openPaths[0] ?? null;

  return {
    root: snap.root,
    expanded,
    open: openPaths,
    active,
    viewModes,
    drafts,
    treeModes,
    // Omitted when default to keep the current record compact.
    ...(sameSort(snap.sort, DEFAULT_SORT) ? {} : { sort: { ...snap.sort } }),
  };
}

/**
 * The payload for a snapshot, plus the paths whose drafts were too big to
 * store — the caller logs those, because a draft silently not surviving a
 * restart would be a lie the user only discovers after losing the work.
 */
export function buildFilesSession(snap: FilesSnapshot): {
  state: FilesSessionState;
  skippedDrafts: string[];
} {
  const panes = snap.panes.slice(0, 2);
  const skippedDrafts: string[] = [];
  const budget = { left: MAX_DRAFTS_BYTES };
  const stored = panes.map((p) => buildPane(p, budget, skippedDrafts));
  const state: FilesSessionState = {
    v: 1,
    showDiff: snap.showDiff,
    term: {
      open: snap.term.open,
      // Stored already legal, so a restore never has to reason about a
      // height that a dragged pixel count or an edited file made absurd.
      height: clampPanelHeight(snap.term.height),
      cwd: snap.term.cwd,
    },
    panes: stored,
    layout: snap.layout,
    activePane: stored.length === 2 && snap.activePane === 1 ? 1 : 0,
    panelMode: snap.panelMode,
  };
  return { state, skippedDrafts };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isCurrentPane(raw: unknown): raw is Record<string, unknown> {
  if (
    !isRecord(raw) ||
    typeof raw.root !== "string" ||
    !isStringArray(raw.expanded) ||
    raw.expanded.length > MAX_EXPANDED ||
    !isStringArray(raw.open) ||
    !isRecord(raw.viewModes) ||
    !isRecord(raw.drafts) ||
    !isRecord(raw.treeModes) ||
    Object.keys(raw.treeModes).length > MAX_TREE_MODES ||
    !(raw.active === null || typeof raw.active === "string")
  ) return false;
  const open = new Set(raw.open);
  if (raw.active !== null && !open.has(raw.active)) return false;
  if (
    Object.entries(raw.viewModes).some(
      ([path, mode]) => typeof mode !== "string" || !open.has(path)
    ) ||
    Object.entries(raw.treeModes).some(
      ([, mode]) => mode !== "miller" && mode !== "tree"
    ) ||
    Object.entries(raw.drafts).some(
      ([path, draft]) =>
        !open.has(path) ||
        !isRecord(draft) ||
        typeof draft.text !== "string" ||
        !(draft.modified === null ||
          (typeof draft.modified === "number" && Number.isFinite(draft.modified)))
    )
  ) return false;
  if (!("sort" in raw)) return true;
  return (
    isRecord(raw.sort) &&
    SORT_KEYS.includes(raw.sort.key as SortKey) &&
    typeof raw.sort.asc === "boolean" &&
    typeof raw.sort.dirsFirst === "boolean"
  );
}

/**
 * Validate and sanitize the current files-session representation.
 */
export function normalizeFilesState(raw: unknown): FilesSessionState | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== 1) return null;
  if (!Array.isArray(raw.panes) || raw.panes.length < 1 || raw.panes.length > 2) {
    return null;
  }
  if (
    typeof raw.showDiff !== "boolean" ||
    !isRecord(raw.term) ||
    typeof raw.term.open !== "boolean" ||
    typeof raw.term.height !== "number" ||
    typeof raw.term.cwd !== "string" ||
    (raw.layout !== "row" && raw.layout !== "column") ||
    (raw.activePane !== 0 && raw.activePane !== 1) ||
    (raw.panelMode !== "tree" &&
      raw.panelMode !== "search" &&
      raw.panelMode !== "changes")
  ) {
    return null;
  }
  if (
    !raw.panes.every(isCurrentPane) ||
    (raw.activePane === 1 && raw.panes.length !== 2)
  ) return null;
  const panes = raw.panes.map((pane) =>
    isRecord(pane) ? normalizePaneFields(pane) : null
  );
  if (panes.some((pane) => pane === null)) return null;
  const state: FilesSessionState = {
    v: 1,
    showDiff: raw.showDiff,
    term: normalizeTermPanel(raw.term),
    panes: panes as StoredPane[],
    layout: raw.layout,
    activePane: raw.activePane === 1 && panes.length === 2 ? 1 : 0,
    panelMode: raw.panelMode,
  };
  return state;
}

function normalizePaneFields(raw: Record<string, unknown>): StoredPane {
  const open = strings(raw.open);
  const openSet = new Set(open);

  const viewModes: Record<string, string> = {};
  if (isRecord(raw.viewModes)) {
    for (const [path, mode] of Object.entries(raw.viewModes)) {
      if (typeof mode === "string" && openSet.has(path)) viewModes[path] = mode;
    }
  }

  const drafts: Record<string, StoredDraft> = {};
  if (isRecord(raw.drafts)) {
    for (const [path, d] of Object.entries(raw.drafts)) {
      if (!isRecord(d) || typeof d.text !== "string") continue;
      const modified =
        typeof d.modified === "number" && Number.isFinite(d.modified)
          ? d.modified
          : null;
      drafts[path] = { text: d.text, modified };
    }
  }

  const treeModes: Record<string, string> = {};
  if (isRecord(raw.treeModes)) {
    let kept = 0;
    for (const [root, mode] of Object.entries(raw.treeModes)) {
      if (kept >= MAX_TREE_MODES) break;
      if (mode === "miller" || mode === "tree") {
        treeModes[root] = mode;
        kept++;
      }
    }
  }

  const active = typeof raw.active === "string" ? raw.active : null;
  const sort = normalizeSort(raw.sort);
  return {
    root: typeof raw.root === "string" ? raw.root : "",
    expanded: strings(raw.expanded),
    open,
    active: active && openSet.has(active) ? active : open[0] ?? null,
    viewModes,
    drafts,
    treeModes,
    // Absent when default; the reader always fills a value in.
    ...(sameSort(sort, DEFAULT_SORT) ? {} : { sort }),
  };
}

export function storedPanes(s: FilesSessionState): StoredPane[] {
  return s.panes;
}

/**
 * The remembered ordering, normalized field by field.
 */
function normalizeSort(raw: unknown): StoredSort {
  const r = isRecord(raw) ? raw : {};
  const key = SORT_KEYS.includes(r.key as SortKey) ? (r.key as SortKey) : DEFAULT_SORT.key;
  return {
    key,
    asc: r.asc === false ? false : true,
    dirsFirst: r.dirsFirst === false ? false : true,
  };
}

/**
 * The terminal panel's remembered state, normalized field by field.
 */
function normalizeTermPanel(raw: unknown): StoredTermPanel {
  const r = isRecord(raw) ? raw : {};
  return {
    open: r.open === true,
    height: clampPanelHeight(
      typeof r.height === "number" ? r.height : Number.NaN
    ),
    cwd: typeof r.cwd === "string" ? r.cwd : "",
  };
}

/**
 * The workspace minus everything that no longer exists. Files move between
 * sessions; a restore that half-fails must still open, so a path nobody could
 * read just disappears — and the active tab moves to a survivor rather than
 * pointing at a file that is not there.
 */
export function pruneWorkspace(
  pane: Pick<StoredPane, "open" | "active" | "viewModes">,
  alive: ReadonlySet<string>
): { open: string[]; active: string | null; viewModes: Map<string, string> } {
  const open = pane.open.filter((p) => alive.has(p));
  const openSet = new Set(open);
  const viewModes = new Map<string, string>();
  for (const [path, mode] of Object.entries(pane.viewModes)) {
    if (openSet.has(path)) viewModes.set(path, mode);
  }
  const active =
    pane.active && openSet.has(pane.active)
      ? pane.active
      : open[0] ?? null;
  return { open, active, viewModes };
}

export function mtimeUnchanged(
  knownAt: number | null,
  onDiskNow: number | null
): boolean {
  return knownAt !== null && onDiskNow !== null && knownAt === onDiskNow;
}

export type DraftOutcome =
  /** Disk is untouched: bring the draft back with its dirty mark, silently. */
  | { kind: "restore"; path: string; text: string }
  /** Disk moved under the draft: keep both and let the user decide. */
  | { kind: "conflict"; path: string; text: string; disk: string }
  | {
      kind: "drop";
      path: string;
      /** gone: no such file · unsavable: writing back is refused ·
       *  identical: the draft is what the file already contains. */
      reason: "gone" | "unsavable" | "identical";
    };

/**
 * What to do with one stored draft, given the file as it is on disk now
 * (null when it could not be read). The rule that matters is the last one: an
 * mtime we cannot prove unchanged counts as changed, because restoring a
 * draft over someone else's edit destroys work that was never ours.
 */
export function decideDraft(
  path: string,
  draft: StoredDraft,
  file: SessionFile | null
): DraftOutcome {
  if (!file) return { kind: "drop", path, reason: "gone" };
  if (file.readOnlyReason) return { kind: "drop", path, reason: "unsavable" };
  const disk = file.text;
  // A file that no longer reads as text has no draft to go back into.
  if (disk === null) return { kind: "drop", path, reason: "unsavable" };
  if (draft.text === disk) return { kind: "drop", path, reason: "identical" };
  const unchanged = mtimeUnchanged(draft.modified, file.modified);
  return unchanged
    ? { kind: "restore", path, text: draft.text }
    : { kind: "conflict", path, text: draft.text, disk };
}
