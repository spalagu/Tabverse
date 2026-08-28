import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";


const FILES = [
  "src/components/UserScriptsSection.tsx",
  "src/components/UserscriptUpdateDialog.tsx",
] as const;

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("userscript updates stay manual", () => {
  it("has no timer of any kind in the update UI", () => {
    for (const file of FILES) {
      const src = source(file);
      for (const timer of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
        expect(
          src.includes(timer),
          `${file} schedules work with ${timer} — update checks must have no clock`
        ).toBe(false);
      }
    }
  });

  it("starts a check only from a click, never from an effect", () => {
    // The check invoke must not appear inside any useEffect — that is the
    // shape every "check on mount / on focus / on state change" takes.
    // Each effect is taken up to its dependency array (`}, [`), the close
    // of the call every effect in these files ends with.
    for (const file of FILES) {
      const src = source(file);
      const effects = src.split("useEffect(").slice(1);
      for (const rest of effects) {
        const end = rest.search(/\n\s*\}, \[/);
        const effect = end === -1 ? rest : rest.slice(0, end);
        expect(
          effect.includes("userscript_check_update"),
          `${file} runs an update check inside a useEffect — the Check button is the only starter`
        ).toBe(false);
      }
    }
  });
});
