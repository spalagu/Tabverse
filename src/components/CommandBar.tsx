import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runAppCommand } from "../appCommands";
import {
  buildBarSections,
  flattenRows,
  inlineCompletion,
  type BarMode,
  type BarRow,
} from "../commandBar";
import { topSites, type VisitEntry } from "../history";
import { SEARCH_ENGINES, searchUrl } from "../search";
import { groupColor, useStore } from "../state/store";
import { relativeTime } from "./ArchivePanel";
import { tabSubtitle } from "../tabMeta";
import { CompletionInput } from "./CompletionInput";
import { useProfiles } from "./useProfiles";
import { TAB_ICONS } from "./icons";
import { STR } from "../strings";
import { formatKeys, HINT_KEYS } from "../strings/formatKeys";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What a `new:<profile>` row opens is a terminal, so it wears the terminal's
 *  own icon rather than a second drawing of the same idea. */
const ProfileIcon = TAB_ICONS.terminal;

/**
 * How many sites are held for filtering. Typing has to reach past the few
 * shown rows — a site you visit weekly is not in the top eight but is
 * exactly what three typed letters are aimed at.
 */
const POOL = 60;

export function useBarEntry(opts: {
  mode: BarMode;
  /** Reload the history pool while true (the bar opening, the page mounting). */
  active: boolean;
  /** Open an address: the bar makes a new browser tab, the new-tab page navigates its own. */
  openUrl: (url: string) => void;
  /** A pick or Esc is done with the entry: the bar closes, the page clears. */
  close: () => void;
}) {
  const { mode, active, openUrl, close } = opts;
  const allTabs = useStore((s) => s.tabs);
  // groupColor reads the resolved theme; repaint group tints on a switch.
  useStore((s) => s.resolvedTheme);
  const tabs = useMemo(
    () => allTabs.filter((t) => t.peek !== true),
    [allTabs]
  );
  const groups = useStore((s) => s.groups);
  const archive = useStore((s) => s.archive);
  const closedCount = useStore((s) => s.closedCount);
  const closed = useMemo(
    () => useStore.getState().recentlyClosed(),
    [tabs, closedCount]
  );
  const [pool, setPool] = useState<VisitEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void topSites(POOL).then((list) => {
      if (alive) setPool(list);
    });
    return () => {
      alive = false;
    };
  }, [active]);

  // The profiles are re-read each time the bar opens, so a profile added to
  // the configuration file a minute ago is offered by the `new:` rows now.
  const { list: profiles } = useProfiles(active);
  const sections = useMemo(
    () =>
      buildBarSections({
        mode,
        query,
        tabs,
        groups,
        sites: pool,
        profiles,
        closed,
        archive,
      }),
    [mode, query, tabs, groups, pool, profiles, closed, archive]
  );
  const rows = useMemo(() => flattenRows(sections), [sections]);
  const ghost = useMemo(() => inlineCompletion(query, pool), [query, pool]);

  const setInput = useCallback((value: string) => {
    setQuery(value);
    setSel(0);
  }, []);

  const reset = useCallback(() => {
    setQuery("");
    setSel(0);
  }, []);

  const run = useCallback(
    (row: BarRow | undefined) => {
      if (!row) return;
      switch (row.kind) {
        case "tab":
          // Waking a dormant pinned item is activateTab's own semantics.
          useStore.getState().activateTab(row.tab.id);
          break;
        case "command":
          runAppCommand(row.command);
          break;
        case "site":
          openUrl(row.site.url);
          break;
        case "fallback":
          openUrl(row.url ?? searchUrl(row.input));
          break;
        case "profile":
          // The name, not what it means: the shell, the environment and the
          // start command are read from the file when the PTY is spawned.
          useStore
            .getState()
            .addTab({ type: "terminal", profile: row.profile.name });
          break;
        case "closed":
          // The row reopens its OWN entry — the slot names it — not
          // whatever the queue's head happens to be by click time.
          useStore.getState().reopenClosedTab(row.slot);
          break;
        case "archived":
          useStore.getState().unarchiveEntry(row.index);
          break;
        default: {
          // EXHAUSTIVENESS, and it is not decoration. Until this line existed
          // a new row type compiled, drew nothing and did nothing: the switch
          // fell through and the section it belonged to was simply never
          // written into the list below. The next person to add one is
          // stopped here, by the compiler, instead of by a user who cannot
          // find the row they just added.
          const unhandled: never = row;
          throw new Error(`unhandled command bar row: ${JSON.stringify(unhandled)}`);
        }
      }
      close();
    },
    [openUrl, close]
  );

  const acceptGhost = useCallback(() => {
    if (ghost) setInput(query + ghost.rest);
  }, [ghost, query, setInput]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const cmdArrow = e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
      if (e.nativeEvent.isComposing && !cmdArrow) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(rows[sel]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab" && ghost) {
        e.preventDefault();
        acceptGhost();
      } else if (e.key === "ArrowRight" && ghost) {
        // Only from the end of the text: mid-string, → is caret movement.
        const el = e.currentTarget;
        if (el.selectionStart === query.length && el.selectionEnd === query.length) {
          e.preventDefault();
          acceptGhost();
        }
      }
      e.stopPropagation();
    },
    [rows, sel, ghost, query.length, run, close, acceptGhost]
  );

  return { query, setInput, reset, sections, rows, sel, setSel, ghost, run, onKeyDown };
}

/** The engine name the fallback row advertises (never the template itself). */
function engineLabel(): string {
  const s = useStore.getState();
  // "your search engine" also answers a setting that has not been read:
  // the row is honest either way, and naming an engine the file has not
  // named yet would be a guess shown as fact.
  return s.searchEngine === null || s.searchEngine === "custom"
    ? STR.common.bar.yourSearchEngine
    : SEARCH_ENGINES[s.searchEngine].label;
}

export function CommandBar() {
  const open = useStore((s) => s.commandBarOpen);
  const setCommandBar = useStore((s) => s.setCommandBar);
  const inputRef = useRef<HTMLInputElement>(null);

  const entry = useBarEntry({
    mode: "global",
    active: open,
    // A picked site or a committed query lands as a NEW browser tab at the
    // top of the today zone (addTab's own placement) and navigates there.
    openUrl: (url) => {
      useStore.getState().addTab({ type: "browser", url });
    },
    close: () => setCommandBar(false),
  });
  const { reset } = entry;

  useEffect(() => {
    if (!open) return;
    reset();
    setTimeout(() => inputRef.current?.focus(), 0);
    // Summoned over a browser page, the keyboard is still with the page;
    // the bar is nothing but an input, so the UI has to take it back.
    if (isTauri) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("ui_focus").catch(() => {})
      );
    }
  }, [open, reset]);

  if (!open) return null;

  const { sections, sel, setSel, run } = entry;
  // Rows carry their flat index so the arrows and the mouse agree.
  let at = 0;
  const rowIndex = () => at++;

  const rowButton = (
    row: BarRow,
    i: number,
    key: string,
    body: React.ReactNode
  ) => (
    <button
      key={key}
      className={`command-bar-row${i === sel ? " sel" : ""}${
        row.kind === "tab" && row.tab.dormant === true ? " dormant" : ""
      }`}
      data-row-kind={row.kind}
      data-tab-id={row.kind === "tab" ? row.tab.id : undefined}
      onMouseEnter={() => setSel(i)}
      onClick={() => run(row)}
    >
      {body}
    </button>
  );

  return (
    <div className="overlay" onMouseDown={() => setCommandBar(false)}>
      <div className="command-bar" onMouseDown={(e) => e.stopPropagation()}>
        <CompletionInput
          inputRef={inputRef}
          className="command-bar-input"
          placeholder={STR.common.bar.placeholder}
          value={entry.query}
          ghost={entry.ghost?.rest ?? ""}
          onChange={entry.setInput}
          onKeyDown={entry.onKeyDown}
        />
        <div className="command-bar-list">
          {sections.profiles.length > 0 && (
            <div className="command-bar-section">
              {STR.common.bar.sectionProfiles}
            </div>
          )}
          {sections.profiles.map((r) =>
            rowButton(
              r,
              rowIndex(),
              `profile-${r.profile.name}`,
              <>
                <ProfileIcon size={14} />
                <span className="command-bar-title">
                  {STR.common.bar.newUnderProfile({ name: r.profile.name })}
                </span>
                {r.profile.cwd && (
                  <span className="command-bar-note">{r.profile.cwd}</span>
                )}
              </>
            )
          )}
          {sections.fallback &&
            rowButton(
              sections.fallback,
              rowIndex(),
              "fallback",
              <span className="command-bar-title">
                {sections.fallback.url !== null
                  ? STR.common.bar.openUrl({ url: sections.fallback.url })
                  : STR.common.bar.searchFor({
                      engine: engineLabel(),
                      query: sections.fallback.input,
                    })}
              </span>
            )}
          {sections.tabs.length > 0 && (
            <div className="command-bar-section">{STR.common.bar.sectionTabs}</div>
          )}
          {sections.tabs.map((r) => {
            const Icon = TAB_ICONS[r.tab.type];
            return rowButton(
              r,
              rowIndex(),
              `tab-${r.tab.id}`,
              <>
                <Icon size={14} />
                <span className="command-bar-title">{r.tab.title}</span>
                {r.subtitle && (
                  <span className="command-bar-note">{r.subtitle}</span>
                )}
                {r.group && (
                  <span
                    className="command-bar-group"
                    style={{ color: groupColor(r.group) }}
                  >
                    {r.group.name}
                  </span>
                )}
              </>
            );
          })}
          {sections.closed.length > 0 && (
            <div className="command-bar-section">
              {STR.common.bar.sectionClosed}
            </div>
          )}
          {sections.closed.map((r) => {
            const Icon = TAB_ICONS[r.tab.type];
            return rowButton(
              r,
              rowIndex(),
              `closed-${r.tab.id}`,
              <>
                <Icon size={14} />
                <span className="command-bar-title">{r.tab.title}</span>
                <span className="command-bar-note">{tabSubtitle(r.tab)}</span>
                <span className="command-bar-note">
                  {relativeTime(r.closedAt)}
                </span>
              </>
            );
          })}
          {sections.sites.length > 0 && (
            <div className="command-bar-section">{STR.common.bar.sectionHistory}</div>
          )}
          {sections.sites.map((r) =>
            rowButton(
              r,
              rowIndex(),
              `site-${r.site.url}`,
              <>
                <span className="command-bar-title">
                  {r.site.title || r.site.host}
                </span>
                <span className="command-bar-note">{r.site.host}</span>
              </>
            )
          )}
          {sections.commands.length > 0 && (
            <div className="command-bar-section">{STR.common.bar.sectionCommands}</div>
          )}
          {sections.commands.map((r) =>
            rowButton(
              r,
              rowIndex(),
              `cmd-${r.command}`,
              <>
                <span className="command-bar-title">{r.label}</span>
                {r.keys && <kbd>{formatKeys(r.keys)}</kbd>}
              </>
            )
          )}
          {sections.archived.length > 0 && (
            <div className="command-bar-section">
              {STR.common.bar.sectionArchived}
            </div>
          )}
          {sections.archived.map((r) => {
            const Icon = TAB_ICONS[r.entry.type];
            const where = r.entry.url ?? r.entry.cwd;
            return rowButton(
              r,
              rowIndex(),
              `archived-${r.entry.id}`,
              <>
                <Icon size={14} />
                <span className="command-bar-title">{r.entry.title}</span>
                {where && <span className="command-bar-note">{where}</span>}
                <span className="command-bar-note">
                  {relativeTime(r.entry.archivedAt)}
                </span>
              </>
            );
          })}
        </div>
        <div className="command-bar-hints">
          <span>
            {STR.common.hints.choose({ keys: formatKeys(HINT_KEYS.upDown) })}
          </span>
          <span>
            {STR.common.hints.run({ keys: formatKeys(HINT_KEYS.enter) })}
          </span>
          <span>
            {STR.common.hints.complete({
              keys: formatKeys(HINT_KEYS.rightOrTab),
            })}
          </span>
          <span>
            {STR.common.hints.close({ keys: formatKeys(HINT_KEYS.escape) })}
          </span>
        </div>
      </div>
    </div>
  );
}
