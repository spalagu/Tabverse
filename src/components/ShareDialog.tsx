import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import {
  SHARE_TTL_SECS,
  kickViewer,
  setViewerAccess,
  startShare,
  stopShare,
} from "../share/framework/actions";
import {
  shareCapability,
  type ShareAccess,
} from "../share/framework/capability";
import {
  shareBlockedReason,
  shareBlockedText,
} from "../share/framework/terminalBlocking";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "./state/ErrorState";
import "./share-dialog.css";


/** The join-window choices; null is the explicit "no expiry". Exported
 * because the whole-app panel offers the very same choices — one list,
 * so the two faces can never drift on what a window can be. */
export const TTL_PRESETS: readonly (number | null)[] = [
  3_600,
  28_800,
  SHARE_TTL_SECS,
  null,
];

export function ShareDialog() {
  const tabId = useStore((s) => s.shareDialogTabId);
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.shareDialogTabId));
  const setShareDialogTab = useStore((s) => s.setShareDialogTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [copied, setCopied] = useState<"link" | "ticket" | null>(null);
  const [access, setAccess] = useState<ShareAccess>("view");
  const [ttl, setTtl] = useState<number | null>(SHARE_TTL_SECS);

  const cap = tab ? shareCapability(tab.type) : null;
  const levels: readonly ShareAccess[] = cap?.shareable ? cap.levels : [];
  const blockedReason = shareBlockedReason(tab);
  const blockedText = shareBlockedText(blockedReason);

  // Every opening starts from the type's declared default, not from whatever
  // the previous opening left behind — the component itself stays mounted.
  useEffect(() => {
    if (!tabId) return;
    setError(null);
    setCopied(null);
    setTtl(SHARE_TTL_SECS);
    const t = useStore.getState().tabs.find((x) => x.id === tabId);
    const c = t ? shareCapability(t.type) : null;
    if (c?.shareable) setAccess(c.defaultLevel);
    // The declared default depends only on the tab, so tabId is the trigger.
  }, [tabId]);

  if (!tabId || !tab || !cap?.shareable) return null;
  const close = () => setShareDialogTab(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      await startShare(tabId, { access, ttlSecs: ttl });
    } catch (e) {
      setError(describeError(e, STR.errors.actions.startSharing));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    try {
      await stopShare(tabId);
    } finally {
      setBusy(false);
      close();
    }
  };

  const kick = async (viewer: number) => {
    setError(null);
    try {
      await kickViewer(tabId, viewer);
    } catch (e) {
      setError(describeError(e, STR.errors.actions.kickViewer));
    }
  };

  const changeViewerAccess = async (viewer: number, level: ShareAccess) => {
    setError(null);
    try {
      await setViewerAccess(tabId, viewer, level);
    } catch (e) {
      setError(describeError(e, STR.errors.actions.setViewerAccess));
    }
  };

  const copy = async (text: string, which: "link" | "ticket") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: select the element for manual copy.
      const el = document.getElementById(
        which === "link" ? "share-link-input" : "share-ticket-area"
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      el?.select();
      document.execCommand("copy");
    }
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          {STR.share.dialogTitle({ title: tab.title })}
        </div>
        {!tab.share ? (
          <>
            <p className="dialog-text">{blockedText ?? STR.share.introBlurb}</p>
            <div className="share-field">
              <span className="share-field-label" id="share-access-label">
                {STR.share.accessLabel}
              </span>
              <div
                className="share-levels"
                role="radiogroup"
                aria-labelledby="share-access-label"
              >
                {levels.map((l) => (
                  <label
                    key={l}
                    className={`share-level${access === l ? " selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="share-access"
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
              <label className="share-field-label" htmlFor="share-ttl-select">
                {STR.share.ttlLabel}
              </label>
              <select
                id="share-ttl-select"
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
              <button className="btn" onClick={close}>
                {STR.common.cancel}
              </button>
              <button
                className="btn primary"
                onClick={begin}
                disabled={busy || blockedReason !== null}
                title={blockedText ?? undefined}
              >
                {busy ? STR.share.starting : STR.share.startSharing}
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
                  id="share-link-input"
                  className="share-link-input"
                  readOnly
                  value={tab.share.joinLink}
                  aria-label={STR.share.joinLinkLabel}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  className="btn primary"
                  onClick={() => void copy(tab.share!.joinLink, "link")}
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
                  onClick={() => void copy(tab.share!.ticket, "ticket")}
                >
                  {copied === "ticket" ? STR.share.copied : STR.share.copyTicket}
                </button>
              </div>
              <textarea
                id="share-ticket-area"
                className="ticket-area"
                readOnly
                value={tab.share.ticket}
                rows={3}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            <p className="dialog-text share-summary">
              {STR.share.activeSummary({
                level: STR.share.levelName[tab.share.access],
                window:
                  tab.share.ttlSecs === null
                    ? STR.share.windowNever
                    : STR.share.windowHours({
                        h: Math.round(tab.share.ttlSecs / 3_600),
                      }),
              })}{" "}
              {STR.share.connectedStayNote}
            </p>
            <div className="share-viewers">
              {tab.share.viewers.length === 0 ? (
                <p className="share-viewers-empty">{STR.share.noViewersYet}</p>
              ) : (
                tab.share.viewers.map((v) => {
                  const name = v.name || STR.share.viewerName({ id: v.id });
                  return (
                    <div key={v.id} className="share-viewer-row">
                      <span className="share-viewer-name">{name}</span>
                      <select
                        className="share-select share-viewer-access"
                        aria-label={STR.share.viewerAccessLabel({ name })}
                        value={v.access}
                        onChange={(e) =>
                          void changeViewerAccess(
                            v.id,
                            e.target.value as ShareAccess
                          )
                        }
                      >
                        {levels.map((l) => (
                          <option key={l} value={l}>
                            {STR.share.levelName[l]}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn share-kick"
                        onClick={() => void kick(v.id)}
                      >
                        {STR.share.removeViewer}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
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
      </div>
    </div>
  );
}
