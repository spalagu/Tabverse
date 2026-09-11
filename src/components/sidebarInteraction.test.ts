import { describe, expect, it } from "vitest";
import { draggedIds, edgeScrollSpeed, splitCandidate, tabDropIntent, tabDropPlacement } from "./sidebarInteraction";

const tabs = [
  { id: "a", groupId: "work" }, { id: "x", groupId: null },
  { id: "b", groupId: "work" }, { id: "c", groupId: "other" },
];

describe("sidebar drag placement", () => {
  it("inserts before or after the target within its own folder", () => {
    expect(tabDropPlacement(tabs, ["x"], "a", "before")).toEqual({ groupId: "work", beforeId: "a" });
    expect(tabDropPlacement(tabs, ["x"], "a", "after")).toEqual({ groupId: "work", beforeId: "b" });
    expect(tabDropPlacement(tabs, ["x"], "b", "after")).toEqual({ groupId: "work", beforeId: null });
  });
  it("skips moved siblings and never uses a different folder as successor", () => {
    expect(tabDropPlacement(tabs, ["b", "x"], "a", "after")).toEqual({ groupId: "work", beforeId: null });
    expect(tabDropPlacement(tabs, ["b"], "x", "after")).toEqual({ groupId: null, beforeId: null });
  });
  it("ignores self drops, selected targets, and stale IDs", () => {
    for (const edge of ["before", "after"] as const) {
      expect(tabDropPlacement(tabs, ["a"], "a", edge)).toBeNull();
      expect(tabDropPlacement(tabs, ["a", "b"], "b", edge)).toBeNull();
      expect(tabDropPlacement(tabs, ["missing"], "a", edge)).toBeNull();
      expect(tabDropPlacement(tabs, ["a"], "missing", edge)).toBeNull();
    }
  });
  it("reorders immediately, and only splits an armed middle-band drop", () => {
    expect(tabDropIntent(0.2, 0.1, null)).toBe("before");
    expect(tabDropIntent(0.2, 0.6, null)).toBe("after");
    expect(tabDropIntent(0.2, 0.6, "left")).toBe("split-left");
    expect(tabDropIntent(0.8, 0.6, "right")).toBe("split-right");
    expect(tabDropIntent(0.8, 0.6, "left")).toBe("after");
    expect(tabDropIntent(0.2, 0.9, "left")).toBe("after");
    expect(splitCandidate(0.2, 0.28)).toBeNull();
    expect(splitCandidate(0.8, 0.72)).toBeNull();
  });
  it("validates and deduplicates drag payloads with a single-ID fallback", () => {
    const data = (values: Record<string, string>) => ({ getData: (type: string) => values[type] ?? "" }) as DataTransfer;
    expect(draggedIds(null)).toEqual([]);
    expect(draggedIds(data({ "text/tabverse-tabs": '["a","a","b"]' }))).toEqual(["a", "b"]);
    expect(draggedIds(data({ "text/tabverse-tabs": '{broken', "text/tabverse-tab": "a" }))).toEqual(["a"]);
    expect(draggedIds(data({ "text/tabverse-tabs": '[4]', "text/tabverse-tab": "b" }))).toEqual(["b"]);
  });
  it("only scrolls near an inside edge, with bounded speed", () => {
    expect(edgeScrollSpeed(100, 100, 500)).toBe(-12);
    expect(edgeScrollSpeed(120, 100, 500)).toBe(-6);
    expect(edgeScrollSpeed(300, 100, 500)).toBe(0);
    expect(edgeScrollSpeed(500, 100, 500)).toBe(12);
    expect(edgeScrollSpeed(90, 100, 500)).toBe(0);
    expect(edgeScrollSpeed(510, 100, 500)).toBe(0);
    expect(edgeScrollSpeed(100, 100, 100)).toBe(0);
  });
});
