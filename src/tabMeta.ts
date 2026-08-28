import type { Tab } from "./state/store";


/** A path as shown to a human: the home directory folds to "~". */
export function shortPath(dir: string): string {
  // The home directory itself has no trailing segment to keep, which an
  // index-based slice turns into a stray letter ("~u") instead of "~".
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(dir);
  return m ? "~" + (m[1] ?? "") : dir;
}

export function tabSubtitle(tab: Tab): string {
  if (tab.type === "files" || tab.type === "terminal") {
    const dir = tab.cwd ?? "";
    if (!dir) return "";
    const shown = shortPath(dir);
    if (tab.type !== "files") return shown;
    // A files tab's title is already the last segment, so what is worth
    // showing is where that segment lives.
    const parent = shown.replace(/\/[^/]*$/, "");
    return parent === "" ? "/" : parent;
  }
  if (tab.type === "browser" && tab.url) {
    try {
      return new URL(tab.url).host;
    } catch {
      return "";
    }
  }
  return "";
}
