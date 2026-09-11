import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native browser interaction while loading", () => {
  it("keeps the progress rail outside the native page and out of UI-plane overlays", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const plane = readFileSync(resolve(process.cwd(), "src/uiPlane.ts"), "utf8");
    const paneRule = styles.match(/\.browser-pane\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(paneRule).toMatch(/padding-top:\s*2px/);
    expect(plane).not.toContain('".browser-pane > .browser-progress"');
  });
});
