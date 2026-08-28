
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
  /** Payload version, so a future shape change can be recognized, not eaten. */
  v: 1;
  /**
   * The single-pane shape, unchanged since the first payload. When two
   * panes exist these mirror pane 0 and `panes` below carries the real
   * pair; when they do not exist, these ARE the workspace. Keeping the
   * mirror costs one small copy and buys the compatibility rule outright:
   * a payload written by any earlier version of this app restores here
   * with nothing dropped and nothing reinterpreted.
   */
  root: string;
  expanded: string[];
  open: string[];
  active: string | null;
  /** path → "preview" | "split" | "source"; absent means the default. */
  viewModes: Record<string, string>;
  showDiff: boolean;
  drafts: Record<string, StoredDraft>;
  /**
   * Added after the first shipped payload, and on purpose NOT behind a
   * version bump: `v` is what tells a payload apart from one this code cannot
   * read, and raising it would make every workspace saved before the terminal
   * panel existed unreadable — the user would lose their open files to gain a
   * closed panel. A field that can be defaulted is not a shape change.
   */
  term: StoredTermPanel;
  sort?: StoredSort;
  treeModes?: Record<string, string>;
  panes?: StoredPane[];
  layout?: PaneLayout;
  /** Which pane was in front; meaningful only with two. */
  activePane?: number;
  panelMode?: FilesPanelMode;
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
    // Omitted when default, so a pane that never touched the option is
    // byte-identical to one written before the option existed.
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
  const first = stored[0];

  const state: FilesSessionState = {
    v: 1,
    // The single-pane shape always describes pane 0, so the oldest reader
    // of this payload (and the compat rule) sees a complete workspace.
    root: first.root,
    expanded: first.expanded,
    open: first.open,
    active: first.active,
    viewModes: first.viewModes,
    showDiff: snap.showDiff,
    drafts: first.drafts,
    term: {
      open: snap.term.open,
      // Stored already legal, so a restore never has to reason about a
      // height that a dragged pixel count or an edited file made absurd.
      height: clampPanelHeight(snap.term.height),
      cwd: snap.term.cwd,
    },
  };
  if (first.sort) state.sort = first.sort;
  if (Object.keys(first.treeModes).length > 0) state.treeModes = first.treeModes;
  // Written only when it differs from the default, like every other
  // defaultable field: a tab that left the tree showing is byte-identical
  // to one written before panels could be remembered.
  if (snap.panelMode !== "tree") state.panelMode = snap.panelMode;
  // One pane: no `panes` at all — the payload is the shape it always was.
  // Two: the pair, the arrangement, and which one was in front.
  if (stored.length === 2) {
    state.panes = stored;
    state.layout = snap.layout;
    state.activePane = snap.activePane === 1 ? 1 : 0;
  }
  return { state, skippedDrafts };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Turn whatever came back from storage into a state we are willing to act on.
 * A payload written by another version, hand-edited, or half-corrupt must not
 * throw its way into the mount path — anything unrecognizable is simply a
 * fresh start, and anything partly usable keeps the parts that are.
 */
export function normalizeFilesState(raw: unknown): FilesSessionState | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== 1) return null;
  const top = normalizePaneFields(raw);
  const state: FilesSessionState = {
    v: 1,
    showDiff: raw.showDiff !== false,
    term: normalizeTermPanel(raw.term),
    root: top.root,
    expanded: top.expanded,
    open: top.open,
    active: top.active,
    viewModes: top.viewModes,
    drafts: top.drafts,
  };
  if (top.sort) state.sort = top.sort;
  state.panelMode =
    raw.panelMode === "search" || raw.panelMode === "changes"
      ? raw.panelMode
      : "tree";
  // The dual-pane extension: only a real pair counts. One stored pane, a
  // truncated array or junk falls back to the single-pane shape above —
  // a pane set that half-loaded would silently lose a window's files.
  if (Array.isArray(raw.panes) && raw.panes.length === 2) {
    const second = isRecord(raw.panes[1]) ? normalizePaneFields(raw.panes[1]) : null;
    if (second) {
      state.panes = [top, second];
      state.layout = raw.layout === "column" ? "column" : "row";
      state.activePane = raw.activePane === 1 ? 1 : 0;
    }
  }
  return state;
}

/**
 * One pane's fields out of whatever record holds them — the SAME reader for
 * the legacy top level and for an entry of `panes`, because they describe
 * the same thing. That is the compat rule made mechanical: a payload with no
 * `panes` parses its one pane through the very code path a stored pair uses.
 */
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

/**
 * The panes a restore actually replays: the stored pair when there is one,
 * else the legacy single-pane shape as a one-element list. Callers never
 * reason about "which shape is this" — that decision lives here.
 */
export function storedPanes(s: FilesSessionState): StoredPane[] {
  return s.panes ?? [
    {
      root: s.root,
      expanded: s.expanded,
      open: s.open,
      active: s.active,
      viewModes: s.viewModes,
      drafts: s.drafts,
      treeModes: s.treeModes ?? {},
      sort: s.sort,
    },
  ];
}

/**
 * The remembered ordering, or the default for a payload written before the
 * option existed. Anything half-recognizable falls back field by field, the
 * same tolerance every other optional field shows a hand-edited payload.
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
 * The terminal panel's remembered state, or the state a tab that never had
 * one starts in. Every field defaults on its own: a workspace written before
 * the panel existed has no `term` at all, and must still restore its files.
 * Closed is the right default for an absent field — a panel nobody asked for
 * must not appear on its own after an update.
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
