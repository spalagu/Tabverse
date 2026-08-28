import { useEffect, useRef } from "react";
import type React from "react";
import { CompletionInput } from "../input/CompletionInput";
import { STR } from "../strings";
import { BrowserProgressBar } from "./BrowserProgressBar";
import "./browser-new-tab.css";

export interface BrowserNewTabSite {
  readonly title: string;
  readonly host: string;
}

export interface BrowserNewTabHints {
  readonly go: string;
  readonly pick: string;
  readonly complete: string;
  readonly clear: string;
}

export interface BrowserNewTabPaneProps {
  readonly active: boolean;
  readonly query: string;
  readonly ghost: string;
  readonly selectedIndex: number;
  readonly fallbackLabel: string | null;
  readonly sites: readonly BrowserNewTabSite[];
  readonly hints: BrowserNewTabHints;
  readonly onQueryChange: (value: string) => void;
  readonly onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly onSelect: (index: number) => void;
  readonly onRun: (index: number) => void;
}

/** Complete runtime-independent presentation for an empty browser tab. */
export function BrowserNewTabPane({
  active,
  query,
  ghost,
  selectedIndex,
  fallbackLabel,
  sites,
  hints,
  onQueryChange,
  onInputKeyDown,
  onSelect,
  onRun,
}: BrowserNewTabPaneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const siteBase = fallbackLabel === null ? 0 : 1;
  const hasRows = fallbackLabel !== null || sites.length > 0;

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  return (
    <div className="new-tab-view">
      <div className="new-tab-inner">
        <div className="new-tab-brand">{STR.common.appName}</div>
        <CompletionInput
          inputRef={inputRef}
          className="new-tab-input"
          placeholder={STR.browser.newTab.placeholder}
          value={query}
          ghost={ghost}
          onChange={onQueryChange}
          onKeyDown={onInputKeyDown}
        />
        {hasRows ? (
          <div className="new-tab-sites" role="listbox">
            {fallbackLabel !== null && (
              <button
                type="button"
                role="option"
                aria-selected={selectedIndex === 0}
                className={`new-tab-site${selectedIndex === 0 ? " sel" : ""}`}
                data-row-kind="fallback"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onSelect(0)}
                onClick={() => onRun(0)}
              >
                <span className="new-tab-site-title">{fallbackLabel}</span>
              </button>
            )}
            {sites.map((site, index) => {
              const rowIndex = siteBase + index;
              return (
                <button
                  key={`${site.host}:${index}`}
                  type="button"
                  role="option"
                  aria-selected={rowIndex === selectedIndex}
                  className={`new-tab-site${rowIndex === selectedIndex ? " sel" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onSelect(rowIndex)}
                  onClick={() => onRun(rowIndex)}
                >
                  <span className="new-tab-site-title">{site.title || site.host}</span>
                  <span className="new-tab-site-host">{site.host}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="new-tab-blank">{STR.browser.newTab.emptyBlurb}</div>
        )}
        <div className="new-tab-hints">
          <span>{STR.common.hints.go({ keys: hints.go })}</span>
          <span>{STR.common.hints.pick({ keys: hints.pick })}</span>
          <span>{STR.common.hints.complete({ keys: hints.complete })}</span>
          <span>{STR.common.hints.clear({ keys: hints.clear })}</span>
        </div>
      </div>
    </div>
  );
}

/** Browser-only fallback used when no native webview runtime is available. */
export function BrowserDemoPane({ tabId }: { readonly tabId: string }) {
  return (
    <div className="browser-pane">
      <BrowserProgressBar tabId={tabId} />
      <div className="placeholder">
        <div className="new-tab-brand">{STR.common.appName}</div>
        <div className="placeholder-title">{STR.browser.demoTitle}</div>
        <div className="placeholder-blurb">{STR.browser.demoBlurb}</div>
      </div>
    </div>
  );
}
