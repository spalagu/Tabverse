import type { ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { AlertIcon } from "../icons";

export interface ErrorStateProps {
  error: ErrorDescription;
  onRetry?: () => void;
  inline?: boolean;
}

function Details({ detail }: { detail: string }) {
  if (!detail) return null;
  return (
    <details className="error-details">
      <summary>{STR.common.details}</summary>
      <pre>{detail}</pre>
    </details>
  );
}

export function ErrorState({ error, onRetry, inline }: ErrorStateProps) {
  if (inline) {
    return (
      <div className="error-state error-state-inline" role="alert">
        <p className="error-state-title">
          {error.title}
          {error.next ? (
            <span className="error-state-next"> {error.next}</span>
          ) : null}
        </p>
        <Details detail={error.detail} />
      </div>
    );
  }
  return (
    <div className="error-state error-state-block" role="alert">
      <AlertIcon size={24} className="error-state-icon" />
      <p className="error-state-title">{error.title}</p>
      {error.next ? <p className="error-state-next">{error.next}</p> : null}
      <Details detail={error.detail} />
      {onRetry ? (
        <button className="btn" onClick={onRetry}>
          {STR.common.retry}
        </button>
      ) : null}
    </div>
  );
}
