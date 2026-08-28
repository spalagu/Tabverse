import { STR } from "./index";

export interface ErrorDescription {
  /** `Couldn't <action>.` — action comes from STR.errors.actions. */
  title: string;
  /** First matching pattern's suggestion; absent when nothing matched. */
  next?: string;
  /** String(e) verbatim — diagnostic value kept, headline value removed. */
  detail: string;
}

/**
 * The one sanctioned stringification of a caught error. Components never
 * call String(e) themselves; classification helpers that
 * need the raw text go through here.
 */
export function errorText(e: unknown): string {
  return String(e);
}

export const ERROR_PATTERNS: ReadonlyArray<{
  id: string;
  test: RegExp;
  next: string;
}> = [
  {
    id: "permission",
    test: /permission denied|EACCES|operation not permitted/i,
    next:
      "You don't have permission for this file or folder. Check its " +
      "ownership, or pick another location.",
  },
  {
    id: "missing",
    test: /no such file|ENOENT|not found/i,
    next: "It may have been moved or deleted. Refresh and try again.",
  },
  {
    id: "exists",
    test: /already exists|EEXIST/i,
    next: "Something with this name already exists. Pick another name.",
  },
  {
    id: "no-space",
    test: /no space|ENOSPC/i,
    next: "The disk is full. Free up some space and try again.",
  },
  {
    id: "read-only",
    test: /read-only|EROFS/i,
    next: "This location is read-only. Save a copy somewhere else instead.",
  },
  {
    id: "busy",
    test: /busy|EBUSY|locked/i,
    next: "Another program is using it. Close that program and try again.",
  },
  {
    id: "timeout",
    test: /timed out|ETIMEDOUT/i,
    next:
      "It took too long. Try again — if this keeps happening, check the " +
      "connection.",
  },
  {
    id: "refused",
    test: /connection refused|ECONNREFUSED/i,
    next:
      "The connection was refused. Check the address, and whether the " +
      "service is running.",
  },
  {
    id: "offline",
    test: /offline|network is unreachable|ENOTFOUND/i,
    next: "This machine looks offline. Check the network connection.",
  },
  {
    id: "bad-regex",
    test: /regex parse error|invalid regex/i,
    next:
      "The search pattern isn't a valid regular expression. Escape special " +
      "characters like ( or [.",
  },
];

/**
 * Translate a caught error for the user. `action` is a verb phrase from
 * STR.errors.actions; the raw error string only ever lands in `detail`.
 */
export function describeError(e: unknown, action: string): ErrorDescription {
  const detail = errorText(e);
  const hit = ERROR_PATTERNS.find((p) => p.test.test(detail));
  return hit
    ? { title: `Couldn't ${action}.`, next: hit.next, detail }
    : { title: `Couldn't ${action}.`, detail };
}

/**
 * Human lines for a host-sent remote-session End reason (wire strings from
 * crates/tabverse-remote: "host stopped sharing" / "removed by host" /
 * "ticket expired"). Unmapped reasons keep the raw string as detail, same
 * fallback shape as describeError.
 */
export function describeSessionEnd(reason: string): {
  line: string;
  detail?: string;
} {
  const r = reason.toLowerCase();
  if (r.includes("stopped sharing")) return { line: STR.remote.endedStopped };
  if (r.includes("removed by host")) return { line: STR.remote.endedKicked };
  if (r.includes("ticket expired")) return { line: STR.remote.endedExpired };
  return { line: STR.remote.endedGeneric, detail: reason };
}

/**
 * Render an ErrorDescription as ANSI terminal lines: red title, plain next
 * step, dim raw detail. For sinks that write into an xterm buffer, where
 * the <details> fold does not exist.
 */
export function ansiErrorLines(d: ErrorDescription): string {
  const next = d.next ? `\r\n${d.next}` : "";
  return `\r\n\x1b[31m${d.title}\x1b[0m${next}\r\n\x1b[90m${d.detail}\x1b[0m\r\n`;
}
