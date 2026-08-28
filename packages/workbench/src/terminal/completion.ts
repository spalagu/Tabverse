import { BRACKETED_PASTE_START } from "./pasteGuard";

export interface FlagSpec {
  name: string;
  takesValue?: boolean;
  /** The closed set of values this flag accepts, when it has one. */
  values?: string[];
}

/** One command the spec knows. */
export interface CommandSpec {
  name: string;
  flags: FlagSpec[];
  subcommands?: string[];
}

/** The file-completion half: what a path word looks like, never what exists. */
export interface FilePatterns {
  patterns: string[];
  extensions: string[];
}

/** The whole spec document. `version` is the date-shaped id of its cut. */
export interface CompletionSpec {
  version: string;
  commands: CommandSpec[];
  files: FilePatterns;
}

/**
 * Read one document, or null when it is not one.
 *
 * The bar is "shaped like a spec", not "complete": a snapshot with twenty
 * commands and a snapshot with two are both accepted, because the floor's
 * own promise is "a menu, not an inventory" (assets/completions/README).
 * What is refused is a document that cannot be asked anything at all —
 * no version, no command list, no files table — since every consumer
 * below would then be guessing at fields that are not there.
 */
export function parseSpec(raw: unknown): CompletionSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.version !== "string" || v.version === "") return null;
  if (!Array.isArray(v.commands)) return null;
  const commands: CommandSpec[] = [];
  for (const c of v.commands) {
    if (typeof c !== "object" || c === null) continue;
    const cmd = c as Record<string, unknown>;
    if (typeof cmd.name !== "string" || !Array.isArray(cmd.flags)) continue;
    const flags: FlagSpec[] = [];
    for (const f of cmd.flags) {
      if (typeof f !== "object" || f === null) continue;
      const flag = f as Record<string, unknown>;
      if (typeof flag.name !== "string") continue;
      flags.push({
        name: flag.name,
        ...(typeof flag.takesValue === "boolean"
          ? { takesValue: flag.takesValue }
          : {}),
        ...(Array.isArray(flag.values)
          ? { values: flag.values.filter((x): x is string => typeof x === "string") }
          : {}),
      });
    }
    commands.push({
      name: cmd.name,
      flags,
      ...(Array.isArray(cmd.subcommands)
        ? {
            subcommands: cmd.subcommands.filter(
              (x): x is string => typeof x === "string"
            ),
          }
        : {}),
    });
  }
  const fileTable =
    typeof v.files === "object" && v.files !== null
      ? (v.files as Record<string, unknown>)
      : {};
  const patterns = Array.isArray(fileTable.patterns)
    ? fileTable.patterns.filter((x): x is string => typeof x === "string")
    : [];
  const extensions = Array.isArray(fileTable.extensions)
    ? fileTable.extensions.filter((x): x is string => typeof x === "string")
    : [];
  return { version: v.version, commands, files: { patterns, extensions } };
}

export class InputLine {
  private line = "";
  // An escape sequence in flight: xterm keys arrive as CSI (`ESC […final`)
  // or SS3 (`ESC O final`), and Alt+key as a bare `ESC` before the key.
  // None of that is text the line holds, so after an `ESC` the absorber
  // skips one plain character (the Alt case) or runs to the final byte
  // (0x40–0x7E) of a bracketed sequence. Held on the instance because a
  // sequence can straddle two onData strings.
  private inEscape = false;
  private inSequence = false;

  /** One onData string. Returns the model's line after absorbing it. */
  push(s: string): string {
    if (s.includes(BRACKETED_PASTE_START)) {
      // A paste is not typing: whatever the shell makes of it, this
      // model's line is no longer a picture of it.
      this.reset();
      return this.line;
    }
    for (const ch of s) {
      if (this.inSequence) {
        if (ch >= "@" && ch <= "~") {
          this.inSequence = false;
        }
        continue;
      }
      if (this.inEscape) {
        this.inEscape = false;
        if (ch === "[" || ch === "O") this.inSequence = true;
        continue;
      }
      if (ch === "\x1b") {
        this.inEscape = true;
        continue;
      }
      if (ch === "\r" || ch === "\n") this.reset();
      else if (ch === "\x7f") this.line = this.line.slice(0, -1);
      else if (ch >= " ") this.line += ch;
    }
    return this.line;
  }

  reset(): void {
    this.line = "";
    this.inEscape = false;
    this.inSequence = false;
  }

  get text(): string {
    return this.line;
  }
}

/** What the popup should show for a line being typed, or null for nothing. */
export type CompletionOffer =
  | {
      kind: "flags";
      /** The command the line's first word named (matched in the spec). */
      command: string;
      /** The partial flag word being typed, e.g. `--ver`. */
      word: string;
      /** The flags worth offering: the command's that start with `word`. */
      items: string[];
    }
  | {
      kind: "files";
      /** The path-shaped word being typed. */
      word: string;
    };

/** The last whitespace-delimited word of the line. */
export function lastWord(line: string): string {
  const at = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t"));
  return line.slice(at + 1);
}

/**
 * The line's offer, judged against the spec.
 *
 * Flags: the word starts with `-` AND the line's first word names a
 * command the spec knows — an unknown command offers nothing, because a
 * guess about flags the spec never heard of is worse than silence. Only
 * the command's own top-level flags are offered (a `git commit -` sees
 * git's, not a per-subcommand set — the skeleton's stated limit).
 *
 * Files: reserved for the future path-completion implementation. A path
 * shaped word is intentionally silent until that implementation can offer
 * a real result; a placeholder message is more distracting than useful.
 */
export function completionFor(
  line: string,
  spec: CompletionSpec | null
): CompletionOffer | null {
  const word = lastWord(line);
  if (word === "") return null;
  if (spec === null) return null;
  if (word.startsWith("-")) {
    const cmdName = line.slice(0, line.length - word.length).trimStart();
    const first = cmdName.split(/\s+/)[0] ?? "";
    const cmd = spec.commands.find((c) => c.name === first);
    if (cmd === undefined) return null;
    const items = cmd.flags.map((f) => f.name).filter((n) => n.startsWith(word));
    return items.length > 0 ? { kind: "flags", command: cmd.name, word, items } : null;
  }
  // Path completion is a future placeholder. Do not surface a detection
  // toast or popup before the file-listing behavior exists.
  return null;
}
