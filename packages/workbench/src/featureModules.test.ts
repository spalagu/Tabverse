import { describe, expect, it } from "vitest";
import { TAB_TYPES } from "@tabverse/runtime-contracts";
import {
  BUILT_IN_FEATURE_MODULES,
  defineBuiltInFeatureModules,
  objectStateCodec,
} from "./featureModules";

describe("V3 built-in feature modules", () => {
  it("accounts for every portable TabType exactly once", () => {
    const kinds = BUILT_IN_FEATURE_MODULES.map((module) => module.kind);
    expect(new Set(kinds)).toEqual(new Set(TAB_TYPES));
    expect(kinds).toHaveLength(TAB_TYPES.length);
  });

  it("rejects duplicate feature kinds", () => {
    const state = objectStateCodec(1);
    expect(() =>
      defineBuiltInFeatureModules([
        { kind: "files", label: "Files", hint: "first", closeBehavior: "close", state },
        {
          kind: "files",
          label: "Files again",
          hint: "second",
          closeBehavior: "close",
          state,
        },
      ]),
    ).toThrow("Duplicate built-in feature module: files");
  });

  it("keeps lifecycle intent explicit for execution-backed features", () => {
    const byKind = new Map(BUILT_IN_FEATURE_MODULES.map((module) => [module.kind, module]));
    expect(byKind.get("terminal")?.closeBehavior).toBe("stop-runtime");
    expect(byKind.get("agent")?.closeBehavior).toBe("ask");
  });

  it("accepts only the current state version", () => {
    const codec = objectStateCodec(2);
    const future = { payload: ["unknown", 3] };
    expect(codec.decode(3, future)).toEqual({
      kind: "unsupported-version",
      version: 3,
      original: future,
    });
  });

  it("rejects malformed and old state without mutating it", () => {
    const old = { cwd: "/work" };
    expect(objectStateCodec(2).decode(1, old)).toEqual({
      kind: "unsupported-version",
      version: 1,
      original: old,
    });
    expect(objectStateCodec(1).decode(1, [])).toEqual({
      kind: "invalid",
      reason: "invalid-shape",
      original: [],
    });
  });
});
