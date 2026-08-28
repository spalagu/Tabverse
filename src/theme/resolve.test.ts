import { describe, expect, it } from "vitest";
import { asThemePreference, resolve } from "./resolve";

describe("resolve(preference, systemDark) — all 6 combinations", () => {
  it.each([
    ["system", true, "dark"],
    ["system", false, "light"],
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
  ] as const)("resolve(%s, %s) = %s", (pref, systemDark, want) => {
    expect(resolve(pref, systemDark)).toBe(want);
  });
});

describe("asThemePreference — the stored-value gate", () => {
  it.each(["system", "light", "dark"] as const)("passes %s through", (v) => {
    expect(asThemePreference(v)).toBe(v);
  });

  it.each([undefined, null, "", "auto", "DARK", 3, {}])(
    "falls back to system for %s — the same rule the Rust reader applies",
    (v) => {
      expect(asThemePreference(v)).toBe("system");
    }
  );
});
