import { describe, expect, it } from "vitest";
import { collapseRepeatedSlashes, trimTrailingSlashes } from "./pathStrings";

describe("path string normalization", () => {
  it("removes only trailing separators", () => {
    expect(trimTrailingSlashes("/work///")).toBe("/work");
    expect(trimTrailingSlashes("/work/a")).toBe("/work/a");
    expect(trimTrailingSlashes("////")).toBe("");
  });

  it("collapses repeated separators in one linear pass", () => {
    const repeated = "/".repeat(100_000);
    expect(collapseRepeatedSlashes(`~${repeated}work${repeated}src`)).toBe(
      "~/work/src"
    );
  });
});
