import { trimTrailingSlashes } from "./pathStrings";

/**
 * What a close action from the editor tab strip takes with it, and how the
 * loss is described before it happens.
 *
 * This is deliberately free of React and of the filesystem: which tabs go is
 * an ordering question over the strip, and the only interesting part — "does
 * this take unsaved work with it, and whose" — has to be answerable without
 * opening the app.
 */

/** Close scopes offered by the editor tab context menu. */
export type CloseMode = "this" | "others" | "right" | "all";

/** Anything with a path: FileMeta in the app, a bare object in a test. */
interface HasPath {
  path: string;
}

/**
 * The paths a close action removes, in strip order.
 *
 * A target that is not in the strip closes nothing except under "all", which
 * is about the strip rather than about the clicked tab — the alternative,
 * guessing at where a vanished tab used to sit, would close the wrong files.
 */
export function tabsToClose(
  open: readonly HasPath[],
  target: string,
  mode: CloseMode
): string[] {
  const paths = open.map((f) => f.path);
  if (mode === "all") return paths;
  const at = paths.indexOf(target);
  if (at < 0) return [];
  switch (mode) {
    case "this":
      return [target];
    case "others":
      return paths.filter((p) => p !== target);
    case "right":
      return paths.slice(at + 1);
  }
}

/** The subset that would lose unsaved work, in the order it was given. */
export function dirtyAmong(
  paths: readonly string[],
  isDirty: (path: string) => boolean
): string[] {
  return paths.filter((p) => isDirty(p));
}

/**
 * How a file reads against the tab's root: "src/App.tsx" rather than the
 * whole absolute path, which in a confirmation is mostly a wall of prefix.
 * A file outside the root keeps its absolute path — shortening it would name
 * a file that is not where the name says it is.
 */
export function relativePath(root: string, path: string): string {
  const base = trimTrailingSlashes(root);
  if (!base) return path;
  if (path === base) return path.split("/").pop() ?? path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** How many names a confirmation lists before it starts counting instead. */
const NAME_LIMIT = 6;

/**
 * The one question asked before unsaved work is thrown away.
 *
 * It names the files, because "3 files have unsaved changes" leaves the user
 * to guess whether the one they care about is among them — and the answer to
 * a guess is to cancel and close tabs one at a time, which is the feature
 * they were trying to avoid. Long lists are capped: past a handful the names
 * stop informing and a count is the honest summary.
 */
export function discardPrompt(
  names: readonly string[],
  limit = NAME_LIMIT
): string {
  if (names.length === 0) return "";
  if (names.length === 1) {
    return `${names[0]} has unsaved changes. Discard them?`;
  }
  const shown = names.slice(0, limit).map((n) => `• ${n}`);
  const rest = names.length - shown.length;
  if (rest > 0) shown.push(`• …and ${rest} more`);
  return [
    `Discard unsaved changes in ${names.length} files?`,
    "",
    ...shown,
    "",
    "Cancel closes nothing.",
  ].join("\n");
}
