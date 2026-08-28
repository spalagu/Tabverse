import { describe, expect, it } from "vitest";
import {
  applyLocationCompletion,
  completeLocationDirectories,
  locationSegmentCandidates,
  normalizeLocationPath,
  resolveLocationInput,
} from "./LocationBar";

describe("location bar path rules", () => {
  it("normalizes relative segments and preserves home-relative paths", () => {
    expect(normalizeLocationPath("/work/./src/../docs")).toBe("/work/docs");
    expect(resolveLocationInput("src/../docs", "/work")).toBe("/work/docs");
    expect(resolveLocationInput("~/code", "/work")).toBe("~/code");
  });

  it("finds and applies directory completions", () => {
    expect(locationSegmentCandidates("/work/s", "/other")).toEqual({
      dir: "/work",
      partial: "s",
    });
    const entries = [
      { name: "src", path: "/work/src", isDir: true },
      { name: "spec", path: "/work/spec", isDir: true },
      { name: "story.md", path: "/work/story.md", isDir: false },
    ];
    expect(completeLocationDirectories(entries, "S")).toHaveLength(2);
    expect(applyLocationCompletion("/work/s", "src", true)).toBe(
      "/work/src/"
    );
  });
});
