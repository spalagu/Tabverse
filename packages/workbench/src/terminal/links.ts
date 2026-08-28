/** What a piece of terminal text names: a place on the web, or a file. */
export type TerminalLink =
  | { kind: "url"; url: string }
  | { kind: "path"; path: string; line?: number; column?: number }
  | { kind: "dir"; path: string };

const URL_RE = /^https?:\/\/\S+$/i;
const PATH_RE = /^(\/|~\/|\.{1,2}\/)(\S+?)(?::(\d+))?(?::(\d+))?$/;

/** Parse an explicit HTTP(S) address or rooted/relative file path. */
export function parseTerminalLink(text: string): TerminalLink | null {
  const trimmed = text.trim();
  if (URL_RE.test(trimmed)) return { kind: "url", url: trimmed };
  const hit = PATH_RE.exec(trimmed);
  if (hit === null) return null;
  return {
    kind: "path",
    path: hit[1] + hit[2],
    ...(hit[3] !== undefined ? { line: Number(hit[3]) } : {}),
    ...(hit[4] !== undefined ? { column: Number(hit[4]) } : {}),
  };
}

/** Render the decoded target for terminal hover status. */
export function describeTerminalLink(link: TerminalLink): string {
  if (link.kind === "url") return link.url;
  if (link.kind === "dir") return link.path;
  return `${link.path}${link.line !== undefined ? `:${link.line}` : ""}`;
}

/**
 * Check whether a path-provider candidate can resolve in a terminal's
 * working directory. The filesystem operation remains an injected port.
 */
export async function resolvablePath(
  candidate: string,
  cwd: string | null,
  exists: (absolutePath: string) => Promise<boolean>
): Promise<boolean> {
  let absolutePath = candidate;
  if (candidate.startsWith("~/")) return true;
  if (!candidate.startsWith("/")) {
    if (cwd === null) return false;
    absolutePath = `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/${candidate}`;
  }
  return exists(absolutePath);
}

/** Terminal links intentionally recognize only explicit HTTP(S) addresses. */
export function isFullAddress(text: string): boolean {
  return URL_RE.test(text.trim());
}
