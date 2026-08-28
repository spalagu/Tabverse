import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIGATURE_FONT_FAMILY, TERMINAL_FONT_STACK, fontStackFor } from "./font";


/** The stylesheet's own directory — every path below is resolved against it,
 * the way the bundler resolves the `url()`s inside it. */
const STYLES = resolve(process.cwd(), "src", "styles.css");
const CSS = readFileSync(STYLES, "utf8");

/** Every `@font-face { … }` block in the stylesheet, body text only. */
function fontFaceBlocks(): string[] {
  return [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
}

describe("the @font-face rules", () => {
  it("names files and never local()", () => {
    const blocks = fontFaceBlocks();
    expect(blocks.length, "the stylesheet declares fonts").toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block, "a @font-face reaching for an installed font").not.toContain(
        "local("
      );
      expect(block).toContain("url(");
    }
  });

  it("declares the family the terminal asks for, from a file that is here", () => {
    const family = LIGATURE_FONT_FAMILY.replace(/"/g, "");
    const block = fontFaceBlocks().find((b) => b.includes(family));
    expect(block, `no @font-face for ${family}`).toBeDefined();

    // The file the rule points at, resolved the way the bundler will resolve
    // it: relative to the stylesheet. A ligature switch whose font was left
    // out of the commit is a switch with nothing behind it, and that is a
    // thing this assertion notices and a running app does not.
    const url = /url\(\s*"([^"]+)"/.exec(block!)?.[1];
    expect(url, "the rule names no file").toBeDefined();
    const file = resolve(dirname(STYLES), url!);
    expect(existsSync(file), `${url} is not in the tree`).toBe(true);
    expect(statSync(file).size, `${url} is empty`).toBeGreaterThan(0);
  });
});

describe("the font stack a ligature terminal draws with", () => {
  it("leads with the bundled face and keeps everything that was there", () => {
    const stack = fontStackFor("Menlo", true);
    // In front, because the font that draws the text is the font that draws
    // the ligature. Behind Menlo — one of the two families that resolve at
    // all in the packaged product, and one with no ligatures — the switch
    // would be on with nothing to show.
    expect(stack.startsWith(`${LIGATURE_FONT_FAMILY}, `)).toBe(true);
    // In front of, not instead of: the icon font still supplies the Private
    // Use Area glyphs, and the family the user named still draws every
    // codepoint the ligature face does not carry.
    expect(stack).toContain('"Menlo"');
    expect(stack).toContain(TERMINAL_FONT_STACK);
  });

  it("leaves the stack alone when ligatures are off, and when nothing is said", () => {
    // The control. Without it, "the ligature face leads" would also be
    // satisfied by a stack that leads with it always.
    expect(fontStackFor("Menlo", false)).not.toContain(LIGATURE_FONT_FAMILY);
    expect(fontStackFor("Menlo")).not.toContain(LIGATURE_FONT_FAMILY);
    expect(fontStackFor("")).toBe(TERMINAL_FONT_STACK);
    // And with no family named, the bundled stack is what it leads.
    expect(fontStackFor("", true)).toBe(
      `${LIGATURE_FONT_FAMILY}, ${TERMINAL_FONT_STACK}`
    );
  });
});
