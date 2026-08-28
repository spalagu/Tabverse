import type { RefObject } from "react";
import type { ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { AlertIcon } from "../icons";
import { ErrorState } from "../state/ErrorState";
import { BrowserProgressBar } from "./BrowserProgressBar";

export interface BrowserFindResult {
  readonly total: number;
  readonly current: number;
  readonly frames: number;
}

export interface BrowserNavigationError {
  readonly kind: string;
  readonly host: string;
  readonly url: string;
  readonly message: string;
}

export interface BrowserPasswordOffer {
  readonly host: string;
  readonly username: string;
}

export interface BrowserFillableLogins {
  readonly host: string;
  readonly usernames: string[];
}

export interface BrowserNativePaneHints {
  readonly go: string;
  readonly reload: string;
  readonly back: string;
  readonly forward: string;
  readonly zoom: string;
  readonly findNext: string;
  readonly findPrevious: string;
  readonly close: string;
  readonly location: string;
}

export interface BrowserNativePaneProps {
  readonly tabId: string;
  readonly currentUrl: string;
  readonly barOpen: boolean;
  readonly address: string;
  readonly onDismissAddress: () => void;
  readonly onAddressChange: (value: string) => void;
  readonly onCommitAddress: (value: string) => void;
  readonly onEscapeAddress: (value: string) => void;
  readonly findOpen: boolean;
  readonly findQuery: string;
  readonly findResult: BrowserFindResult | null;
  readonly onFindQueryChange: (value: string) => void;
  readonly onFind: (backwards: boolean) => void;
  readonly onCloseFind: () => void;
  readonly passwordOffer: BrowserPasswordOffer | null;
  readonly onAnswerPasswordOffer: (save: boolean, never?: boolean) => void;
  readonly fillableLogins: BrowserFillableLogins | null;
  readonly onFillLogin: (username: string) => void;
  readonly onDismissFillableLogins: () => void;
  readonly error: string | ErrorDescription | null;
  readonly navigationError: BrowserNavigationError | null;
  readonly onRetryNavigation: () => void;
  readonly onProceedPastCertificate: () => void;
  readonly hostRef: RefObject<HTMLDivElement>;
  readonly frozenFrame: { readonly src: string } | null;
  readonly freezeInset: number;
  readonly hints: BrowserNativePaneHints;
}

/** Complete DOM chrome around the desktop runtime's native browser webview. */
export function BrowserNativePane({
  tabId,
  currentUrl,
  barOpen,
  address,
  onDismissAddress,
  onAddressChange,
  onCommitAddress,
  onEscapeAddress,
  findOpen,
  findQuery,
  findResult,
  onFindQueryChange,
  onFind,
  onCloseFind,
  passwordOffer,
  onAnswerPasswordOffer,
  fillableLogins,
  onFillLogin,
  onDismissFillableLogins,
  error,
  navigationError,
  onRetryNavigation,
  onProceedPastCertificate,
  hostRef,
  frozenFrame,
  freezeInset,
  hints,
}: BrowserNativePaneProps) {
  return (
    <div className="browser-pane">
      {barOpen && (
        <div className="overlay" onMouseDown={onDismissAddress}>
          <div className="cmdbar" onMouseDown={(event) => event.stopPropagation()}>
            <input
              className="cmdbar-input"
              autoFocus
              value={address}
              spellCheck={false}
              placeholder={STR.browser.addressPlaceholder}
              onChange={(event) => onAddressChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommitAddress(address);
                else if (event.key === "Escape") onEscapeAddress(address);
                event.stopPropagation();
              }}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="cmdbar-hints">
              <span>{STR.common.hints.go({ keys: hints.go })}</span>
              <span>{STR.browser.hintReload({ keys: hints.reload })}</span>
              <span>{STR.browser.hintBack({ keys: hints.back })}</span>
              <span>{STR.browser.hintForward({ keys: hints.forward })}</span>
              <span>{STR.browser.hintZoom({ keys: hints.zoom })}</span>
            </div>
          </div>
        </div>
      )}

      {findOpen && (
        <div className="findbar">
          <input
            className="findbar-input"
            autoFocus
            value={findQuery}
            spellCheck={false}
            placeholder={STR.browser.findPlaceholder}
            onChange={(event) => onFindQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onFind(event.shiftKey);
              else if (event.key === "Escape") onCloseFind();
              event.stopPropagation();
            }}
          />
          {findResult && (
            <span className="findbar-count">
              {findResult.total === 0
                ? STR.browser.noMatches
                : `${findResult.current}/${findResult.total}`}
              {findResult.frames > 1 && (
                <span className="findbar-scope">
                  {" · "}
                  {STR.browser.findScopeNote}
                </span>
              )}
            </span>
          )}
          <button
            className="mini-btn"
            title={STR.browser.findHints({
              next: hints.findNext,
              prev: hints.findPrevious,
              close: hints.close,
            })}
            aria-label={STR.common.close}
            onClick={onCloseFind}
          >
            ✕
          </button>
        </div>
      )}

      {passwordOffer && (
        <div
          className="pwbar"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onAnswerPasswordOffer(false);
            }
          }}
        >
          <span className="pwbar-text">
            {STR.browser.savePasswordLead}{" "}
            <strong>{passwordOffer.username || STR.browser.thisSite}</strong>
            {STR.browser.savePasswordTail({ host: passwordOffer.host })}
          </span>
          <button
            className="primary"
            autoFocus
            onClick={() => onAnswerPasswordOffer(true)}
          >
            {STR.browser.save}
          </button>
          <button onClick={() => onAnswerPasswordOffer(false)}>
            {STR.browser.notNow}
          </button>
          <button
            className="pwbar-never"
            onClick={() => onAnswerPasswordOffer(false, true)}
          >
            {STR.browser.neverForSite}
          </button>
        </div>
      )}

      {!passwordOffer && fillableLogins && (
        <div className="pwbar">
          <span className="pwbar-text">
            {STR.browser.signInAs({ host: fillableLogins.host })}
          </span>
          {fillableLogins.usernames.map((username, index) => (
            <button
              key={username}
              className={index === 0 ? "primary" : ""}
              autoFocus={index === 0}
              onClick={() => onFillLogin(username)}
            >
              {username || STR.browser.noUsername}
            </button>
          ))}
          <button onClick={onDismissFillableLogins}>{STR.common.dismiss}</button>
        </div>
      )}

      <BrowserProgressBar tabId={tabId} />
      {error &&
        (typeof error === "string" ? (
          <div className="files-error">{error}</div>
        ) : (
          <ErrorState inline error={error} />
        ))}
      {navigationError && navigationError.kind !== "certificate" && (
        <div className="files-error">{navigationError.message}</div>
      )}
      {navigationError && navigationError.kind === "certificate" && (
        <div className="cert-block">
          <div className="cert-block-head">
            <AlertIcon className="cert-block-icon" />
            <div className="cert-block-title">{STR.browser.certTitle}</div>
          </div>
          <div className="cert-block-body">{navigationError.message}</div>
          <div className="cert-block-actions">
            <button autoFocus onClick={onRetryNavigation}>
              {STR.common.retry}
            </button>
            <button className="danger" onClick={onProceedPastCertificate}>
              {STR.browser.certProceed({
                host: navigationError.host || STR.browser.thisSite,
              })}
            </button>
          </div>
          <div className="cert-block-note">
            {STR.browser.certNote({
              host: navigationError.host || STR.browser.thisSite,
            })}
          </div>
        </div>
      )}

      <div className="browser-slot" ref={hostRef}>
        {frozenFrame !== null && (
          <img
            className="page-freeze"
            alt=""
            src={frozenFrame.src}
            style={{
              left: freezeInset,
              width: `calc(100% - ${freezeInset}px)`,
            }}
          />
        )}
        <span className="browser-hint">
          {STR.browser.pageHint({ url: currentUrl, keys: hints.location })}
        </span>
      </div>
    </div>
  );
}
