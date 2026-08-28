import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { BlockTracker } from "./blocks";

/**
 * A stub terminal just big enough for BlockTracker: OSC dispatch, markers
 * pinned to the cursor line, and a line buffer. No rendering, no engine.
 */
function stubTerm() {
  const osc = new Map<number, (data: string) => boolean>();
  const lines: { text: string; wrapped: boolean }[] = [];
  let cursor = 0;
  const term = {
    parser: {
      registerOscHandler(id: number, cb: (data: string) => boolean) {
        osc.set(id, cb);
        return { dispose() {} };
      },
    },
    registerMarker(offset = 0) {
      const m = {
        line: cursor + offset,
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      return m;
    },
    buffer: {
      active: {
        get baseY() {
          return 0;
        },
        get cursorY() {
          return cursor;
        },
        getLine(y: number) {
          const l = lines[y];
          if (!l) return undefined;
          return {
            isWrapped: l.wrapped,
            translateToString: () => l.text,
          };
        },
      },
    },
  };
  return {
    term: term as unknown as Terminal,
    osc: (id: number, data: string) => osc.get(id)!(data),
    setCursor: (c: number) => (cursor = c),
    putLine: (y: number, text: string, wrapped = false) =>
      (lines[y] = { text, wrapped }),
  };
}

const b64 = (s: string) => btoa(s);

describe("BlockTracker", () => {
  it("records the command from cmdline_b64 and the exit code from D", () => {
    const t = stubTerm();
    const finished: number[] = [];
    const tracker = new BlockTracker(t.term, {
      onFinished: (b) => finished.push(b.exitCode ?? -1),
    });
    t.osc(133, `C;cmdline_b64=${b64("echo hi")}`);
    t.setCursor(1);
    t.osc(133, "D;0");
    expect(tracker.blocks).toHaveLength(1);
    expect(tracker.blocks[0].command).toBe("echo hi");
    expect(tracker.blocks[0].exitCode).toBe(0);
    expect(finished).toEqual([0]);
  });

  it("copy-output stops one line above the end marker (the next prompt's line)", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    t.setCursor(0);
    t.osc(133, `C;cmdline_b64=${b64("ls")}`);
    t.putLine(0, "one");
    t.putLine(1, "two");
    t.putLine(2, "❯ next-prompt");
    t.setCursor(2); // prompt hook runs with the cursor on the prompt line
    t.osc(133, "D;0");
    expect(tracker.outputOf(tracker.blocks[0])).toBe("one\ntwo");
  });

  it("a command with no output yields an empty string, not the prompt", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    t.setCursor(5);
    t.osc(133, `C;cmdline_b64=${b64("true")}`);
    t.setCursor(5);
    t.osc(133, "D;0");
    expect(tracker.outputOf(tracker.blocks[0])).toBe("");
  });

  it("rejoins wrapped continuation rows into one logical line", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    t.setCursor(0);
    t.osc(133, `C;cmdline_b64=${b64("cat wide")}`);
    t.putLine(0, "AAAA");
    t.putLine(1, "BBBB", true); // continuation of line 0
    t.putLine(2, "CCCC");
    t.setCursor(3);
    t.osc(133, "D;0");
    expect(tracker.outputOf(tracker.blocks[0])).toBe("AAAABBBB\nCCCC");
  });

  it("a dead start marker means no output, no navigation, and pruning", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    t.osc(133, `C;cmdline_b64=${b64("old")}`);
    t.setCursor(1);
    t.osc(133, "D;0");
    (tracker.blocks[0].start as { line: number }).line = -1; // trimmed out
    expect(tracker.outputOf(tracker.blocks[0])).toBe("");
    expect(tracker.liveBlocks).toHaveLength(0);
    expect(tracker.pruneDead()).toBe(1);
    expect(tracker.blocks).toHaveLength(0);
  });

  it("keeps at most 500 blocks and disposes the trimmed ones", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    for (let i = 0; i < 505; i++) {
      t.osc(133, `C;cmdline_b64=${b64(`cmd${i}`)}`);
      t.osc(133, "D;0");
    }
    expect(tracker.blocks.length).toBe(500);
    expect(tracker.blocks[0].command).toBe("cmd5");
  });

  it("drops a second C while a block is still running (starship stacking)", () => {
    const t = stubTerm();
    const tracker = new BlockTracker(t.term);
    t.osc(133, `C;cmdline_b64=${b64("ls")}`);
    t.osc(133, `C;cmdline_b64=${b64("ls")}`);
    t.setCursor(1);
    t.osc(133, "D;0");
    t.setCursor(2);
    // The duplicate D is inert for the same reason: nothing is running.
    t.osc(133, "D;0");
    expect(tracker.blocks).toHaveLength(1);
    expect(tracker.blocks[0].command).toBe("ls");
    expect(tracker.blocks[0].exitCode).toBe(0);
    expect(tracker.runningBlock).toBeNull();
  });

  it("tracks cwd through OSC 7, tolerating raw percent signs", () => {
    const t = stubTerm();
    const seen: string[] = [];
    new BlockTracker(t.term, { onCwd: (c) => seen.push(c) });
    t.osc(7, "file://host/a%20b");
    t.osc(7, "file://host/tmp/100%"); // invalid encoding: taken literally
    expect(seen).toEqual(["/a b", "/tmp/100%"]);
  });

  it("surfaces the OSC 7 host segment, and stays silent when it is empty", () => {
    const t = stubTerm();
    const hosts: string[] = [];
    new BlockTracker(t.term, { onHost: (h) => hosts.push(h) });
    t.osc(7, "file://far-side.example.com/home/me");
    // file:///path (empty host) is the common form for "same machine" —
    // no host to report, and a callback with "" would be noise.
    t.osc(7, "file:///plain/path");
    expect(hosts).toEqual(["far-side.example.com"]);
  });
});
