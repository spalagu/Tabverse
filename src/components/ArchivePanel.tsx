import { useEffect, useRef, useState } from "react";
import { useStore, type ArchiveEntry } from "../state/store";
import { confirmAsk } from "./Confirm";
import { shortPath } from "../tabMeta";
import { CloseIcon, TAB_ICONS, TrashIcon } from "./icons";
import { STR } from "../strings";
import { EmptyState } from "./state/EmptyState";
import { ArchiveIcon } from "./icons";


function domainOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** What kind of thing this was: a domain for a page, a place for work. */
function subtitleOf(entry: ArchiveEntry): string {
  if (entry.type === "browser") return domainOf(entry.url);
  return entry.cwd ? shortPath(entry.cwd) : "";
}

export function filterArchiveEntries<T extends { entry: ArchiveEntry }>(
  rows: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter(
    ({ entry }) =>
      entry.title.toLowerCase().includes(q) ||
      (entry.url ?? "").toLowerCase().includes(q) ||
      (entry.cwd ?? "").toLowerCase().includes(q)
  );
}

export function relativeTime(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return STR.panels.time.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return STR.panels.time.minutesAgo({ m });
  const h = Math.round(m / 60);
  if (h < 24) return STR.panels.time.hoursAgo({ h });
  const d = Math.round(h / 24);
  return STR.panels.time.daysAgo({ d });
}

export function ArchivePanel({ onClose }: { onClose: () => void }) {
  const archive = useStore((s) => s.archive);
  const evicted = useStore((s) => s.archiveEvicted);
  const unarchiveEntry = useStore((s) => s.unarchiveEntry);
  const removeArchiveEntry = useStore((s) => s.removeArchiveEntry);
  const clearArchive = useStore((s) => s.clearArchive);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const overConfirm = (target: EventTarget | null) =>
      // While the app's own confirm dialog is up, its keys and clicks are
      // about that question, not about this panel.
      !!document.querySelector(".confirm-scrim") ||
      !!(target instanceof Element && target.closest(".confirm-scrim"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || overConfirm(null)) return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || overConfirm(e.target)) return;
      onClose();
    };
    // Capture phase, and it is load-bearing: the sidebar's empty background
    // is a window-drag surface whose script swallows bubble-phase presses,
    // which is exactly how the sidebar menu once refused to close.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    // The panel is mostly a list, but a filter was typed into it the last
    // time anyone opened one — the input takes the keyboard back, the
    // history panel's gesture.
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  // Newest first: the page just shelved is the one most likely wanted back.
  // The original index rides along, because the actions address the array.
  const rows = archive
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.archivedAt - a.entry.archivedAt);
  // The filter runs over the mapped rows, so a filtered row keeps the
  // index it was given — a restore or a delete after filtering addresses
  // the entry the row shows, never its position in the filtered list.
  const shown = filterArchiveEntries(rows, query);

  const clearAll = async () => {
    const n = archive.length;
    if (
      !(await confirmAsk(STR.panels.archive.clearAllQuestion({ count: n }), {
        confirmLabel: STR.panels.clearAll,
      }))
    )
      return;
    clearArchive();
  };

  return (
    <div className="pw-window archive-window" ref={ref}>
      <header className="pw-window-head">
        <input
          ref={inputRef}
          className="pw-filter"
          placeholder={STR.panels.archive.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="pw-count">
          {archive.length === 0
            ? STR.panels.archive.emptyCount
            : STR.panels.archive.count({ count: archive.length })}
        </span>
        <button
          className="mini-btn"
          disabled={archive.length === 0}
          onClick={() => void clearAll()}
        >
          {STR.panels.clearAll}
        </button>
        <button
          className="mini-btn"
          title={STR.common.close}
          aria-label={STR.common.close}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>

      {query.trim() && evicted > 0 && archive.length > 0 && (
        <p className="pw-note">{STR.panels.archive.evictedLine({ count: evicted })}</p>
      )}

      {archive.length === 0 ? (
        <EmptyState icon={ArchiveIcon} title={STR.panels.archive.emptyBlurb} />
      ) : shown.length === 0 ? (
        <EmptyState icon={ArchiveIcon} title={STR.panels.archive.noMatch} />
      ) : (
        <div className="pw-window-list">
          {shown.map(({ entry, index }) => {
            const Icon = TAB_ICONS[entry.type];
            return (
            <div
              className="pw-row archive-row"
              key={entry.id}
              title={entry.url ?? entry.cwd ?? entry.title}
              onClick={() => {
                unarchiveEntry(index);
                // The click asked for that work back; the panel would only
                // stand between the user and it.
                onClose();
              }}
            >
              <Icon className="tab-icon" />
              <span className="pw-host">
                {entry.title || subtitleOf(entry) || entry.url || ""}
              </span>
              <span className="pw-user">{subtitleOf(entry)}</span>
              <span className="archive-when">
                {relativeTime(entry.archivedAt)}
              </span>
              <span className="pw-row-actions">
                <button
                  className="mini-btn"
                  title={STR.panels.archive.deleteEntryHint}
                  aria-label={STR.panels.archive.deleteEntryHint}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeArchiveEntry(index);
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
