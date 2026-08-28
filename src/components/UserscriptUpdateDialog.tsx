import { useEffect, useMemo } from "react";
import { STR } from "../strings";
import { diffLines, type DiffLine } from "../userscriptDiff";

/**
 * How many diff lines the dialog renders before saying how many more
 * there are. The full diff is always computed and counted; only the DOM
 * is capped, so the "… N more lines" note is exact, never a guess.
 */
const MAX_RENDERED_LINES = 4000;

export interface UserscriptUpdateProposal {
  scriptId: string;
  name: string;
  currentVersion: string;
  newVersion: string;
  currentSource: string;
  newSource: string;
  /** The pinned URL the check fetched — shown so the user can see the
   *  source is the one they installed from, not one the script named. */
  installUrl: string;
}

interface Props {
  proposal: UserscriptUpdateProposal;
  busy: boolean;
  /** Perform the update; resolves false on failure (dialog stays open). */
  onApply: (proposal: UserscriptUpdateProposal) => Promise<boolean>;
  onCancel: () => void;
}

export function UserscriptUpdateDialog({
  proposal,
  busy,
  onApply,
  onCancel,
}: Props) {
  const T = STR.settings.userscripts.update;

  const diff = useMemo<DiffLine[]>(
    () => diffLines(proposal.currentSource, proposal.newSource),
    [proposal]
  );
  const shown = diff.slice(0, MAX_RENDERED_LINES);
  const rest = diff.length - shown.length;

  useEffect(() => {
    if (!proposal) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is the answer that costs nothing.
      if (e.key === "Escape") {
        onCancel();
      }
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [proposal, onCancel]);

  return (
    <div
      className="overlay"
      onMouseDown={() => !busy && onCancel()}
      data-us-update-dialog={proposal.scriptId}
    >
      <div
        className="dialog us-update-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={T.title({ name: proposal.name })}
      >
        <div className="dialog-title">{T.title({ name: proposal.name })}</div>
        <p className="dialog-text">{T.blurb}</p>
        <p className="pw-empty">
          {T.sourceNote({ url: proposal.installUrl })}{" "}
          {T.versionSpan({
            from: STR.settings.userscripts.version({
              version: proposal.currentVersion,
            }),
            to: STR.settings.userscripts.version({
              version: proposal.newVersion,
            }),
          })}
        </p>
        <p className="us-update-grants-note">{T.grantsCleared}</p>

        <div className="us-diff-legend" aria-hidden="true">
          <span className="us-diff-legend-del">{T.removedLegend}</span>
          <span className="us-diff-legend-add">{T.addedLegend}</span>
        </div>
        <pre className="us-diff">
          {shown.map((line, at) => (
            <div
              key={at}
              className={`us-diff-line us-diff-${line.kind}`}
            >{`${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}`}</div>
          ))}
        </pre>
        {rest > 0 && <p className="pw-empty">{T.moreLines({ count: rest })}</p>}

        <div className="btn-row">
          <button className="btn" onClick={onCancel} autoFocus disabled={busy}>
            {STR.common.cancel}
          </button>
          <button
            className="btn active"
            disabled={busy}
            onClick={() => void onApply(proposal)}
          >
            {busy ? T.applying : T.updateTo({ version: proposal.newVersion })}
          </button>
        </div>
      </div>
    </div>
  );
}
