import { stripTerminalEscapeSequences } from "../controlSequences";

export { stripTerminalEscapeSequences } from "../controlSequences";


/** One terminal tab's memory, as stored. */
export interface TermMemory {
  version: 1;
  /** SerializeAddon output: escape sequences that redraw the dead screen. */
  screen: string;
  /** Where that session was standing, so the next shell opens there. */
  cwd?: string;
}

export function termScope(tabId: string, paneId?: string): string {
  return paneId === undefined || paneId === tabId
    ? `term:${tabId}`
    : `term:${paneId}:${tabId}`;
}

/**
 * Lines of history kept. Same reasoning as the share snapshot: a full 10k
 * scrollback serializes to roughly a megabyte, which is far too much to
 * rewrite on disk every few seconds for a record nobody scrolls that far into.
 */
export const TERM_MEMORY_SCROLLBACK = 1000;

/**
 * Hard ceiling on a stored screen. 1000 ordinary lines are ~90 KB, but a
 * thousand wide, heavily colored lines are not: the cap is what keeps one
 * `cat` of a minified file from turning every save into a megabyte write.
 */
export const TERM_MEMORY_MAX_BYTES = 256 * 1024;

/** Output has stopped for this long → save (the common, quiet case). */
export const TERM_SAVE_IDLE_MS = 700;

/**
 * A terminal that never goes quiet (a `yes`, a tailed log) would defeat an
 * idle-only debounce and never save at all; this is the longest a stream of
 * output can hold the write off. So: one write per burst, or one every few
 * seconds while the burst never ends.
 */
export const TERM_SAVE_MAX_MS = 3000;

/**
 * How long to wait before writing, given when this dirty stretch started.
 * Idle debounce, floored by the max-wait deadline so continuous output still
 * lands on disk at a bounded rate.
 */
export function nextSaveDelay(now: number, dirtySince: number): number {
  const untilDeadline = dirtySince + TERM_SAVE_MAX_MS - now;
  return Math.max(0, Math.min(TERM_SAVE_IDLE_MS, untilDeadline));
}

/**
 * Does this screen show anything? A terminal whose shell never printed
 * serializes to cursor moves and blank cells — restoring that would put an
 * "ended here" marker above nothing at all, so it is not worth a file.
 */
export function hasVisibleContent(screen: string): boolean {
  return stripTerminalEscapeSequences(screen).trim().length > 0;
}

/**
 * Keep the payload under the ceiling by dropping the oldest lines. Cutting on
 * row boundaries is safe: the serializer separates rows with CRLF and never
 * puts one inside an escape sequence. The kept tail may start mid-style, so
 * it is prefixed with a style reset rather than inheriting a color nobody set.
 */
function capScreen(screen: string): string {
  if (screen.length <= TERM_MEMORY_MAX_BYTES) return screen;
  const rows = screen.split("\r\n");
  let kept: string[] = [];
  let size = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = rows[i].length + 2;
    if (size + cost > TERM_MEMORY_MAX_BYTES) break;
    kept.unshift(rows[i]);
    size += cost;
  }
  // A single row longer than the whole budget leaves nothing; keep its tail.
  if (kept.length === 0) kept = [screen.slice(-TERM_MEMORY_MAX_BYTES)];
  return `\x1b[0m${kept.join("\r\n")}`;
}

/**
 * The payload to store, or null when this terminal has nothing worth
 * remembering. Callers save exactly what this returns and nothing else.
 */
export function buildTermMemory(
  screen: string,
  cwd: string | null | undefined
): TermMemory | null {
  if (!hasVisibleContent(screen)) return null;
  const mem: TermMemory = { version: 1, screen: capScreen(screen) };
  if (typeof cwd === "string" && cwd.length > 0) mem.cwd = cwd;
  return mem;
}

/**
 * A stored payload read back, or null for anything unusable — a version this
 * build does not know, a corrupt file, an empty screen. Null always means
 * "start fresh", never an error the user has to deal with.
 */
export function readTermMemory(raw: unknown): TermMemory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<TermMemory>;
  if (r.version !== 1 || typeof r.screen !== "string") return null;
  if (!hasVisibleContent(r.screen)) return null;
  const mem: TermMemory = { version: 1, screen: r.screen };
  if (typeof r.cwd === "string" && r.cwd.length > 0) mem.cwd = r.cwd;
  return mem;
}

/**
 * Where the new shell starts. The store's tab already carries the remembered
 * directory (it is saved with the session), so that is the answer; the
 * memory's own copy is the fallback for when the session file lost it.
 */
export function spawnCwd(
  tabCwd: string | undefined,
  memoryCwd: string | undefined
): string | undefined {
  return tabCwd ?? memoryCwd;
}

/** State that decides whether restored history may still be written. */
export interface RestoreGate {
  /** The pane is gone (tab closed, app tearing down). */
  disposed: boolean;
  /** The new shell has already printed something. */
  outputSeen: boolean;
  /** History went in already. */
  alreadyWritten: boolean;
}

/**
 * May the history go in now?
 *
 * The shell is never held back waiting for this load (a slow or failed read
 * must never leave someone staring at a terminal with no session behind it),
 * so the load can land after the shell has started. History is only ever
 * *above* live output: once the new shell has printed, injecting a transcript
 * of a dead one would interleave the two and read as corruption. Losing the
 * history is the smaller harm, so a late load is dropped.
 */
export function shouldWriteRestore(
  mem: TermMemory | null,
  gate: RestoreGate
): boolean {
  if (mem === null) return false;
  return !gate.disposed && !gate.outputSeen && !gate.alreadyWritten;
}

/** The marker itself: what happened, in the fewest words that stay true. */
export const SESSION_ENDED_LABEL = "previous session ended here";

/** Why nothing above the marker responds to anything the user types at it. */
export const SESSION_ENDED_NOTE = "text above is a saved transcript, not live";

/**
 * The boundary drawn under restored history.
 *
 * Everything above it is a picture of a session that is over: no process is
 * attached to it, ⌃C cannot reach into it, and a command still sitting at its
 * prompt never ran. The marker has to say that plainly, so nobody reads the
 * old screen as something still happening. It also resets style and cursor
 * visibility, which the transcript may have left in any state.
 */
export function sessionSeparator(cols: number): string {
  const full = `${SESSION_ENDED_LABEL} — ${SESSION_ENDED_NOTE}`;
  const width = Math.max(cols, 1);
  const text = full.length + 4 <= width ? full : SESSION_ENDED_LABEL;
  const fill = Math.max(0, Math.min(width, 100) - text.length - 2);
  const left = "─".repeat(Math.floor(fill / 2));
  const right = "─".repeat(fill - Math.floor(fill / 2));
  return (
    `\r\n\x1b[0m\x1b[?25h\r\n` +
    `\x1b[90m${left} ${text} ${right}\x1b[0m\r\n\r\n`
  );
}

/** Everything written into the terminal to bring a dead session back. */
export function restoreWrite(mem: TermMemory, cols: number): string {
  return mem.screen + sessionSeparator(cols);
}
