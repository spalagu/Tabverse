import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import {
  APP_SHARE_LEVELS,
  SHARE_TTL_SECS,
  startAppShare,
  stopAppShare,
} from "../share/framework/actions";
import type { ShareAccess } from "../share/framework/capability";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "./state/ErrorState";
import { TTL_PRESETS } from "./ShareDialog";
import "./share-dialog.css";

/** The fallback copy targets and confirm-face control ids, distinct from
 * ShareDialog's so the two can never be open on one document with
 * clashing ids. */
const LINK_INPUT_ID = "app-share-link-input";
const TICKET_AREA_ID = "app-share-ticket-area";
const ACCESS_LABEL_ID = "app-share-access-label";
const TTL_SELECT_ID = "app-share-ttl-select";

export function AppSharePanel() {
  const open = useStore((s) => s.appSharePanelOpen);
  const share = useStore((s) => s.appShare);
  const setPanel = useStore((s) => s.setAppSharePanel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [copied, setCopied] = useState<"link" | "ticket" | null>(null);
  const [access, setAccess] = useState<ShareAccess>("steer");
  const [ttl, setTtl] = useState<number | null>(SHARE_TTL_SECS);

  // Every opening starts from the declared defaults, not from whatever
  // the previous opening left behind — the same reset the tab dialog
  // does, because this component too stays mounted while closed.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setCopied(null);
    setAccess("steer");
    setTtl(SHARE_TTL_SECS);
  }, [open]);

  // Esc closes — the panel is non-modal, so no overlay ever holds the
  // keyboard; this one listener is the whole of its modality.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setPanel]);

  if (!open) return null;
  const close = () => setPanel(false);
  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      await startAppShare({ access, ttlSecs: ttl });
    } catch (e) {
      setError(describeError(e, STR.errors.actions.startSharing));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    try {
      await stopAppShare();
    } finally {
      setBusy(false);
      close();
    }
  };

  const copy = async (text: string, which: "link" | "ticket") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: select the element for manual copy.
      const el = document.getElementById(
        which === "link" ? LINK_INPUT_ID : TICKET_AREA_ID
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      el?.select();
      document.execCommand("copy");
    }
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
  };

  return (
    <section className="app-share-panel" aria-label={STR.share.appPanelTitle}>
      <div className="app-share-panel-head">
        <span className="app-share-panel-title">
          {STR.share.appPanelTitle}
        </span>
      </div>
      {!share ? (
        <>
          <p className="dialog-text">{STR.share.appIntroBlurb}</p>
          {/* The confirm face, field for field the tab dialog's (the
              classes are share-dialog.css's own): the levels come from
              the app pair's declaration, the windows from the one
              TTL_PRESETS list — this panel adds no choice of its own. */}
          <div className="share-field">
            <span className="share-field-label" id={ACCESS_LABEL_ID}>
              {STR.share.accessLabel}
            </span>
            <div
              className="share-levels"
              role="radiogroup"
              aria-labelledby={ACCESS_LABEL_ID}
            >
              {APP_SHARE_LEVELS.map((l) => (
                <label
                  key={l}
                  className={`share-level${access === l ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="app-share-access"
                    value={l}
                    checked={access === l}
                    onChange={() => setAccess(l)}
                  />
                  <span className="share-level-name">
                    {STR.share.levelName[l]}
                  </span>
                  <span className="share-level-hint">
                    {STR.share.levelHint[l]}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="share-field share-field-row">
            <label className="share-field-label" htmlFor={TTL_SELECT_ID}>
              {STR.share.ttlLabel}
            </label>
            <select
              id={TTL_SELECT_ID}
              className="share-select"
              value={ttl === null ? "never" : String(ttl)}
              onChange={(e) =>
                setTtl(
                  e.target.value === "never" ? null : Number(e.target.value)
                )
              }
            >
              {TTL_PRESETS.map((p) =>
                p === null ? (
                  <option key="never" value="never">
                    {STR.share.ttlNever}
                  </option>
                ) : (
                  <option key={p} value={String(p)}>
                    {STR.share.ttlHours({ h: p / 3_600 })}
                  </option>
                )
              )}
            </select>
          </div>
          {error && <ErrorState inline error={error} />}
          <div className="dialog-actions">
            <button className="btn primary" onClick={begin} disabled={busy}>
              {busy ? STR.share.starting : STR.share.startSharing}
            </button>
            <button className="btn" onClick={close}>
              {STR.common.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="share-block">
            <div className="share-block-head">
              <span className="share-block-label">
                {STR.share.joinLinkLabel}
              </span>
              <span className="share-block-hint">
                {STR.share.joinLinkHint}
              </span>
            </div>
            <div className="share-copy-row">
              <input
                id={LINK_INPUT_ID}
                className="share-link-input"
                readOnly
                value={share.joinLink}
                aria-label={STR.share.joinLinkLabel}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                className="btn primary"
                onClick={() => void copy(share.joinLink, "link")}
              >
                {copied === "link" ? STR.share.copied : STR.share.copyLink}
              </button>
            </div>
          </div>
          <div className="share-block">
            <div className="share-block-head">
              <span className="share-block-label">
                {STR.share.rawTicketLabel}
              </span>
              <span className="share-block-hint">
                {STR.share.rawTicketHint}
              </span>
              <button
                className="btn share-copy-mini"
                onClick={() => void copy(share.ticket, "ticket")}
              >
                {copied === "ticket" ? STR.share.copied : STR.share.copyTicket}
              </button>
            </div>
            <textarea
              id={TICKET_AREA_ID}
              className="ticket-area"
              readOnly
              value={share.ticket}
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <p className="dialog-text share-summary">
            {STR.share.activeSummary({
              level: STR.share.levelName[share.access],
              window:
                share.ttlSecs === null
                  ? STR.share.windowNever
                  : STR.share.windowHours({
                      h: Math.round(share.ttlSecs / 3_600),
                    }),
            })}
          </p>
          {share.viewers.length === 0 ? (
            <p className="share-viewers-empty">{STR.share.noViewersYet}</p>
          ) : (
            <>
              <div className="app-share-roster-head">
                <span>
                  {STR.share.appRosterLabel({ n: share.viewers.length })}
                </span>
              </div>
              {share.viewers.map((v) => {
                const name = v.name || STR.share.viewerName({ id: v.id });
                return (
                  <div key={v.id} className="app-share-viewer-row">
                    <span className="share-viewer-name">{name}</span>
                    <span className="app-share-viewer-level">
                      {STR.share.levelName[v.access]}
                    </span>
                  </div>
                );
              })}
            </>
          )}
          {error && <ErrorState inline error={error} />}
          <div className="dialog-actions">
            <button className="btn danger" onClick={end} disabled={busy}>
              {STR.share.stopSharing}
            </button>
            <button className="btn" onClick={close}>
              {STR.common.close}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
