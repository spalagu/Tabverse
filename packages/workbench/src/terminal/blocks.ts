import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Command blocks, driven by the shell integration's OSC 133 markers.
 *
 * A block starts when the shell reports a command starting (133;C) and ends
 * when it reports the exit status (133;D). Positions are tracked with xterm
 * markers, which follow the buffer as it scrolls and reflows — line numbers
 * would drift the moment output scrolls out of the viewport.
 */
export interface Block {
  id: number;
  command: string;
  /** Marker at the line where the command's output starts. */
  start: IMarker;
  /** Marker at the line where it finished; absent while still running. */
  end?: IMarker;
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
  cwd?: string;
}

export interface BlockEvents {
  onChange?: () => void;
  /** Fired once per command completion, with how long it ran. */
  onFinished?: (block: Block, durationMs: number) => void;
  onCwd?: (cwd: string) => void;
  onHost?: (host: string) => void;
}

function decodeB64(s: string): string {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export class BlockTracker {
  readonly blocks: Block[] = [];
  private nextId = 1;
  private running: Block | null = null;
  private cwd: string | null = null;

  constructor(
    private term: Terminal,
    private events: BlockEvents = {}
  ) {
    // OSC 133: prompt/command lifecycle.
    term.parser.registerOscHandler(133, (data) => {
      this.handle133(data);
      return true;
    });
    term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data);
      if (m) {
        // The shell prints $PWD raw, so a directory named /tmp/100% is not
        // valid percent-encoding — take it literally rather than losing cwd
        // tracking in that directory.
        let path = m[2];
        try {
          path = decodeURIComponent(path);
        } catch {
          /* keep the raw path */
        }
        this.cwd = path;
        this.events.onCwd?.(this.cwd);
        if (m[1] !== "") this.events.onHost?.(m[1]);
      }
      return true;
    });
  }

  private handle133(data: string) {
    const [kind, ...rest] = data.split(";");
    switch (kind) {
      case "C": {
        if (this.running) break;
        const params = rest.join(";");
        const b64 = /cmdline_b64=([A-Za-z0-9+/=]*)/.exec(params);
        const command = b64 ? decodeB64(b64[1]) : "";
        const marker = this.term.registerMarker(0);
        if (!marker) return;
        const block: Block = {
          id: this.nextId++,
          command,
          start: marker,
          startedAt: Date.now(),
          cwd: this.cwd ?? undefined,
        };
        this.running = block;
        this.blocks.push(block);
        // A terminal that runs for hours would otherwise hold every marker
        // ever created; the UI only ever shows recent history.
        if (this.blocks.length > 500) {
          this.blocks.splice(0, this.blocks.length - 500).forEach((b) => {
            b.start.dispose();
            b.end?.dispose();
          });
        }
        this.events.onChange?.();
        break;
      }
      case "D": {
        const block = this.running;
        if (!block) break;
        const code = Number(rest[0]);
        block.exitCode = Number.isFinite(code) ? code : undefined;
        block.finishedAt = Date.now();
        block.end = this.term.registerMarker(0) ?? undefined;
        this.running = null;
        this.events.onChange?.();
        this.events.onFinished?.(block, block.finishedAt - block.startedAt);
        break;
      }
      // A (prompt start) and B (prompt end) need no bookkeeping today; they
      // are accepted so the sequences never reach the screen as text.
      default:
        break;
    }
  }

  get currentCwd(): string | null {
    return this.cwd;
  }

  get runningBlock(): Block | null {
    return this.running;
  }

  /**
   * Text of a block's output, read straight from the buffer.
   *
   * Boundaries are exact and easy to get wrong: the shell reports the command
   * as started once the newline from Enter has already been echoed, so the
   * marker sits on the *first* line of output — starting a line later drops
   * it. The exit marker is emitted from the prompt hook, by which point the
   * cursor already sits on the line the next prompt will occupy, so that line
   * belongs to the prompt and not to the output.
   */
  outputOf(block: Block): string {
    const buf = this.term.buffer.active;
    // Markers die when their line is trimmed out of the scrollback (a big
    // build, or `clear`), and a dead marker reports -1 — reading from there
    // would hand back the top of the buffer instead of this command.
    if (block.start.line < 0) return "";
    const from = block.start.line;
    const to = block.end
      ? block.end.line - 1
      : buf.baseY + buf.cursorY;
    if (to < from) return "";
    const lines: string[] = [];
    for (let y = from; y <= to; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      // Wrapped continuation rows are one logical line, not two.
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  /** Blocks whose markers are still alive, i.e. still in the buffer. */
  get liveBlocks(): Block[] {
    return this.blocks.filter((b) => b.start.line >= 0);
  }

  /** The block nearest above (or at) the given viewport-independent line. */
  blockAt(line: number): Block | null {
    let found: Block | null = null;
    for (const b of this.liveBlocks) {
      if (b.start.line <= line) found = b;
      else break;
    }
    return found;
  }

  /** Forget blocks whose lines have left the buffer, so navigation and copy
   *  never land on a marker that now points at line -1. */
  pruneDead(): number {
    const before = this.blocks.length;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].start.line < 0) {
        this.blocks[i].start.dispose();
        this.blocks[i].end?.dispose();
        this.blocks.splice(i, 1);
      }
    }
    return before - this.blocks.length;
  }

  dispose() {
    for (const b of this.blocks) {
      b.start.dispose();
      b.end?.dispose();
    }
    this.blocks.length = 0;
  }
}
