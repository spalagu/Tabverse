import { useEffect, useRef, useState } from "react";
import { STR } from "../strings";

export interface TerminalBlockOutcome {
  readonly exitCode?: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/** Transient command outcome badge shown in a terminal pane. */
export function TerminalBlockStatusPill({
  finished,
}: {
  readonly finished: TerminalBlockOutcome | null;
}) {
  const [shown, setShown] = useState(false);
  const stamp = finished?.finishedAt ?? null;
  const finishedRef = useRef(finished);
  finishedRef.current = finished;

  useEffect(() => {
    if (stamp === null) return;
    setShown(true);
    if (finishedRef.current?.exitCode === 0) {
      const timer = window.setTimeout(() => setShown(false), 4000);
      return () => window.clearTimeout(timer);
    }
  }, [stamp]);

  if (finished === null || finished.finishedAt === undefined) return null;
  const failed = finished.exitCode !== undefined && finished.exitCode !== 0;

  return (
    <div
      key={finished.finishedAt}
      className={`term-status-pill${shown ? "" : " hide"}${failed ? " dismissible" : ""}`}
      role="status"
      onClick={failed ? () => setShown(false) : undefined}
    >
      <span aria-hidden="true" className={`term-status-dot ${failed ? "fail" : "ok"}`} />
      <span>
        {failed
          ? STR.term.statusExit({ code: finished.exitCode ?? 0 })
          : STR.term.statusOk}
      </span>
      <span className="term-status-time">
        {duration(finished.finishedAt - finished.startedAt)}
      </span>
    </div>
  );
}
