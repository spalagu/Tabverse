import { describe, expect, it } from "vitest";
import { TAB_TYPES } from "@tabverse/runtime-contracts";
import { BUILT_IN_FEATURE_MODULES, defineBuiltInFeatureModules } from "./featureModules";

describe("V3 built-in feature modules", () => {
  it("accounts for every portable TabType exactly once", () => {
    const kinds = BUILT_IN_FEATURE_MODULES.map((module) => module.kind);
    expect(new Set(kinds)).toEqual(new Set(TAB_TYPES));
    expect(kinds).toHaveLength(TAB_TYPES.length);
  });

  it("rejects duplicate feature kinds", () => {
    expect(() =>
      defineBuiltInFeatureModules([
        { kind: "files", label: "Files", hint: "first", closeBehavior: "close" },
        { kind: "files", label: "Files again", hint: "second", closeBehavior: "close" },
      ]),
    ).toThrow("Duplicate built-in feature module: files");
  });

  it("keeps lifecycle intent explicit for execution-backed features", () => {
    const byKind = new Map(BUILT_IN_FEATURE_MODULES.map((module) => [module.kind, module]));
    expect(byKind.get("terminal")?.closeBehavior).toBe("stop-runtime");
    expect(byKind.get("agent")?.closeBehavior).toBe("ask");
  });
});
