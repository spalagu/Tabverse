import { useEffect, useRef, useState } from "react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { CloseIcon } from "../icons";
import { STR } from "../strings";
import { themeColors, type ThemeName } from "../theme";
import { rememberTerminalSearch, terminalSearchHistory } from "./searchHistory";

export interface TerminalSearchHints {
  readonly history: string;
  readonly previous: string;
  readonly next: string;
  readonly close: string;
  readonly previousGlyph: string;
  readonly nextGlyph: string;
}

export interface TerminalSearchBarProps {
  readonly search: SearchAddon;
  readonly theme: ThemeName;
  readonly hints: TerminalSearchHints;
  readonly onClose: () => void;
}

/** Runtime-independent terminal-buffer search UI. */
export function TerminalSearchBar({
  search,
  theme,
  hints,
  onClose,
}: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [count, setCount] = useState<{ current: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const disposable = search.onDidChangeResults((result) => {
      setCount(
        result === undefined
          ? null
          : { current: result.resultIndex + 1, total: result.resultCount },
      );
    });
    return () => disposable.dispose();
  }, [search]);

  const colors = themeColors(theme);
  const options: ISearchOptions = {
    caseSensitive,
    regex,
    wholeWord,
    decorations: {
      matchBackground: colors.termFindMatchBg,
      activeMatchBackground: colors.accent,
      matchOverviewRuler: colors.accent,
      activeMatchColorOverviewRuler: colors.termFindRulerFg,
    },
  };

  const run = (
    direction: "next" | "previous",
    term: string,
    runOptions: ISearchOptions,
    incremental = false,
  ) => {
    if (term === "") {
      search.clearDecorations();
      setCount(null);
      return;
    }
    if (runOptions.regex) {
      try {
        new RegExp(term);
      } catch {
        search.clearDecorations();
        setCount(null);
        return;
      }
    }
    if (direction === "next") {
      search.findNext(term, incremental ? { ...runOptions, incremental: true } : runOptions);
    } else {
      search.findPrevious(term, runOptions);
    }
  };

  const find = (direction: "next" | "previous", term = query, incremental = false) =>
    run(direction, term, options, incremental);

  const close = () => {
    search.clearDecorations();
    onClose();
  };

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        className="search-input"
        placeholder={STR.term.findPlaceholder}
        title={STR.term.historyHint({ keys: hints.history })}
        value={query}
        onChange={(event) => {
          setHistoryIndex(null);
          setQuery(event.target.value);
          find("next", event.target.value, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            rememberTerminalSearch(query);
            find(event.shiftKey ? "previous" : "next");
          }
          if (event.key === "ArrowUp") {
            const history = terminalSearchHistory();
            const next =
              query === "" && history.length > 0
                ? history.length - 1
                : historyIndex !== null && historyIndex > 0
                  ? historyIndex - 1
                  : null;
            if (next !== null) {
              event.preventDefault();
              setHistoryIndex(next);
              setQuery(history[next]);
            }
          }
          if (event.key === "Escape") close();
          event.stopPropagation();
        }}
      />
      <span className="search-count">
        {count !== null && count.total > 0
          ? `${count.current}/${count.total}`
          : query
            ? "0"
            : ""}
      </span>
      <button
        className={`mini-btn${caseSensitive ? " on" : ""}`}
        title={STR.term.matchCaseHint}
        onClick={() => {
          const next = !caseSensitive;
          setCaseSensitive(next);
          run("next", query, { ...options, caseSensitive: next });
        }}
      >
        {STR.term.matchCase}
      </button>
      <button
        className={`mini-btn${wholeWord ? " on" : ""}`}
        title={STR.term.wholeWordHint}
        onClick={() => {
          const next = !wholeWord;
          setWholeWord(next);
          run("next", query, { ...options, wholeWord: next });
        }}
      >
        {STR.files.search.wholeWordGlyph}
      </button>
      <button
        className={`mini-btn${regex ? " on" : ""}`}
        title={STR.term.regexHint}
        onClick={() => {
          const next = !regex;
          setRegex(next);
          run("next", query, { ...options, regex: next });
        }}
      >
        {STR.files.search.regexGlyph}
      </button>
      <button
        className="mini-btn"
        onClick={() => find("previous")}
        title={STR.term.prevMatchHint({ keys: hints.previous })}
      >
        {hints.previousGlyph}
      </button>
      <button
        className="mini-btn"
        onClick={() => find("next")}
        title={STR.term.nextMatchHint({ keys: hints.next })}
      >
        {hints.nextGlyph}
      </button>
      <button
        className="mini-btn"
        onClick={close}
        title={STR.common.closeHint({ keys: hints.close })}
        aria-label={STR.common.close}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
