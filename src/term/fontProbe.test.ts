import { describe, expect, it } from "vitest";
import {
  ABSENT_FAMILY,
  CONTROL_ABSENT_FAMILY,
  PROBE_TEXT,
  createFontProbe,
  missingFamilies,
  type InkMeasurer,
} from "./fontProbe";


/** A canvas on a machine that has `installed` and nothing else. */
function machineWith(installed: readonly string[]): InkMeasurer {
  // Every generic is its own width, because a real platform's serif and
  // monospace are different faces — the probe checks that before it believes
  // anything, so a stand-in that got this wrong would report itself blind.
  const genericWidth: Record<string, number> = {
    serif: 100,
    "sans-serif": 108,
    monospace: 120,
  };
  // What an installed family draws in. Deliberately equal to `monospace`'s
  // width for one of them: that is the macOS trap this module exists to
  // survive — the generic `monospace` IS Menlo there, so a probe that
  // compared against monospace alone would call Menlo missing.
  const familyWidth: Record<string, number> = {
    Menlo: 120,
    "Fira Code": 133,
    "JetBrains Mono": 141,
  };
  return {
    font: "",
    measureText(text: string) {
      expect(text).toBe(PROBE_TEXT);
      // `48px "Family", generic` — the shape the probe writes.
      const m = /^\d+px (?:"([^"]*)", )?([a-z-]+)$/.exec(this.font);
      if (!m) throw new Error(`unreadable font shorthand: ${this.font}`);
      const [, family, generic] = m;
      const fallback = genericWidth[generic] ?? 0;
      if (family === undefined || !installed.includes(family)) {
        return { width: fallback };
      }
      return { width: familyWidth[family] ?? fallback };
    },
  };
}

describe("the ink probe", () => {
  it("tells an installed family from one that is only typed", () => {
    const probe = createFontProbe(machineWith(["Fira Code", "Menlo"]));
    expect(probe.blindness()).toBeNull();
    expect(probe.verdict("Fira Code")).toBe("available");
    expect(probe.verdict("JetBrains Mono")).toBe("missing");
  });

  it("sees a family whose width equals the monospace generic's", () => {
    // The whole reason there are three generics. Menlo measures exactly as
    // `monospace` does on this machine — which is what macOS really does —
    // and a monospace-only comparison would report it absent.
    const probe = createFontProbe(machineWith(["Menlo"]));
    expect(probe.verdict("Menlo")).toBe("available");
  });

  it("calls itself blind when every family measures the same", () => {
    // A headless canvas: one width for everything. Without this check the
    // probe would answer "missing" for every font in the world, and the
    // settings page would tell a user with Fira Code installed otherwise.
    const flat: InkMeasurer = {
      font: "",
      measureText: () => ({ width: 42 }),
    };
    const probe = createFontProbe(flat);
    expect(probe.blindness()).not.toBeNull();
    expect(probe.verdict("Fira Code")).toBe("unmeasurable");
    expect(probe.verdict("NoSuchThing")).toBe("unmeasurable");
  });

  it("calls itself blind when a name that cannot exist measures as present", () => {
    // Noise: widths that differ per call rather than per font. The generics
    // differ, so the first check passes and the sentinel is what catches it.
    let n = 0;
    const noisy: InkMeasurer = {
      font: "",
      measureText: () => ({ width: 100 + n++ }),
    };
    const probe = createFontProbe(noisy);
    expect(probe.blindness()).not.toBeNull();
  });

  it("is blind, not certain, without a canvas at all", () => {
    const probe = createFontProbe(null);
    expect(probe.blindness()).not.toBeNull();
    expect(probe.verdict("Menlo")).toBe("unmeasurable");
  });

  it("never claims the two impossible names are present", () => {
    const probe = createFontProbe(machineWith(["Menlo", "Fira Code"]));
    expect(probe.resolves(ABSENT_FAMILY)).toBe(false);
    expect(probe.resolves(CONTROL_ABSENT_FAMILY)).toBe(false);
  });

  it("reports which of several families are missing, in order", () => {
    const probe = createFontProbe(machineWith(["Menlo"]));
    const asked = ["Fira Code", "Menlo", "JetBrains Mono"];
    expect(asked.filter((f) => !probe.resolves(f))).toEqual([
      "Fira Code",
      "JetBrains Mono",
    ]);
  });
});

describe("missingFamilies, on a machine that cannot be asked", () => {
  it("answers null rather than 'they are all missing'", () => {
    // The test environment has no font machinery, which is precisely the
    // state the third verdict exists for: this must not come back as a list
    // naming every family as absent.
    expect(missingFamilies(["Menlo", "Fira Code"])).toBeNull();
  });
});
