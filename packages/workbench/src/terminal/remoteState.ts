
const REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "ssh",
  "mosh",
  "telnet",
]);

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-p",
  "-J",
  "-i",
  "-o",
  "-l",
  "-L",
  "-R",
  "-D",
]);

/** Flags that stand alone. -tt (ssh's doubled -t) is listed because the
 * skip loop below looks at whole words. */
const BARE_FLAGS: ReadonlySet<string> = new Set([
  "-4",
  "-6",
  "-t",
  "-tt",
  "-v",
]);

/** What a classified command says: the pane is remote, on this host. */
export interface RemoteTarget {
  host: string;
}

/** Strip one layer of the quoting a command line carries around a word
 * (system opens arrive as `ssh -p 22 'user@host'`, single-quoted). */
function unquote(word: string): string {
  const trimmed = word.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The host of a `user@host` / `host` target word — the part after the last
 * `@`, or the whole word when there is none. */
function hostOf(target: string): string {
  const at = target.lastIndexOf("@");
  return at === -1 ? target : target.slice(at + 1);
}

/** Whether `word` is one of the flags to skip, and if so whether the NEXT
 * word is that flag's value (and must be skipped too). */
function flagKind(word: string): "none" | "bare" | "valued" {
  if (!word.startsWith("-") || word === "-") return "none";
  if (FLAGS_WITH_VALUE.has(word)) return "valued";
  // The glued form: -p22, -Jjump@bastion, -i~/.ssh/key — the value rides
  // inside the same word, so only this word is skipped.
  const flag = word.slice(0, 2);
  if (FLAGS_WITH_VALUE.has(flag) && word.length > 2) return "bare";
  if (BARE_FLAGS.has(word)) return "bare";
  return "none";
}

export function classifyRemote(command: string): RemoteTarget | null {
  // First segment of the line: everything before the first compound
  // operator. Splitting on these five covers && || ; | and newlines; the
  // classifier is a prefix check, not a shell, and does not need to parse
  // what it will never run.
  const firstSegment = command.split(/&&|\|\||;|\||\n/)[0] ?? "";
  const words = firstSegment.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return null;

  // Step over leading environment assignments.
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (i >= words.length) return null;

  if (!REMOTE_COMMANDS.has(unquote(words[i]))) return null;

  // The command word is ssh-family: find the target — the first word after
  // the command that is not a (known) flag or a flag's value.
  i++;
  while (i < words.length) {
    const word = unquote(words[i]);
    const kind = flagKind(word);
    if (kind === "none") {
      const host = hostOf(word);
      return host === "" ? null : { host };
    }
    // A valued flag eats the next word too — unless this is the last word,
    // in which case there is no target at all.
    if (kind === "valued" && i + 1 >= words.length) return null;
    i += kind === "valued" ? 2 : 1;
  }
  return null;
}

/**
 * A host as shown where room is short (the sidebar row, the pane corner):
 * the first label of a domain — `web-01.example.com` reads `web-01` — and
 * the host itself when it has no dots (an IP, an /etc/hosts name, a
 * shortname someone typed).
 */
export function shortHost(host: string): string {
  const dot = host.indexOf(".");
  return dot === -1 ? host : host.slice(0, dot);
}
