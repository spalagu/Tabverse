import { useEffect, useState } from "react";
import { STR } from "../strings";


/** One way to proceed. `value` is what the asker gets back. */
export interface ConfirmChoice {
  label: string;
  value: string;
  danger?: boolean;
}

interface Request {
  message: string;
  choices: ConfirmChoice[];
  /** null is the cancel answer — Escape, the scrim, or the Cancel button. */
  resolve: (value: string | null) => void;
}

let pending: ((r: Request) => void) | null = null;

/**
 * Ask with several ways to proceed; null means cancelled.
 *
 * Answers null when nothing is mounted to ask with — the safe direction: a
 * missing dialog must not be a way to perform a deletion unasked.
 */
export function confirmChoose(
  message: string,
  choices: ConfirmChoice[]
): Promise<string | null> {
  if (!pending) return Promise.resolve(null);
  return new Promise((resolve) => pending!({ message, choices, resolve }));
}

/** Ask a yes/no question, and wait for the answer. */
export function confirmAsk(
  message: string,
  options?: { confirmLabel?: string; danger?: boolean }
): Promise<boolean> {
  return confirmChoose(message, [
    {
      label: options?.confirmLabel ?? STR.common.proceed,
      value: "ok",
      danger: options?.danger ?? true,
    },
  ]).then((v) => v === "ok");
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    pending = (r) => setRequest(r);
    return () => {
      pending = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is the answer that costs nothing, so it is the one the key
      // that means "get me out of here" gives.
      if (e.key === "Escape") {
        request.resolve(null);
        setRequest(null);
      }
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request]);

  if (!request) return null;
  const answer = (value: string | null) => {
    request.resolve(value);
    setRequest(null);
  };

  return (
    <div className="confirm-scrim" onMouseDown={() => answer(null)}>
      <div
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const box = e.currentTarget;
          const focusable = Array.from(
            box.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <p className="confirm-text">{request.message}</p>
        <div className="confirm-actions">
          {/* Cancel first and focused: the free answer is the default. */}
          <button className="btn" onClick={() => answer(null)} autoFocus>
            {STR.common.cancel}
          </button>
          {request.choices.map((c) => (
            <button
              key={c.value}
              className={`btn${c.danger ? " danger" : ""}`}
              onClick={() => answer(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
