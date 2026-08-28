import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { BlockTracker } from "./blocks";
import {
  BlockDecorations,
  blockDecorationOptions,
  blockDotState,
  failureRulerOptions,
  isFailedBlock,
  rulerYToBufferLine,
} from "./decorations";

/** What the fake's registerDecoration hands back: the updatable-options and
 *  dispose surface of IDecoration, plus the render callbacks the test fires. */
interface FakeDeco {
  marker: { line: number; disposed: boolean };
  options: { overviewRulerOptions?: { color: string; position?: string } };
  element: HTMLElement | undefined;
  disposed: boolean;
  cbs: ((el: HTMLElement) => void)[];
  onRender(cb: (el: HTMLElement) => void): { dispose(): void };
  dispose(): void;
}

function fakeTerm(bufferLength: number) {
  const osc = new Map<number, (data: string) => boolean>();
  const markers: {
    line: number;
    disposed: boolean;
    dispose(): void;
  }[] = [];
  const decorations: FakeDeco[] = [];
  const scrollTo: number[] = [];
  let cursor = 0;
  const term = {
    parser: {
      registerOscHandler(id: number, cb: (data: string) => boolean) {
        osc.set(id, cb);
        return { dispose() {} };
      },
    },
    // xterm refuses a decoration whose marker is disposed; so does the fake.
    registerDecoration(options: { marker: { line: number; disposed: boolean } }) {
      if (options.marker.disposed) return undefined;
      const deco: FakeDeco = {
        marker: options.marker,
        options: { overviewRulerOptions: undefined },
        element: undefined,
        disposed: false,
        // xterm fires onRender on every refresh once the element exists;
        // the test decides when by calling render() below.
        cbs: [],
        onRender(cb: (el: HTMLElement) => void) {
          deco.cbs.push(cb);
          return { dispose() {} };
        },
        dispose() {
          this.disposed = true;
        },
      };
      decorations.push(deco);
      return deco;
    },
    registerMarker(offset = 0) {
      const m = {
        line: cursor + offset,
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      markers.push(m);
      return m;
    },
    buffer: {
      active: {
        get length() {
          return bufferLength;
        },
        get cursorY() {
          return cursor;
        },
      },
    },
    scrollToLine(line: number) {
      scrollTo.push(line);
    },
    clear() {
      // The real clear() trims every line, which kills every marker.
      for (const m of markers) {
        m.line = -1;
        m.disposed = true;
      }
    },
  };
  return {
    term: term as unknown as Pick<
      Terminal,
      "registerDecoration" | "scrollToLine" | "registerMarker"
    > & { clear(): void },
    asTerminal: term as unknown as Terminal,
    osc: (id: number, data: string) => osc.get(id)!(data),
    setCursor: (c: number) => (cursor = c),
    decorations,
    scrollTo,
    /** Simulate xterm's first render of every decoration element. */
    render() {
      for (const d of decorations) {
        if (d.disposed || d.element) continue;
        d.element = document.createElement("div");
        for (const cb of d.cbs) cb(d.element);
      }
    },
  };
}

const b64 = (s: string) => btoa(s);

/** A harness wiring the real tracker and decorations over the fake. */
function harness(bufferLength = 1000) {
  const t = fakeTerm(bufferLength);
  const theme = { danger: "theme-one-danger" };
  const tracker = new BlockTracker(t.asTerminal);
  const deco = new BlockDecorations(
    t.term,
    () => ({ danger: theme.danger })
  );
  const flush = () => {
    tracker.pruneDead();
    deco.sync(tracker.blocks);
  };
  return { t, tracker, deco, theme, flush };
}

describe("BlockDecorations dots", () => {
  it("paints running neutral, exit 0 ok, failure danger — each on the block's first output line", () => {
    const { t, tracker, flush } = harness();
    // A successful block at line 4.
    t.setCursor(4);
    t.osc(133, `C;cmdline_b64=${b64("true")}`);
    t.osc(133, "D;0");
    // A failed block at line 10.
    t.setCursor(10);
    t.osc(133, `C;cmdline_b64=${b64("false")}`);
    t.osc(133, "D;1");
    // A running block last: C lands with the cursor on the output's first
    // line and no D has come yet.
    t.setCursor(20);
    t.osc(133, `C;cmdline_b64=${b64("sleep 10")}`);

    expect(tracker.blocks).toHaveLength(3);
    flush();
    t.render();
    const [ok, fail, run] = t.decorations;
    expect(ok.marker).toBe(tracker.blocks[0].start);
    expect(ok.marker.line).toBe(4);
    expect(fail.marker.line).toBe(10);
    expect(run.marker.line).toBe(20);
    // The three states carry the three dot classes (the colors themselves
    // are the CSS vars those classes paint with).
    expect(ok.element!.className).toContain("term-block-dot--ok");
    expect(fail.element!.className).toContain("term-block-dot--fail");
    expect(run.element!.className).toContain("term-block-dot--running");
  });

  it("moves a dot to its final state when the block finishes", () => {
    const { t, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("make")}`);
    flush();
    t.render();
    expect(t.decorations[0].element!.className).toContain(
      "term-block-dot--running"
    );
    t.osc(133, "D;0");
    flush();
    expect(t.decorations[0].element!.className).toContain("term-block-dot--ok");
    expect(t.decorations[0].element!.className).not.toContain(
      "term-block-dot--running"
    );
  });

  it("counter-example: a double-fired C (starship stacking) creates no second block or dot", () => {
    const { t, tracker, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("ls")}`);
    t.osc(133, `C;cmdline_b64=${b64("ls")}`); // starship's own 133;C
    t.osc(133, "D;0");
    flush();
    expect(tracker.blocks).toHaveLength(1);
    expect(t.decorations).toHaveLength(1);
  });

  it("term.clear() kills every marker, so pruning takes every decoration with it", () => {
    const { t, tracker, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("one")}`);
    t.osc(133, "D;0");
    t.setCursor(5);
    t.osc(133, `C;cmdline_b64=${b64("two")}`);
    flush();
    expect(t.decorations).toHaveLength(2);
    t.term.clear();
    flush();
    expect(tracker.blocks).toHaveLength(0);
    expect(t.decorations.every((d) => d.disposed)).toBe(true);
  });

  it("a marker trimmed by the scrollback takes only its own decoration", () => {
    const { t, tracker, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("old build")}`);
    t.osc(133, "D;0");
    t.setCursor(9);
    t.osc(133, `C;cmdline_b64=${b64("current")}`);
    flush();
    (tracker.blocks[0].start as { line: number }).line = -1; // trimmed out
    flush();
    expect(t.decorations[0].disposed).toBe(true);
    expect(t.decorations[1].disposed).toBe(false);
  });
});

describe("BlockDecorations ruler ticks", () => {
  it("a failed block's decoration carries a red tick; a successful one carries none", () => {
    const { t, flush } = harness();
    t.setCursor(3);
    t.osc(133, `C;cmdline_b64=${b64("ok cmd")}`);
    t.osc(133, "D;0");
    t.setCursor(7);
    t.osc(133, `C;cmdline_b64=${b64("bad cmd")}`);
    t.osc(133, "D;127");
    flush();
    const [, fail] = t.decorations;
    expect(fail.options.overviewRulerOptions).toEqual({
      color: "theme-one-danger",
      position: "full",
    });
    // Counter-example (the judgement's own): success must leave the ruler
    // alone — a ruler of green ticks is noise.
    expect(t.decorations[0].options.overviewRulerOptions).toBeUndefined();
  });

  it("a running block has no tick until it fails", () => {
    const { t, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("long build")}`);
    flush();
    expect(t.decorations[0].options.overviewRulerOptions).toBeUndefined();
    t.osc(133, "D;2");
    flush();
    expect(t.decorations[0].options.overviewRulerOptions?.color).toBe(
      "theme-one-danger"
    );
  });

  it("a theme switch re-hands the ruler the new danger color, dots need nothing", () => {
    const { t, deco, theme, flush } = harness();
    t.osc(133, `C;cmdline_b64=${b64("fail")}`);
    t.osc(133, "D;1");
    flush();
    expect(t.decorations[0].options.overviewRulerOptions?.color).toBe(
      "theme-one-danger"
    );
    theme.danger = "theme-two-danger";
    deco.refreshTheme();
    expect(t.decorations[0].options.overviewRulerOptions?.color).toBe(
      "theme-two-danger"
    );
  });
});

describe("ruler click → jump", () => {
  it("maps ruler height to buffer lines, clamped at both ends", () => {
    expect(rulerYToBufferLine(0, 100, 1000)).toBe(0);
    expect(rulerYToBufferLine(50, 100, 1000)).toBe(500);
    expect(rulerYToBufferLine(100, 100, 1000)).toBe(999); // clamp, not 1000
    expect(rulerYToBufferLine(-5, 100, 1000)).toBe(0);
    expect(rulerYToBufferLine(30, 0, 1000)).toBe(0); // degenerate ruler
    expect(rulerYToBufferLine(30, 100, 0)).toBe(0); // empty buffer
  });

  it("a click at a height lands on the block there, one line above its start", () => {
    // Three blocks, buffer of 100 lines, ruler as tall as the viewport.
    const { t, tracker, flush } = harness(100);
    t.setCursor(0);
    t.osc(133, `C;cmdline_b64=${b64("first")}`);
    t.osc(133, "D;0");
    t.setCursor(10);
    t.osc(133, `C;cmdline_b64=${b64("second")}`);
    t.osc(133, "D;0");
    t.setCursor(20);
    t.osc(133, `C;cmdline_b64=${b64("third")}`);
    t.osc(133, "D;0");
    flush();

    // Click at half the ruler's height: 100-line buffer → line 50 → the
    // block starting at 20; scrollToLine gets start - 1, jumpBlock's own
    // landing so the block's output reads from its first line.
    const RULER_H = 120;
    const line = rulerYToBufferLine(RULER_H / 2, RULER_H, 100);
    const target = tracker.blockAt(line);
    t.term.scrollToLine(Math.max(0, target!.start.line - 1));
    expect(target).toBe(tracker.blocks[2]);
    expect(t.scrollTo).toEqual([19]);

    // A click near the very top is line 0 — the first block — and the
    // landing clamps to the top of the buffer rather than scrolling to -1.
    t.scrollTo.length = 0;
    const top = tracker.blockAt(rulerYToBufferLine(1, RULER_H, 100));
    t.term.scrollToLine(Math.max(0, top!.start.line - 1));
    expect(top).toBe(tracker.blocks[0]);
    expect(t.scrollTo).toEqual([0]);
  });
});

describe("block state mapping", () => {
  it("failed means a known non-zero exit, mirroring the block bar's rule", () => {
    const mk = (over: Partial<import("./blocks").Block>) =>
      ({
        id: 1,
        command: "x",
        start: { line: 0, disposed: false },
        startedAt: 0,
        ...over,
      }) as import("./blocks").Block;
    expect(blockDotState(mk({}))).toBe("running");
    // Finished with an unparseable exit is not a failure anyone may point
    // at: the block bar shows the same ok-class for it.
    expect(blockDotState(mk({ finishedAt: 5 }))).toBe("ok");
    expect(blockDotState(mk({ finishedAt: 5, exitCode: 0 }))).toBe("ok");
    expect(blockDotState(mk({ finishedAt: 5, exitCode: 127 }))).toBe("fail");
    // An exit that could not be parsed is not a failure anyone may point at.
    expect(isFailedBlock(mk({ finishedAt: 5 }))).toBe(false);
    expect(isFailedBlock(mk({ finishedAt: 5, exitCode: 2 }))).toBe(true);
  });

  it("registers the dot one cell into the left gutter, on the C marker", () => {
    const marker = { line: 3, disposed: false };
    expect(blockDecorationOptions(marker as never)).toEqual({
      marker,
      anchor: "left",
      x: 0,
      width: 1,
      height: 1,
    });
    expect(failureRulerOptions("#from-theme")).toEqual({
      color: "#from-theme",
      position: "full",
    });
  });
});
