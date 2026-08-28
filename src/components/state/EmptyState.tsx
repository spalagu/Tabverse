import type { ComponentType } from "react";

export interface EmptyStateProps {
  /** An icons.tsx component reference (16×16 body, sized up to 24 here). */
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: string;
  hint?: string;
  /** At most one primary action. */
  action?: { label: string; run: () => void };
  /** An already-formatKeys'd key badge; empty means no badge. */
  kbd?: string;
}

export function EmptyState({ icon: Icon, title, hint, action, kbd }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon ? <Icon size={24} className="empty-state-icon" /> : null}
      <p className="empty-state-title">{title}</p>
      {hint ? <p className="empty-state-hint">{hint}</p> : null}
      {action ? (
        <button className="btn empty-state-action" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
      {kbd ? <kbd className="empty-state-kbd">{kbd}</kbd> : null}
    </div>
  );
}
