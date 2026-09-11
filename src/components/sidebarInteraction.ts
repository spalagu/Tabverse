/** Pure sidebar gesture rules. No session or native-webview side effects. */
export type TabDropIntent = "before" | "after" | "split-left" | "split-right";
export const SPLIT_DWELL_MS = 450;
export const TAB_MIME = "text/tabverse-tab";
export const TABS_MIME = "text/tabverse-tabs";
export const GROUP_MIME = "text/tabverse-group";

export function draggedIds(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const many = dt.getData(TABS_MIME);
  if (many) {
    try {
      const ids: unknown = JSON.parse(many);
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0)) {
        return [...new Set<string>(ids)];
      }
    } catch { /* Fall back to the single-tab payload. */ }
  }
  const one = dt.getData(TAB_MIME);
  return one ? [one] : [];
}

export function splitCandidate(x: number, y: number): "left" | "right" | null {
  return y > 0.28 && y < 0.72 ? (x < 0.5 ? "left" : "right") : null;
}

export function tabDropIntent(
  x: number,
  y: number,
  armed: "left" | "right" | null,
): TabDropIntent {
  const candidate = splitCandidate(x, y);
  return armed !== null && candidate === armed ? `split-${armed}` : y < 0.5 ? "before" : "after";
}

/** A successor must belong to the TARGET folder, not the next raw-array
 * entry: moveTabs adopts its successor's group. Self-drops are a no-op. */
export function tabDropPlacement(
  tabs: readonly { id: string; groupId: string | null }[],
  ids: readonly string[],
  targetId: string,
  edge: "before" | "after",
): { groupId: string | null; beforeId: string | null } | null {
  const target = tabs.find((tab) => tab.id === targetId);
  if (!target || ids.includes(targetId) || !tabs.some((tab) => ids.includes(tab.id))) return null;
  if (edge === "before") return { groupId: target.groupId, beforeId: targetId };
  const siblings = tabs.filter((tab) => tab.groupId === target.groupId && !ids.includes(tab.id));
  const next = siblings[siblings.findIndex((tab) => tab.id === targetId) + 1];
  return { groupId: target.groupId, beforeId: next?.id ?? null };
}

export function edgeScrollSpeed(clientY: number, top: number, bottom: number): number {
  const band = Math.min(40, (bottom - top) / 3);
  if (band <= 0 || clientY < top || clientY > bottom) return 0;
  if (clientY < top + band) return -Math.ceil(12 * (top + band - clientY) / band);
  if (clientY > bottom - band) return Math.ceil(12 * (clientY - bottom + band) / band);
  return 0;
}

export const SIDEBAR_UX = {
  tabs: "Workspace tabs",
  rename: "Rename tab",
  reset: "Return to pinned page",
  deviation: "Away from its pinned page — use Return to pinned page to reset",
  splitLeft: "Release to split on the left",
  splitRight: "Release to split on the right",
  moveBefore: "Release to move before",
  moveAfter: "Release to move after",
} as const;
