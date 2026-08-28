import { useEffect, useState } from "react";

export interface LoadingStateProps {
  label: string;
  /** How long the task must have been running before anything shows. */
  delayMs?: number;
  inline?: boolean;
}

export function LoadingState({ label, delayMs = 150, inline }: LoadingStateProps) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const t = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(t);
  }, [delayMs]);
  if (!visible) return null;
  return (
    <div
      className={`loading-state ${
        inline ? "loading-state-inline" : "loading-state-block"
      }`}
      role="status"
    >
      <span className="loading-spinner" aria-hidden="true" />
      <span className="loading-still" aria-hidden="true">
        …
      </span>
      <span className="loading-label">{label}</span>
    </div>
  );
}
