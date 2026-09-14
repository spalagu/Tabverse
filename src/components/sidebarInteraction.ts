export const TAB_MIME = "text/tabverse-tab";
export const TABS_MIME = "text/tabverse-tabs";
export const GROUP_MIME = "text/tabverse-group";

export function draggedIds(data: DataTransfer | null): string[] {
  if (!data) return [];
  try {
    const ids: unknown = JSON.parse(data.getData(TABS_MIME));
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0)) return [...new Set<string>(ids)];
  } catch { /* A single tab is a supported payload too. */ }
  const id = data.getData(TAB_MIME);
  return id ? [id] : [];
}

/** §6: next sibling belongs to the target group, never the next raw-array group. */
export function tabPlacement(
  tabs: readonly { id: string; groupId: string | null }[], ids: readonly string[], targetId: string, after: boolean,
): { groupId: string | null; beforeId: string | null } | null {
  const target = tabs.find((t) => t.id === targetId);
  if (!target || ids.includes(targetId) || !tabs.some((t) => ids.includes(t.id))) return null;
  if (!after) return { groupId: target.groupId, beforeId: target.id };
  const siblings = tabs.filter((t) => t.groupId === target.groupId && !ids.includes(t.id));
  return { groupId: target.groupId, beforeId: siblings[siblings.findIndex((t) => t.id === targetId) + 1]?.id ?? null };
}

export function edgeScrollSpeed(y: number, top: number, bottom: number): number {
  const band = Math.min(40, (bottom - top) / 3);
  if (band <= 0 || y < top || y > bottom) return 0;
  if (y < top + band) return -Math.ceil(12 * (top + band - y) / band);
  if (y > bottom - band) return Math.ceil(12 * (y - bottom + band) / band);
  return 0;
}
