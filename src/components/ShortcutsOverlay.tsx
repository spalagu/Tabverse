import { useEffect, useState } from "react";
import { useVisibleShortcuts, type Shortcut } from "../shortcuts";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import { CloseIcon } from "./icons";


const SECTION_TITLES = {
  tabs: STR.common.help.sectionTabs,
  terminal: STR.common.help.sectionTerminal,
  files: STR.common.help.sectionFiles,
  browser: STR.common.help.sectionBrowser,
  window: STR.common.help.sectionWindow,
} as const;

type SectionId = keyof typeof SECTION_TITLES;

const SECTION_OF: Record<string, SectionId> = {
  "new-terminal": "tabs",
  "new-files": "tabs",
  "new-browser": "tabs",
  "new-tab-menu": "tabs",
  "duplicate-tab": "tabs",
  "close-tab": "tabs",
  "reopen-closed": "tabs",
  switcher: "tabs",
  "jump-n": "tabs",
  "cycle-tabs": "tabs",
  "next-tab": "tabs",
  "prev-tab": "tabs",
  "toggle-pin": "tabs",
  "clear-terminal": "terminal",
  "command-blocks": "terminal",
  "split-pane-vertical": "terminal",
  "split-pane-horizontal": "terminal",
  "focus-pane-dir": "terminal",
  "zoom-pane": "terminal",
  "resize-pane-dir": "terminal",
  "toggle-broadcast": "terminal",
  "save-file": "files",
  "quick-open": "files",
  "terminal-panel": "files",
  "location-bar": "browser",
  reload: "browser",
  back: "browser",
  forward: "browser",
  "open-external": "browser",
  "copy-url": "browser",
  print: "browser",
  "history-panel": "browser",
  "downloads-panel": "browser",
  "zoom-in": "browser",
  "zoom-out": "browser",
  "zoom-reset": "browser",
  join: "window",
  "command-bar": "window",
  "toggle-sidebar": "window",
  find: "window",
  "shortcuts-help": "window",
};

export function ShortcutsOverlay() {
  const open = useStore((s) => s.shortcutsHelpOpen);
  const setShortcutsHelp = useStore((s) => s.setShortcutsHelp);
  const shortcuts = useVisibleShortcuts();
  // Round seven: the table is searchable — a 44-row wall is a list you
  // read once by accident. The filter matches label and rendered keys,
  // and empty sections drop out (the matrix counts rows on this same
  // render, so its cell keeps guarding the unfiltered truth).
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  // Esc closes, wherever focus sits; ⌘/ closes too via the command toggle.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsHelp(false);
      }
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [open, setShortcutsHelp]);

  if (!open) return null;

  const rows = shortcuts;
  const sections = (Object.keys(SECTION_TITLES) as SectionId[])
    .map((id) => ({
      id,
      title: SECTION_TITLES[id],
      rows: rows.filter(
        (s) => (SECTION_OF[String(s.command)] ?? "window") === id
      ),
    }))
    .map((sec) => ({
      ...sec,
      rows: q
        ? sec.rows.filter(
            (s) =>
              s.label.toLowerCase().includes(q) ||
              formatKeys(s.keys ?? "").toLowerCase().includes(q)
          )
        : sec.rows,
    }))
    .filter((sec) => q === "" || sec.rows.length > 0);

  const row = (s: Shortcut) => (
    <div className="shortcuts-row" key={String(s.command)}>
      <span className="shortcuts-keys">
        {s.keys && <kbd>{formatKeys(s.keys)}</kbd>}
      </span>
      <span className="shortcuts-label">{s.label}</span>
    </div>
  );

  return (
    <div className="overlay" onMouseDown={() => setShortcutsHelp(false)}>
      <div
        className="shortcuts-overlay"
        role="dialog"
        aria-label={STR.common.help.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h3>{STR.common.help.title}</h3>
          <input
            className="shortcuts-search"
            value={filter}
            spellCheck={false}
            placeholder={STR.common.help.filterPlaceholder}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (filter) setFilter("");
                else setShortcutsHelp(false);
              }
              e.stopPropagation();
            }}
          />
          <button
            className="icon-btn"
            title={STR.common.close}
            aria-label={STR.common.close}
            onClick={() => setShortcutsHelp(false)}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="shortcuts-body">
          {sections
            .filter((sec) => sec.rows.length > 0)
            .map((sec) => (
              <section key={sec.id} className="shortcuts-section">
                <h4>{sec.title}</h4>
                {sec.rows.map(row)}
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
