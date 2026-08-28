import { describe, expect, it } from "vitest";
import { upsert, ZOOM_MAX, type ZoomEntry } from "./zoomMemory";

describe("per-host zoom memory", () => {
  it("remembers a host's level", () => {
    const next = upsert([], "example.com", 1.3);
    expect(next).toEqual([{ host: "example.com", scale: 1.3 }]);
  });

  it("updating a host replaces its level and makes it most-recent", () => {
    const start: ZoomEntry[] = [
      { host: "a.com", scale: 1.1 },
      { host: "b.com", scale: 1.2 },
    ];
    const next = upsert(start, "a.com", 1.5);
    // One entry per host, and the updated one is now at the recent end.
    expect(next).toEqual([
      { host: "b.com", scale: 1.2 },
      { host: "a.com", scale: 1.5 },
    ]);
  });

  it("drops the oldest host once the cap is passed", () => {
    let entries: ZoomEntry[] = [];
    // Fill exactly to the cap, oldest first.
    for (let i = 0; i < ZOOM_MAX; i++) {
      entries = upsert(entries, `host${i}.com`, 1);
    }
    expect(entries).toHaveLength(ZOOM_MAX);
    expect(entries[0].host).toBe("host0.com");
    // One more host evicts the oldest, not any newer one.
    entries = upsert(entries, "newcomer.com", 2);
    expect(entries).toHaveLength(ZOOM_MAX);
    expect(entries.some((e) => e.host === "host0.com")).toBe(false);
    expect(entries[0].host).toBe("host1.com");
    expect(entries[entries.length - 1]).toEqual({
      host: "newcomer.com",
      scale: 2,
    });
  });

  it("re-touching an existing host near the cap keeps it from eviction", () => {
    let entries: ZoomEntry[] = [];
    for (let i = 0; i < ZOOM_MAX; i++) {
      entries = upsert(entries, `host${i}.com`, 1);
    }
    // Touch the oldest, moving it to the recent end.
    entries = upsert(entries, "host0.com", 1.4);
    // Now a new host evicts host1 (the new oldest), not the re-touched host0.
    entries = upsert(entries, "newcomer.com", 2);
    expect(entries.some((e) => e.host === "host0.com")).toBe(true);
    expect(entries.some((e) => e.host === "host1.com")).toBe(false);
  });
});
