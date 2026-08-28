import { commandRunsAnywhere, type AppCommand } from "./appCommands";
import { filterSites, type VisitEntry } from "./history";
import { directUrl } from "./search";
import { visibleShortcuts, type Shortcut } from "./shortcuts";
import type { ConfigProfile } from "./state/config";
import type {
  ArchiveEntry,
  ClosedEntry,
  Group,
  Tab,
} from "./state/store";
import { tabSubtitle } from "./tabMeta";


/** ⌘K/⌘P-style subsequence matching (fuzzy, order-preserving). */
export function subsequenceScore(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let hi = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const ch of n) {
    const at = h.indexOf(ch, hi);
    if (at < 0) return null;
    if (at === hi) streak++;
    else streak = 1;
    best = Math.max(best, streak);
    hits += 1;
    hi = at + 1;
  }
  // Earlier matches and longer runs rank higher.
  return hits * 10 + best * 5 - hi;
}

export function tabHaystack(tab: Tab, group: Group | undefined | null): string {
  return `${tab.title} ${tab.type} ${group?.name ?? ""} ${tab.url ?? ""} ${tabSubtitle(tab)}`;
}

export type BarMode = "global" | "newtab";

export interface TabRow {
  kind: "tab";
  tab: Tab;
  group: Group | null;
  subtitle: string;
}
export interface CommandRow {
  kind: "command";
  command: AppCommand;
  label: string;
  keys?: string;
}
export interface SiteRow {
  kind: "site";
  site: VisitEntry;
}
export interface FallbackRow {
  kind: "fallback";
  input: string;
  /** The resolved address when the input IS one; null means "search it". */
  url: string | null;
}
export interface ProfileRow {
  kind: "profile";
  profile: ConfigProfile;
}
export interface ClosedRow {
  kind: "closed";
  slot: number;
  tab: Tab;
  /** Carried for the drawing code's "3m ago" note. */
  closedAt: number;
}
export interface ArchivedRow {
  kind: "archived";
  entry: ArchiveEntry;
  index: number;
}
export type BarRow =
  | TabRow
  | CommandRow
  | SiteRow
  | FallbackRow
  | ProfileRow
  | ClosedRow
  | ArchivedRow;

export interface BarSections {
  tabs: TabRow[];
  commands: CommandRow[];
  sites: SiteRow[];
  fallback: FallbackRow | null;
  profiles: ProfileRow[];
  closed: ClosedRow[];
  archived: ArchivedRow[];
}

export const NEW_PROFILE_PREFIX = "new:";

/** Rows shown per section; past this the list is a browser, not an answer. */
const SECTION_LIMIT = 6;
/** Commands offered on an empty query — the reach-for-first ones. */
const IDLE_COMMAND_LIMIT = 5;

export function barCommands(): Shortcut[] {
  return visibleShortcuts().filter(
    (s) =>
      !s.local &&
      s.command !== "command-bar" &&
      commandRunsAnywhere(String(s.command))
  );
}

export function buildBarSections(opts: {
  mode: BarMode;
  query: string;
  tabs: Tab[];
  groups: Group[];
  /** History pool, already ranked best-first (frequency × recency). */
  sites: VisitEntry[];
  /**
   * The terminal profiles the configuration file declares, passed in rather
   * than read here — this module is pure, and the profiles arrive over a
   * command like everything else the caller holds (src/components/
   * useProfiles.ts). Absent is the same as none, which is the state of every
   * caller that has nothing to do with profiles.
   */
  profiles?: readonly ConfigProfile[];
  closed?: readonly ClosedEntry[];
  archive?: readonly ArchiveEntry[];
}): BarSections {
  const { mode, tabs, groups } = opts;
  const query = opts.query.trim();
  const groupOf = (t: Tab) => groups.find((g) => g.id === t.groupId) ?? null;

  if (!query) {
    return {
      tabs: [],
      commands:
        mode === "global"
          ? barCommands()
              .slice(0, IDLE_COMMAND_LIMIT)
              .map((s) => ({
                kind: "command" as const,
                command: s.command as AppCommand,
                label: s.label,
                keys: s.keys,
              }))
          : [],
      sites: opts.sites
        .slice(0, SECTION_LIMIT)
        .map((site) => ({ kind: "site" as const, site })),
      fallback: null,
      // Nothing typed is not `new:` typed. The profiles are two keystrokes
      // and a colon away, and an idle bar that led with them would be
      // answering a question nobody asked.
      profiles: [],
      closed: [],
      archived: [],
    };
  }

  // ① Open tabs, dormant pinned items included — activating one wakes it.
  const tabRows: TabRow[] =
    mode === "global"
      ? tabs
          .map((t) => {
            const group = groupOf(t);
            return { t, group, s: subsequenceScore(query, tabHaystack(t, group)) };
          })
          .filter((r): r is { t: Tab; group: Group | null; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s)
          .slice(0, SECTION_LIMIT)
          .map((r) => ({
            kind: "tab" as const,
            tab: r.t,
            group: r.group,
            subtitle: tabSubtitle(r.t),
          }))
      : [];

  // ② App commands, matched on what the settings screen calls them.
  const commandRows: CommandRow[] =
    mode === "global"
      ? barCommands()
          .map((s) => ({
            s,
            score: subsequenceScore(query, `${s.label} ${String(s.command)}`),
          }))
          .filter((r): r is { s: Shortcut; score: number } => r.score !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, SECTION_LIMIT)
          .map((r) => ({
            kind: "command" as const,
            command: r.s.command as AppCommand,
            label: r.s.label,
            keys: r.s.keys,
          }))
      : [];

  // ③ History, through history.ts's own filter — substring over host,
  //   title and address — which preserves the pool's frequency × recency
  //   order, so both entrances suggest the same sites for the same letters.
  const siteRows: SiteRow[] = filterSites(opts.sites, query)
    .slice(0, SECTION_LIMIT)
    .map((site) => ({ kind: "site" as const, site }));

  const fallback: FallbackRow = { kind: "fallback", input: query, url: directUrl(query) };

  // ⑤ `new:<profile>` — the one row type that makes something rather than
  //   finding it. Derived from the profile list itself, never from a second
  //   copy of it: a profile added to the configuration file is offered here
  //   the next time the bar opens, and one deleted stops being offered, with
  //   nothing in this module to keep in step.
  const profileRows: ProfileRow[] =
    mode === "global" ? matchProfiles(query, opts.profiles ?? []) : [];

  const closedRows: ClosedRow[] =
    mode === "global"
      ? (opts.closed ?? [])
          .map((e, slot) => ({ e, slot }))
          .filter(({ e }) => recallHit(query, e.tab))
          .slice(0, SECTION_LIMIT)
          .map(({ e, slot }) => ({
            kind: "closed" as const,
            slot,
            tab: e.tab,
            closedAt: e.closedAt,
          }))
      : [];

  const archivedRows: ArchivedRow[] =
    mode === "global"
      ? (opts.archive ?? [])
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => recallHit(query, entry))
          .sort((a, b) => b.entry.archivedAt - a.entry.archivedAt)
          .slice(0, SECTION_LIMIT)
          .map(({ entry, index }) => ({
            kind: "archived" as const,
            entry,
            index,
          }))
      : [];

  return {
    tabs: tabRows,
    commands: commandRows,
    sites: siteRows,
    fallback,
    profiles: profileRows,
    closed: closedRows,
    archived: archivedRows,
  };
}

/**
 * The profiles a `new:…` query names, best match first — and none at all for
 * a query that does not carry the prefix.
 */
function matchProfiles(
  query: string,
  profiles: readonly ConfigProfile[]
): ProfileRow[] {
  const lower = query.toLowerCase();
  if (!lower.startsWith(NEW_PROFILE_PREFIX)) return [];
  const wanted = query.slice(NEW_PROFILE_PREFIX.length).trim();
  if (wanted === "") {
    return profiles
      .slice(0, SECTION_LIMIT)
      .map((profile) => ({ kind: "profile" as const, profile }));
  }
  return profiles
    .map((profile) => ({ profile, score: subsequenceScore(wanted, profile.name) }))
    .filter((r): r is { profile: ConfigProfile; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, SECTION_LIMIT)
    .map((r) => ({ kind: "profile" as const, profile: r.profile }));
}

function recallHit(
  query: string,
  entry: Pick<Tab, "title" | "url" | "cwd">
): boolean {
  const q = query.toLowerCase();
  return (
    entry.title.toLowerCase().includes(q) ||
    (entry.url ?? "").toLowerCase().includes(q) ||
    (entry.cwd ?? "").toLowerCase().includes(q)
  );
}

export function flattenRows(s: BarSections): BarRow[] {
  return [
    // The profiles lead when there are any, and there are any only when the
    // input begins `new:` — a prefix that is not an address, not a search
    // anybody means, and not the name of anything already open. Having asked
    // for exactly one thing, the user gets it on a bare Enter rather than
    // having to walk past a row offering to search the web for `new:deploy`.
    ...s.profiles,
    ...(s.fallback ? [s.fallback] : []),
    ...s.tabs,
    ...s.closed,
    ...s.sites,
    ...s.commands,
    ...s.archived,
  ];
}

export function inlineCompletion(
  query: string,
  sites: VisitEntry[]
): { host: string; rest: string } | null {
  const raw = query.trim();
  if (!raw || raw !== query || /\s/.test(raw)) return null;
  const q = raw.toLowerCase();
  for (const site of sites) {
    const host = site.host.toLowerCase();
    for (const candidate of [host, host.replace(/^www\./, "")]) {
      if (candidate.length > q.length && candidate.startsWith(q)) {
        return { host: candidate, rest: candidate.slice(q.length) };
      }
    }
  }
  return null;
}
