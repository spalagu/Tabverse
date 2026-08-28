import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_FONT_STEP,
  TERMINAL_FONT_STACK,
  applyTerminalFont,
  familyList,
  fontStackFor,
  resetTerminalFontForTest,
  setProfileFontFamilies,
  setTerminalFont,
  subscribeTerminalFont,
  terminalFont,
  xtermFontOptions,
  xtermLineHeight,
  type TerminalFont,
  type XtermFontTarget,
} from "./font";


const CHOSEN: TerminalFont = {
  family: "Fira Code",
  size: 17,
  lineHeightPercent: 150,
};

afterEach(() => resetTerminalFontForTest());

/** An xterm stand-in: the three options and nothing else. */
function fakeTerm(options: XtermFontTarget["options"] = {}): XtermFontTarget {
  return { options };
}

describe("the shipped stack", () => {
  it("names Cascadia Code, the cut that has the ligatures", () => {
    // Cascadia Mono is the same typeface with the programming ligatures
    // removed, and naming it asked every Windows machine for the lesser one.
    expect(TERMINAL_FONT_STACK).toContain('"Cascadia Code"');
    expect(TERMINAL_FONT_STACK).not.toContain('"Cascadia Mono"');
  });
});

describe("the family the user names", () => {
  it("goes in front of the shipped stack, never instead of it", () => {
    const stack = fontStackFor("Fira Code");
    expect(stack.startsWith('"Fira Code", ')).toBe(true);
    // The icon font is why this matters: it is range-limited to the Private
    // Use Area, so it is the only source of the separators and glyphs a
    // starship or powerlevel10k prompt draws. A family that REPLACED the
    // stack would turn every one of them into a tofu box.
    expect(stack).toContain('"Tabverse Symbols"');
    expect(stack).toContain(TERMINAL_FONT_STACK);
  });

  it("is the shipped stack exactly when nothing is set", () => {
    expect(fontStackFor("")).toBe(TERMINAL_FONT_STACK);
    expect(fontStackFor("   ")).toBe(TERMINAL_FONT_STACK);
  });

  it("keeps several families in the order they were written", () => {
    expect(familyList('Fira Code, "JetBrains Mono" ,  ')).toEqual([
      "Fira Code",
      "JetBrains Mono",
    ]);
    const stack = fontStackFor('Fira Code, "JetBrains Mono"');
    expect(stack.indexOf('"Fira Code"')).toBeLessThan(
      stack.indexOf('"JetBrains Mono"')
    );
    expect(stack.indexOf('"JetBrains Mono"')).toBeLessThan(
      stack.indexOf('"Tabverse Symbols"')
    );
  });

  it("cannot carry a quote out of the file and into the stylesheet", () => {
    // A family name goes into a CSS font shorthand. A value carrying its own
    // quote could close the name early and leave the rest of the line to be
    // read as something else, so the quotes are stripped and the name is
    // quoted exactly once — whatever nonsense is inside stays inside.
    const stack = fontStackFor('Evil", monospace; x: y');
    // Only the user's own families are judged here, so this says one thing
    // and stays quiet about where the shipped stack goes.
    expect(stack.split(", ").slice(0, 2)).toEqual([
      '"Evil"',
      '"monospace; x: y"',
    ]);
    expect((stack.match(/"/g) ?? []).length % 2).toBe(0);
  });
});

describe("what xterm is told", () => {
  it("is nothing at all while the file has not been read", () => {
    // Not a size of this module's choosing: null means "not read yet", and
    // a caller that met one leaves the option off rather than inventing a
    // number the user never chose.
    expect(xtermFontOptions(null)).toBeNull();
    expect(terminalFont()).toBeNull();
  });

  it("turns the file's percentage into xterm's multiplier", () => {
    expect(xtermLineHeight(150)).toBe(1.5);
    expect(xtermFontOptions(CHOSEN)?.lineHeight).toBe(1.5);
  });

  it("draws the file panel one point below the tab, whatever the size", () => {
    // The panel shipped at 12 against the tab's 13 and keeps that relation
    // by following the user's size, not by holding a size of its own.
    const tab = xtermFontOptions(CHOSEN);
    const panel = xtermFontOptions(CHOSEN, PANEL_FONT_STEP);
    expect(panel?.fontSize).toBe((tab?.fontSize ?? 0) - 1);
    expect(panel?.fontFamily).toBe(tab?.fontFamily);
    expect(panel?.lineHeight).toBe(tab?.lineHeight);
  });

  it("never hands xterm a size it would divide by", () => {
    const tiny = xtermFontOptions({ ...CHOSEN, size: 1 }, PANEL_FONT_STEP);
    expect(tiny?.fontSize).toBeGreaterThan(0);
  });
});

describe("applying a font to a terminal that is already open", () => {
  it("moves the three options and says that it did", () => {
    const term = fakeTerm();
    expect(applyTerminalFont(term, CHOSEN)).toBe(true);
    expect(term.options.fontSize).toBe(17);
    expect(term.options.lineHeight).toBe(1.5);
    expect(term.options.fontFamily).toContain('"Fira Code"');
  });

  it("says nothing moved when nothing moved", () => {
    // What keeps a re-measure — and with it a resize of the shell — from
    // being scheduled for a change that did not happen, including the one
    // at mount, where the instance was built from these very values.
    const term = fakeTerm();
    applyTerminalFont(term, CHOSEN);
    expect(applyTerminalFont(term, CHOSEN)).toBe(false);
  });

  it("leaves a terminal alone while the file has not been read", () => {
    const term = fakeTerm({ fontSize: 9 });
    expect(applyTerminalFont(term, null)).toBe(false);
    expect(term.options.fontSize).toBe(9);
  });
});

describe("the per-profile family", () => {
  it("overrides the family for that profile and nobody else", () => {
    setTerminalFont(CHOSEN);
    setProfileFontFamilies({ Deploy: "IBM Plex Mono" });
    expect(terminalFont("Deploy")?.family).toBe("IBM Plex Mono");
    expect(terminalFont("Other")?.family).toBe(CHOSEN.family);
    expect(terminalFont()?.family).toBe(CHOSEN.family);
  });

  it("takes the size and the spacing from the global setting", () => {
    // `[[terminal.profiles]]` carries a `font`, which is a family. Inventing
    // two more fields here would be this module deciding the file format.
    setTerminalFont(CHOSEN);
    setProfileFontFamilies({ Deploy: "IBM Plex Mono" });
    expect(terminalFont("Deploy")?.size).toBe(CHOSEN.size);
    expect(terminalFont("Deploy")?.lineHeightPercent).toBe(
      CHOSEN.lineHeightPercent
    );
  });

  it("falls back to the global family when the profile names none", () => {
    setTerminalFont(CHOSEN);
    setProfileFontFamilies({ Deploy: "  " });
    expect(terminalFont("Deploy")?.family).toBe(CHOSEN.family);
  });
});

describe("the live channel", () => {
  it("tells a subscriber where things stand the moment it subscribes", () => {
    // A terminal that mounted before the file was read would otherwise wait
    // for the NEXT change to pick up the values it was born too early for.
    setTerminalFont(CHOSEN);
    const heard = vi.fn();
    subscribeTerminalFont(heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("tells every subscriber about a change, and stops when they leave", () => {
    const heard = vi.fn();
    const stop = subscribeTerminalFont(heard);
    heard.mockClear();
    setTerminalFont(CHOSEN);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    setTerminalFont({ ...CHOSEN, size: 20 });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("announces a profile's font as well as the global one", () => {
    const heard = vi.fn();
    subscribeTerminalFont(heard);
    heard.mockClear();
    setProfileFontFamilies({ Deploy: "IBM Plex Mono" });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
