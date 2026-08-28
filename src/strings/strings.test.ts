import { describe, expect, it } from "vitest";
import { STR, plural } from "./index";

/** Collect every leaf path ("errors.actions.saveFile") and value. */
function leaves(
  obj: Record<string, unknown>,
  prefix = ""
): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      out.push(...leaves(value as Record<string, unknown>, path));
    } else {
      out.push({ path, value });
    }
  }
  return out;
}

describe("STR table shape", () => {
 it("keeps the ten fixed top-level domains", () => {
    expect(Object.keys(STR)).toEqual([
      "common",
      "term",
      "errors",
      "files",
      "browser",
      "remote",
      "settings",
      "share",
      "panels",
      "dialogs",
    ]);
  });

  it("has unique leaf paths and non-empty values", () => {
    const all = leaves(STR as unknown as Record<string, unknown>);
    const paths = all.map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const { path, value } of all) {
      const type = typeof value;
      expect(["string", "function"], `${path} must be copy`).toContain(type);
      if (type === "string") {
        expect((value as string).length, `${path} must not be empty`)
          .toBeGreaterThan(0);
      }
    }
  });

 it("keeps register rules over string values", () => {
    for (const { path, value } of leaves(
      STR as unknown as Record<string, unknown>
    )) {
      if (typeof value !== "string") continue;
      expect(value, `${path} must not shout`).not.toContain("!");
      expect(value, `${path} must use … not ...`).not.toContain("...");
    }
  });
});

describe("settings copy locks", () => {
  it("saved-passwords intro is the rewritten paragraph, verbatim", () => {
    // The snapshot of the fix. If someone edits the paragraph the change
    // must be deliberate — update this string together with the copy.
    expect(STR.settings.savedPasswordsIntro).toBe(
      "Logins live in the macOS Keychain, readable by this app only — " +
        "nothing about them, not even how many there are, is shown until the " +
        "authorization below opens the list. Import reads the comma-separated " +
        "file every other browser exports, and export writes that same shape, " +
        "so these logins can always be taken elsewhere."
    );
  });

  it("the broken sentence stays gone", () => {
    expect(STR.settings.savedPasswordsIntro).not.toContain(
      "Nothing about them is read on this page"
    );
    expect(STR.settings.savedPasswordsIntro).not.toMatch(/\. The\s+Nothing/);
  });
});

describe("plural helper", () => {
  it("counts with the right form", () => {
    expect(plural(1, "viewer")).toBe("1 viewer");
    expect(plural(3, "viewer")).toBe("3 viewers");
    expect(plural(0, "match", "matches")).toBe("0 matches");
  });
});
