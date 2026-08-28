
/** CSI 200~ — the marker a program in bracketed-paste mode opens with. */
export const BRACKETED_PASTE_START = "\x1b[200~";
/** CSI 201~ — the marker a program in bracketed-paste mode closes with. */
export const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * How many lines `text` holds, a line being what `\n` counts.
 *
 * One more than the newline count, so the text between the last `\n` and
 * the end is a line too. A trailing newline therefore counts as two lines —
 * deliberately: pasting `rm -rf build\n` is a one-word paste that EXECUTES,
 * which is the exact surprise this guard exists to stop.
 */
export function countLines(text: string): number {
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines++;
  return lines;
}

/**
 * Whether this paste has to stop for the preview dialog: two or more lines.
 * `\r` alone does not count — a line is what `\n` counts, per the ruling.
 */
export function needsConfirm(text: string): boolean {
  return countLines(text) >= 2;
}

/**
 * The bytes a confirmed paste carries: the text between the bracketed-paste
 * markers, verbatim. Nothing else is added — no trailing newline of our own,
 * because the dialog shows exactly what will be sent and that is what this
 * returns.
 */
export function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/**
 * What the guard needs from the pane it guards.
 *
 * Held as functions so the module stays pure: every decision below can be
 * exercised without a terminal, a shell or a DOM — the wiring is one file's
 * business and the rules are this one's.
 */
export interface PasteGuardPorts {
  /**
   * The one keystroke channel broadcast input fans out through. A confirmed
   * paste is typing, in the sense that matters: every pane the keyboard
   * reaches should receive it.
   */
  sendKeys: (data: string) => void;
  /**
   * The channel a single-line paste has always used — xterm's own
   * `paste()`, mode-aware, reaching the shell through the terminal's own
   * onData wiring (which is the broadcast fan-out in its turn).
   */
  plainPaste: (text: string) => void;
  /** Opens the preview dialog carrying this text. */
  ask: (text: string) => void;
  /**
   * Whether the guard is on. Null is "nothing has been read", and the
   * answer there is ON — the safe direction, and the registry's own
   * default; the moment the configuration answers, its word governs.
   */
  enabled: () => boolean | null;
}

/**
 * The unified paste entry: every route into a paste calls this with the
 * text it holds.
 *
 * Empty text is dropped rather than asked about — an empty clipboard is
 * not a paste anyone made, and a dialog over it would be noise.
 */
export function guardPaste(text: string, ports: PasteGuardPorts): void {
  if (text === "") return;
  if (ports.enabled() === false) {
    ports.plainPaste(text);
    return;
  }
  if (needsConfirm(text)) {
    ports.ask(text);
    return;
  }
  ports.plainPaste(text);
}

/**
 * What the dialog's confirm does with the (possibly edited) text: the
 * bracketed-paste-wrapped bytes, sent as typing so broadcast carries them
 * to every pane. The caller has already closed the dialog; this never
 * re-opens it.
 */
export function confirmedPaste(text: string, ports: PasteGuardPorts): void {
  if (text === "") return;
  ports.sendKeys(bracketedPaste(text));
}
