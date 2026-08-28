import type { IDecoration, IDecorationOptions, Terminal } from "@xterm/xterm";
import type { Block } from "./blocks";


export const OVERVIEW_RULER_WIDTH = 8;

export type BlockDotState = "running" | "ok" | "fail";

/**
 * "Failed" is the same rule the block bar uses: a KNOWN non-zero exit. An
 * exit that could not be parsed is not a failure — the ruler ticks only for
 * a code somebody saw, and a dot only turns danger for the same reason.
 */
export function isFailedBlock(b: Block): boolean {
  return (
    b.finishedAt !== undefined && b.exitCode !== undefined && b.exitCode !== 0
  );
}

export function blockDotState(b: Block): BlockDotState {
  if (b.finishedAt === undefined) return "running";
  return isFailedBlock(b) ? "fail" : "ok";
}

/**
 * The buffer line a click at `y` px of a `rulerHeight`-tall ruler stands
 * for — the inverse of the ruler's own paint (xterm's OverviewRulerRenderer
 * maps line → y = height × line / totalLines, with the ruler exactly as
 * tall as the viewport). Clamped to lines that exist: a click at an edge is
 * the first or last line, never -1 or length.
 */
export function rulerYToBufferLine(
  y: number,
  rulerHeight: number,
  totalLines: number
): number {
  if (rulerHeight <= 0 || totalLines <= 0) return 0;
  const line = Math.floor((y / rulerHeight) * totalLines);
  return Math.min(Math.max(line, 0), totalLines - 1);
}

export function blockDecorationOptions(marker: Block["start"]): IDecorationOptions {
  // x must be 0, never negative: registerDecoration validates x/width/height
  // against non-negative integers and THROWS otherwise — a defect the unit
  // fakes cannot see (they validate nothing) and only the real terminal
  // reveals, at the first block, in the packaged app. The gutter offset the
  // negative x was for is a margin on the element instead (styles.css), same
  // pixels, no API fight.
  return { marker, anchor: "left", x: 0, width: 1, height: 1 };
}

/** The ruler entry a failed block's decoration carries. The color arrives
 *  from the caller — the theme's danger token by the time TerminalView
 *  supplies it; this module writes no color of its own. */
export function failureRulerOptions(
  color: string
): NonNullable<IDecorationOptions["overviewRulerOptions"]> {
  return { color, position: "full" };
}

/** The theme-dependent half of what gets painted. */
export interface BlockDecorationColors {
  danger: string;
}

function paintDot(el: HTMLElement | undefined, state: BlockDotState): void {
  if (!el) return;
  el.classList.remove(
    "term-block-dot",
    "term-block-dot--running",
    "term-block-dot--ok",
    "term-block-dot--fail"
  );
  el.classList.add("term-block-dot", `term-block-dot--${state}`);
}

interface DecorationRecord {
  deco: IDecoration;
  state: BlockDotState;
}

/**
 * One decoration per live block, kept in step with the tracker's block
 * list. Call sync() wherever blocks change (the tracker's onChange — i.e.
 * after pruneDead has run): it registers decorations for blocks that lack
 * one, moves a finished block's dot to its final state and adds (or keeps
 * off) its ruler tick, and disposes decorations whose block left the list.
 *
 * Removal follows the marker, not the map: xterm disposes a decoration the
 * moment its marker is disposed (scroll-trim, `clear`, the 500 cap), so a
 * dead block's dot is already gone from the screen — sync() dropping the
 * record keeps this map from outliving that truth, and covers test fakes
 * without xterm's marker→decoration wiring. Double-dispose is harmless.
 */
export class BlockDecorations {
  private byBlock = new Map<Block, DecorationRecord>();

  constructor(
    private term: Pick<Terminal, "registerDecoration">,
    private colors: () => BlockDecorationColors
  ) {}

  sync(blocks: readonly Block[]): void {
    const alive = new Set<Block>();
    for (const b of blocks) {
      alive.add(b);
      const rec = this.byBlock.get(b);
      if (!rec) {
        const deco = this.term.registerDecoration(blockDecorationOptions(b.start));
        if (!deco) continue;
        const fresh: DecorationRecord = { deco, state: blockDotState(b) };
        this.byBlock.set(b, fresh);
        deco.onRender((el) => paintDot(el, fresh.state));
        this.apply(b, fresh);
      } else if (rec.state !== blockDotState(b)) {
        rec.state = blockDotState(b);
        this.apply(b, rec);
      }
    }
    for (const [b, rec] of this.byBlock) {
      if (!alive.has(b) || rec.deco.isDisposed) {
        this.byBlock.delete(b);
        rec.deco.dispose();
      }
    }
  }

  /**
   * Theme switch. The dots repaint themselves — their colors are CSS vars —
   * but the ruler is a canvas, so every failure tick is handed the new
   * theme's danger color by re-running the paint.
   */
  refreshTheme(): void {
    for (const [b, rec] of this.byBlock) this.apply(b, rec);
  }

  private apply(b: Block, rec: DecorationRecord): void {
    paintDot(rec.deco.element, rec.state);
    rec.deco.options.overviewRulerOptions = isFailedBlock(b)
      ? failureRulerOptions(this.colors().danger)
      : undefined;
  }

  dispose(): void {
    for (const [, rec] of this.byBlock) rec.deco.dispose();
    this.byBlock.clear();
  }
}
