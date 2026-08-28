import { useEffect, useRef, useState } from "react";
import {
  clearDownloads,
  openDownload,
  removeDownload,
  revealDownload,
  useDownloads,
  type DownloadEntry,
} from "../downloads";
import { confirmAsk } from "./Confirm";
import { relativeTime } from "./ArchivePanel";
import { CloseIcon, DownloadIcon, FolderIcon, TrashIcon } from "./icons";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { EmptyState } from "./state/EmptyState";
import { ErrorState } from "./state/ErrorState";
import { useStore } from "../state/store";


function stateLabel(e: DownloadEntry): string {
  return e.state === "downloading"
    ? STR.panels.downloads.stateDownloading
    : e.state === "done"
      ? STR.panels.downloads.stateDone
      : STR.panels.downloads.stateFailed;
}

export function DownloadsPanel({ onClose }: { onClose: () => void }) {
  const downloads = useDownloads();
  const revealPath = useStore((s) => s.revealPath);
  const ref = useRef<HTMLDivElement>(null);
  // A click that could not be honored says why, right here — the file may
  // have been moved or deleted since it landed, and a click that silently
  // does nothing reads as the panel being broken.
  const [note, setNote] = useState<ErrorDescription | null>(null);

  const tryAction = (action: Promise<void>, doing: string) => {
    setNote(null);
    void action.catch((e) => setNote(describeError(e, doing)));
  };

  useEffect(() => {
    const overConfirm = (target: EventTarget | null) =>
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
    // Capture phase — see the archive panel for why bubble phase is not
    // enough over the sidebar's drag surface.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const clearAll = async () => {
    const n = downloads.length;
    if (
      !(await confirmAsk(STR.panels.downloads.clearAllQuestion({ count: n }), {
        confirmLabel: STR.panels.clearAll,
      }))
    )
      return;
    clearDownloads();
  };

  return (
    <div className="pw-window downloads-window" ref={ref}>
      <header className="pw-window-head">
        <span className="pw-count">
          {downloads.length === 0
            ? STR.panels.downloads.emptyCount
            : STR.panels.downloads.count({ count: downloads.length })}
        </span>
        <span className="archive-head-space" />
        <button
          className="mini-btn"
          disabled={downloads.length === 0}
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

      {note && <ErrorState inline error={note} />}

      {downloads.length === 0 ? (
        <EmptyState icon={DownloadIcon} title={STR.panels.downloads.emptyBlurb} />
      ) : (
        <div className="pw-window-list">
          {downloads.map((e) => (
            <div
              className={`pw-row download-row${e.state === "done" ? " openable" : ""}`}
              key={`${e.path}@${e.at}`}
              title={e.path}
              data-download-name={e.name}
              data-download-state={e.state}
              onClick={() => {
                // Only a settled file is worth handing to another app: a
                // half-written one opens as garbage, a failed one is gone.
                if (e.state === "done")
                  tryAction(openDownload(e.path), STR.errors.actions.openDownload);
              }}
            >
              <DownloadIcon className="tab-icon" />
              <span className="pw-host">{e.name}</span>
              <span className={`download-state ${e.state}`}>{stateLabel(e)}</span>
              <span className="archive-when">{relativeTime(e.at)}</span>
              <span className="pw-row-actions">
                <button
                  className="mini-btn"
                  title={STR.panels.downloads.revealHint}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    tryAction(
                      revealDownload(e.path),
                      STR.errors.actions.revealDownload
                    );
                  }}
                >
                  {STR.panels.downloads.reveal}
                </button>
                {e.state === "done" && (
                  <button
                    className="mini-btn"
                    title={STR.panels.downloads.openInFilesHint}
                    aria-label={STR.panels.downloads.openInFilesHint}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      tryAction(
                        // Waking a dormant files tab is the channel's own
                        // behavior ("the user asked to see a file; a
                        // shelved tab may not swallow the jump") — reused,
                        // not re-decided here.
                        Promise.resolve(revealPath(e.path)).then(() => undefined),
                        STR.errors.actions.openInFiles
                      );
                    }}
                  >
                    <FolderIcon />
                  </button>
                )}
                <button
                  className="mini-btn"
                  title={STR.panels.downloads.deleteRecordHint}
                  aria-label={STR.panels.downloads.deleteRecordHint}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    removeDownload(e.path, e.at);
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
