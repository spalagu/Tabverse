import type { ILink, Terminal } from "@xterm/xterm";
import {
  describeTerminalLink,
  parseTerminalLink,
  resolvablePath,
  type TerminalLink,
} from "./links";

export interface TerminalPathLinkPorts {
  exists: (absolutePath: string) => Promise<boolean>;
  open: (link: TerminalLink, metaKey: boolean, shiftKey: boolean) => void;
  cacheLimit?: number;
}

export type TerminalLinkHover = (
  description: string | null,
  link: TerminalLink | null
) => void;

export type TerminalPathLinkProvider = ReturnType<
  typeof createTerminalPathLinkProvider
>;

/**
 * Build an xterm path-link provider with an injected filesystem and landing
 * adapter. Existence results are cached because xterm re-asks on each hover.
 */
export function createTerminalPathLinkProvider(ports: TerminalPathLinkPorts) {
  const cache = new Map<string, boolean>();
  const cacheLimit = ports.cacheLimit ?? 400;
  const cachedExists = async (absolutePath: string) => {
    const hit = cache.get(absolutePath);
    if (hit !== undefined) return hit;
    const verdict = await ports.exists(absolutePath);
    if (cache.size >= cacheLimit) cache.clear();
    cache.set(absolutePath, verdict);
    return verdict;
  };

  return async (
    terminal: Terminal,
    lineNumber: number,
    cwd: string | null,
    setHover: TerminalLinkHover
  ): Promise<ILink[] | undefined> => {
    const line = terminal.buffer.active.getLine(lineNumber - 1);
    if (line === undefined) return undefined;
    const text = line.translateToString(true);
    const links: ILink[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(/\S+/g)) {
      const word = match[0];
      const link = parseTerminalLink(word);
      if (link === null || link.kind !== "path") continue;
      const cacheKey = link.path.startsWith("/")
        ? link.path
        : `${cwd ?? ""}\0${link.path}`;
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      if (!(await resolvablePath(link.path, cwd, cachedExists))) continue;
      const start = match.index ?? 0;
      links.push({
        range: {
          start: { x: start, y: lineNumber },
          end: { x: start + word.length - 1, y: lineNumber },
        },
        text: word,
        activate: (event) =>
          ports.open(link, event.metaKey, event.shiftKey),
        hover: () => setHover(describeTerminalLink(link), link),
        leave: () => setHover(null, null),
      });
    }
    return links.length > 0 ? links : undefined;
  };
}
