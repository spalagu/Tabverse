import { describe, expect, it } from "vitest";
import { scopeTabId } from "../../persist";
import {
  SESSION_ENDED_LABEL,
  TERM_MEMORY_MAX_BYTES,
  TERM_SAVE_IDLE_MS,
  TERM_SAVE_MAX_MS,
  buildTermMemory,
  hasVisibleContent,
  nextSaveDelay,
  readTermMemory,
  restoreWrite,
  sessionSeparator,
  shouldWriteRestore,
  spawnCwd,
  stripTerminalEscapeSequences,
  termScope,
} from "./sessionMemory";

const TAB = "11111111-2222-4333-8444-555555555555";

/** What a shell's screen looks like once serialized: styles, text, CRLFs. */
const SCREEN = "\x1b[1;32m~ ❯\x1b[0m npm test\r\n104 passed\r\n";

describe("scope", () => {
  it("names the tab as its owner, in a form the doorway accepts", () => {
    const scope = termScope(TAB);
    expect(scope).toBe(`term:${TAB}`);
    // The doorway only reclaims a closed tab's files when it can read the
    // owner off the scope name; a scope it cannot parse would leak forever.
    expect(scopeTabId(scope)).toBe(TAB);
    expect(/^[A-Za-z0-9:_-]{1,120}$/.test(scope)).toBe(true);
  });
});

describe("what is worth persisting", () => {
  it("keeps a screen that shows something, with the directory", () => {
    const mem = buildTermMemory(SCREEN, "/Users/x/code");
    expect(mem).toEqual({ version: 1, screen: SCREEN, cwd: "/Users/x/code" });
  });

  it("persists nothing for a terminal that never printed", () => {
    // Cursor moves, styles and blank cells — a shell that produced no output.
    expect(buildTermMemory("", null)).toBeNull();
    expect(buildTermMemory("\x1b[H\x1b[2J", null)).toBeNull();
    expect(buildTermMemory("\x1b[0m   \r\n  \r\n", "/tmp")).toBeNull();
    expect(hasVisibleContent("\x1b]0;title\x07\x1b[1m\x1b[0m")).toBe(false);
  });

  it("scans long terminal control payloads without backtracking", () => {
    const repeatedOsc = `\x1b]0;${"[".repeat(100_000)}\x1b\\`;
    const repeatedCsi = `\x1b[${";".repeat(100_000)}m`;
    expect(stripTerminalEscapeSequences(`${repeatedOsc}${repeatedCsi}`)).toBe("");
    expect(hasVisibleContent(`${repeatedOsc}${repeatedCsi}ready`)).toBe(true);
  });

  it("drops the directory when the shell never reported one", () => {
    expect(buildTermMemory(SCREEN, null)).toEqual({
      version: 1,
      screen: SCREEN,
    });
    expect(buildTermMemory(SCREEN, "")?.cwd).toBeUndefined();
  });

  it("caps a huge screen by dropping the oldest lines, not by truncating", () => {
    const row = `\x1b[36m${"x".repeat(400)}\x1b[0m`;
    const huge = Array.from({ length: 2000 }, () => row).join("\r\n");
    expect(huge.length).toBeGreaterThan(TERM_MEMORY_MAX_BYTES);
    const mem = buildTermMemory(huge, null)!;
    expect(mem.screen.length).toBeLessThanOrEqual(TERM_MEMORY_MAX_BYTES + 4);
    // The newest lines are the ones kept, and no line is cut in half.
    expect(mem.screen.endsWith(row)).toBe(true);
    for (const line of mem.screen.replace(/^\x1b\[0m/, "").split("\r\n")) {
      expect(line).toBe(row);
    }
  });

  it("keeps the tail of one line that is longer than the whole budget", () => {
    const mem = buildTermMemory("y".repeat(TERM_MEMORY_MAX_BYTES * 2), null)!;
    expect(mem.screen.length).toBeLessThanOrEqual(TERM_MEMORY_MAX_BYTES + 4);
    expect(mem.screen.endsWith("y")).toBe(true);
  });
});

describe("reading stored memory back", () => {
  it("accepts what it wrote", () => {
    const mem = buildTermMemory(SCREEN, "/tmp");
    expect(readTermMemory(JSON.parse(JSON.stringify(mem)))).toEqual(mem);
  });

  it("returns null for anything unusable, so the tab just starts fresh", () => {
    expect(readTermMemory(null)).toBeNull();
    expect(readTermMemory("garbage")).toBeNull();
    expect(readTermMemory({ version: 2, screen: SCREEN })).toBeNull();
    expect(readTermMemory({ version: 1 })).toBeNull();
    expect(readTermMemory({ version: 1, screen: 42 })).toBeNull();
    expect(readTermMemory({ version: 1, screen: "\x1b[2J" })).toBeNull();
  });

  it("ignores a directory that is not a usable path", () => {
    expect(readTermMemory({ version: 1, screen: SCREEN, cwd: 7 })?.cwd)
      .toBeUndefined();
  });
});

describe("save cadence", () => {
  it("waits for output to settle in the quiet case", () => {
    const t = 10_000;
    expect(nextSaveDelay(t, t)).toBe(TERM_SAVE_IDLE_MS);
  });

  it("stops a never-quiet terminal from postponing the write forever", () => {
    const start = 10_000;
    // A `yes` keeps resetting the idle timer; the max-wait deadline takes over
    // and the write happens at a bounded rate instead of never.
    const late = start + TERM_SAVE_MAX_MS - 200;
    expect(nextSaveDelay(late, start)).toBe(200);
    expect(nextSaveDelay(start + TERM_SAVE_MAX_MS + 5_000, start)).toBe(0);
    // Whatever the burst does, no write is ever scheduled beyond the ceiling.
    for (let now = start; now <= start + TERM_SAVE_MAX_MS; now += 137) {
      expect(now + nextSaveDelay(now, start)).toBeLessThanOrEqual(
        start + TERM_SAVE_MAX_MS
      );
    }
  });
});

describe("the restore decision", () => {
  const mem = buildTermMemory(SCREEN, "/tmp");
  const gate = { disposed: false, outputSeen: false, alreadyWritten: false };

  it("writes history into a terminal the new shell has not printed to", () => {
    expect(shouldWriteRestore(mem, gate)).toBe(true);
  });

  it("drops a load that lands after the shell started printing", () => {
    // The shell is never held back for this load, so it can lose the race.
    // Interleaving a dead session's transcript into live output would read as
    // corruption; losing the transcript is the smaller harm.
    expect(shouldWriteRestore(mem, { ...gate, outputSeen: true })).toBe(false);
  });

  it("never writes twice, and never into a disposed pane", () => {
    expect(shouldWriteRestore(mem, { ...gate, alreadyWritten: true })).toBe(false);
    expect(shouldWriteRestore(mem, { ...gate, disposed: true })).toBe(false);
  });

  it("has nothing to write when there is no stored screen", () => {
    expect(shouldWriteRestore(null, gate)).toBe(false);
  });
});

describe("the boundary marker", () => {
  it("says the session ended, and that the text above is not live", () => {
    const sep = sessionSeparator(80);
    expect(sep).toContain(SESSION_ENDED_LABEL);
    expect(sep).toContain("not live");
  });

  it("fits the terminal it is drawn in", () => {
    for (const cols of [40, 80, 120, 200]) {
      const rule = sessionSeparator(cols)
        .split("\r\n")
        .find((l) => l.includes(SESSION_ENDED_LABEL))!;
      // eslint-disable-next-line no-control-regex
      const visible = rule.replace(/\x1b\[[0-9;?]*[@-~]/g, "");
      expect(visible.length).toBeLessThanOrEqual(cols);
    }
  });

  it("drops the explanation rather than wrapping in a narrow pane", () => {
    expect(sessionSeparator(40)).toContain(SESSION_ENDED_LABEL);
    expect(sessionSeparator(40)).not.toContain("not live");
  });

  it("puts the history above the marker and hands back a clean style", () => {
    const mem = buildTermMemory(SCREEN, "/tmp")!;
    const out = restoreWrite(mem, 80);
    expect(out.indexOf(SCREEN)).toBe(0);
    expect(out.indexOf(SESSION_ENDED_LABEL)).toBeGreaterThan(SCREEN.length);
    // The transcript can end mid-style or with the cursor hidden; the new
    // shell must not inherit either.
    expect(out).toContain("\x1b[?25h");
    expect(out.endsWith("\x1b[0m\r\n\r\n")).toBe(true);
  });
});

describe("where the next shell starts", () => {
  it("uses the tab's remembered directory", () => {
    expect(spawnCwd("/Users/x/code", "/tmp")).toBe("/Users/x/code");
  });

  it("falls back to the screen memory's copy, then to the shell default", () => {
    expect(spawnCwd(undefined, "/tmp")).toBe("/tmp");
    expect(spawnCwd(undefined, undefined)).toBeUndefined();
  });
});
