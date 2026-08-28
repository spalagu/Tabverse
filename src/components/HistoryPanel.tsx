import { useEffect, useRef, useState } from "react";
import {
  clearHistory,
  deleteVisit,
  filterVisits,
  groupVisitsByDay,
  hostOf,
  recentVisits,
  type VisitLogEntry,
} from "../history";
import { useStore } from "../state/store";
import { relativeTime } from "./ArchivePanel";
import { confirmAsk } from "./Confirm";
import { STR } from "../strings";
import { EmptyState } from "./state/EmptyState";
import { SearchIcon } from "./icons";
import { CloseIcon, TrashIcon } from "./icons";


/** One shelf: a day label over its rows. */
function DayShelf({
  label,
  rows,
  onOpen,
  onDelete,
}: {
  label: string;
  rows: VisitLogEntry[];
  onOpen: (e: VisitLogEntry) => void;
  onDelete: (e: VisitLogEntry) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="history-day">{label}</div>
      {rows.map((e) => (
        <div
          className="pw-row history-row"
          key={`${e.url}@${e.at}`}
          title={e.url}
          data-visit-url={e.url}
          data-visit-at={e.at}
          onClick={() => onOpen(e)}
        >
          <span className="pw-host">{e.title || e.url}</span>
          <span className="pw-user">{hostOf(e.url)}</span>
          <span className="archive-when">{relativeTime(e.at)}</span>
          <span className="pw-row-actions">
            <button
              className="mini-btn"
              title={STR.panels.archive.deleteEntryHint}
              aria-label={STR.panels.archive.deleteEntryHint}
              onClick={(ev) => {
                ev.stopPropagation();
                onDelete(e);
              }}
            >
              <TrashIcon />
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<VisitLogEntry[]>([]);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void recentVisits().then((list) => {
      if (alive) setEntries(list);
    });
    // ⌘Y over a browser page leaves the keyboard with the page; the panel
    // is mostly an input, so the UI takes it back (same as the command bar).
    setTimeout(() => inputRef.current?.focus(), 0);
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("ui_focus").catch(() => {})
      );
    }
    return () => {
      alive = false;
    };
  }, []);

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
    // is a window-drag surface whose script swallows bubble-phase presses
    // (the archive panel learned this the hard way).
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const filtered = filterVisits(entries, query);
  const groups = groupVisitsByDay(filtered, Date.now());

  const open = (e: VisitLogEntry) => {
    useStore.getState().addTab({ type: "browser", url: e.url });
    onClose();
  };

  const remove = (e: VisitLogEntry) => {
    deleteVisit(e.url, e.at);
    setEntries((list) =>
      list.filter((x) => !(x.url === e.url && x.at === e.at))
    );
  };

  const clearAll = async () => {
    const n = entries.length;
    if (
      !(await confirmAsk(STR.panels.history.clearAllQuestion({ count: n }), {
        confirmLabel: STR.panels.clearAll,
      }))
    )
      return;
    clearHistory();
    setEntries([]);
  };

  return (
    <div className="pw-window history-window" ref={ref}>
      <header className="pw-window-head">
        <input
          ref={inputRef}
          className="pw-filter"
          placeholder={STR.panels.history.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="pw-count">
          {entries.length === 0
            ? STR.panels.history.emptyCount
            : STR.panels.history.count({ count: entries.length })}
        </span>
        <button
          className="mini-btn"
          disabled={entries.length === 0}
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

      {entries.length === 0 ? (
        <EmptyState icon={SearchIcon} title={STR.panels.history.emptyBlurb} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={SearchIcon} title={STR.panels.history.noMatch} />
      ) : (
        <div className="pw-window-list">
          <DayShelf
            label={STR.panels.history.dayToday}
            rows={groups.today}
            onOpen={open}
            onDelete={remove}
          />
          <DayShelf
            label={STR.panels.history.dayYesterday}
            rows={groups.yesterday}
            onOpen={open}
            onDelete={remove}
          />
          <DayShelf
            label={STR.panels.history.dayEarlier}
            rows={groups.earlier}
            onOpen={open}
            onDelete={remove}
          />
        </div>
      )}
    </div>
  );
}
