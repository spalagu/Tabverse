import { useEffect, useState } from "react";
import { STR } from "../strings";


interface Request {
  title: string;
  note: string;
  /** Export confirms the passphrase; import does not. */
  confirm: boolean;
  submitLabel: string;
  resolve: (value: string | null) => void;
}

let pending: ((r: Request) => void) | null = null;

/**
 * Ask for a passphrase; resolves to the entered value, or null if cancelled.
 * Resolves null when nothing is mounted to ask with — the safe direction.
 */
export function passphraseAsk(opts: {
  title: string;
  note: string;
  confirm: boolean;
  submitLabel: string;
}): Promise<string | null> {
  if (!pending) return Promise.resolve(null);
  return new Promise((resolve) => pending!({ ...opts, resolve }));
}

const SHORT = 8;

export function PassphraseHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");

  useEffect(() => {
    pending = (r) => {
      setFirst("");
      setSecond("");
      setRequest(r);
    };
    return () => {
      pending = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(null);
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // answer is stable enough for this modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;

  const answer = (value: string | null) => {
    request.resolve(value);
    setRequest(null);
    setFirst("");
    setSecond("");
  };

  const mismatch = request.confirm && second.length > 0 && first !== second;
  const ready =
    first.length > 0 && (!request.confirm || first === second);
  const short = first.length > 0 && first.length < SHORT;

  return (
    <div className="confirm-scrim" onMouseDown={() => answer(null)}>
      <div
        className="confirm-box migrate-passphrase"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="confirm-text">
          <strong>{request.title}</strong>
          <br />
          {request.note}
        </p>
        <input
          className="migrate-pass-input"
          type="password"
          autoFocus
          placeholder={STR.dialogs.passphrase.placeholder}
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready && !request.confirm) answer(first);
          }}
        />
        {request.confirm && (
          <input
            className="migrate-pass-input"
            type="password"
            placeholder={STR.dialogs.passphrase.repeatPlaceholder}
            value={second}
            onChange={(e) => setSecond(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) answer(first);
            }}
          />
        )}
        {mismatch && (
          <p className="migrate-pass-hint danger-text">
            {STR.dialogs.passphrase.mismatch}
          </p>
        )}
        {short && !mismatch && (
          <p className="migrate-pass-hint">
            {STR.dialogs.passphrase.shortWarning}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={() => answer(null)}>
            {STR.common.cancel}
          </button>
          <button
            className="btn"
            disabled={!ready}
            onClick={() => answer(first)}
          >
            {request.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
