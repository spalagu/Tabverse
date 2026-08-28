import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";
import {
  searchHistoryStep,
  type SearchHistoryPort,
  type SearchParams,
} from "./SearchHistory";
import { trimTrailingSlashes } from "./pathStrings";

export interface SearchHit {
  rel: string;
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface GrepOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeHidden: boolean;
  include: string | null;
  exclude: string | null;
}

export interface GrepResult {
  hits: SearchHit[];
  filesMatched: number;
  filesScanned: number;
  truncated: boolean;
}

export interface PreviewLine {
  line: number;
  text: string;
}

export interface PreviewSite {
  line: number;
  col: number;
  beforeLen: number;
  afterLen: number;
  context: PreviewLine[];
}

export interface PreviewFile {
  rel: string;
  path: string;
  modified: number | null;
  before: string;
  sites: PreviewSite[];
}

export interface ReplacePreview {
  files: PreviewFile[];
  replacements: number;
  filesMatched: number;
}

export interface ReplaceStamp {
  path: string;
  modified: number | null;
}

export interface SkipSite {
  rel: string;
  line: number;
  col: number;
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
  failed: { rel: string; error: string }[];
}

export interface WalkResult {
  paths: string[];
  truncated: boolean;
}

export interface FilesWalkConfig {
  exclude: string[];
  respect_gitignore: boolean;
}

export interface FileSearchRuntime {
  filesConfig: () => Promise<FilesWalkConfig>;
  setFilesConfig: (config: FilesWalkConfig) => Promise<void>;
  grep: (
    root: string,
    query: string,
    options: GrepOptions,
    maxHits: number
  ) => Promise<GrepResult>;
  walk: (
    root: string,
    includeHidden: boolean,
    pattern?: string
  ) => Promise<WalkResult>;
  replacePreview: (
    root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null
  ) => Promise<ReplacePreview>;
  replace: (
    root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null,
    plan: { stamps: ReplaceStamp[]; skip: SkipSite[] }
  ) => Promise<ReplaceResult>;
}

export interface ReplacePreviewComponentProps {
  preview: ReplacePreview;
  query: string;
  replacement: string;
  busy: boolean;
  onConfirm: (skip: SkipSite[], stamps: ReplaceStamp[]) => void;
  onCancel: () => void;
}

export const WALK_CAP = 5000;


/** The cap. Named here because the panel has to say when it is reached. */
const MAX_HITS = 2000;

export function globGhost(value: string): string | null {
  if (!value || value.includes("/") || value.startsWith("**")) return null;
  return `**/${value}`;
}

/** One glob input with the in-field ghost; Tab takes the suggestion. */
function GlobInput({
  value,
  onChange,
  onEnter,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Enter runs, as in the content search's query field. */
  onEnter?: () => void;
  placeholder: string;
}) {
  const ghost = globGhost(value);
  return (
    <div className="glob-input">
      <input
        className="search-input"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Tab completes rather than leaving the field: the ghost is one
          // keypress away, or it is noise.
          if (e.key === "Tab" && ghost) {
            e.preventDefault();
            onChange(ghost);
          } else if (e.key === "Enter" && onEnter) {
            onEnter();
          }
          e.stopPropagation();
        }}
      />
      {ghost && (
        <span className="glob-ghost" title={STR.files.search.globGhostHint}>
          {ghost}
        </span>
      )}
    </div>
  );
}

export function nameAbsPaths(root: string, rels: readonly string[]): string[] {
  const base = trimTrailingSlashes(root);
  return rels.map((r) => `${base}/${r}`);
}

export function splitExcludeList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The other direction, for loading what the file holds into the input. */
export function joinExcludeList(entries: readonly string[]): string {
  return entries.join(", ");
}

type MatchRange = [number, number];

/** Every non-overlapping match of the current query in one line's text,
 *  under the toggles it ran with. Regex errors degrade to no highlight —
 *  the row still shows the line, the backend already filtered it. */
function matchRanges(
  text: string,
  query: string,
  o: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
): MatchRange[] {
  if (!query || !text) return [];
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  let re: RegExp;
  try {
    re = new RegExp(src, o.caseSensitive ? "g" : "gi");
  } catch {
    return [];
  }
  const out: MatchRange[] = [];
  for (let m: RegExpExecArray | null, guard = 0; guard < 64; guard++) {
    m = re.exec(text);
    if (m === null) break;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Window the line around its FIRST match so the hit is always on
 *  screen — the old head-truncate could ellipsize the very thing the
 *  user searched for. */
const MATCH_WINDOW = 240;

function centerOnMatch(
  text: string,
  ranges: MatchRange[]
): { text: string; offset: number } {
  if (text.length <= MATCH_WINDOW || ranges.length === 0)
    return { text, offset: 0 };
  const [s] = ranges[0];
  const start = Math.max(0, s - 80);
  return {
    text:
      (start > 0 ? "…" : "") +
      text.slice(start, start + MATCH_WINDOW) +
      (start + MATCH_WINDOW < text.length ? "…" : ""),
    offset: start,
  };
}

/** One line's text with every match wrapped in a highlight span. */
function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: MatchRange[];
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], i) => {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(
      <mark key={i} className="search-hit-mark">
        {text.slice(s, e)}
      </mark>
    );
    cursor = e;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function ResultRow({
  line,
  text,
  title,
  onOpen,
  checkbox,
  query,
  options,
  anchorCol,
}: {
  /** 1-based; null when the row IS the file rather than a place in it. */
  line: number | null;
  text: string;
  title: string;
  onOpen: () => void;
  checkbox?: { checked: boolean; toggle: () => void };
  /** Content-mode only: what to light up and where the engine pointed. */
  query?: string;
  options?: { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
  anchorCol?: number;
}) {
  let body: React.ReactNode = text;
  if (line !== null && query && options) {
    const all = matchRanges(text, query, options);
    // Prefer the range covering the engine's column (1-based there,
    // 0-based here); fall back to the first range anywhere.
    const anchor =
      all.find(([s, e]) => {
        const c = Math.max(0, (anchorCol ?? 1) - 1);
        return c >= s && c < e;
      }) ?? all[0];
    const win = centerOnMatch(text, anchor ? [anchor] : []);
    const shifted: MatchRange[] = anchor
      ? [[anchor[0] - win.offset, anchor[1] - win.offset]]
      : [];
    body = <HighlightedText text={win.text} ranges={shifted} />;
  }
  return (
    <div
      className={`search-hit${checkbox ? " name-row" : ""}`}
      onClick={onOpen}
      title={title}
    >
      {checkbox && (
        <input
          type="checkbox"
          className="search-check"
          checked={checkbox.checked}
          // The row opens the file; only the box toggles the pick, so the
          // click must not fall through to the row.
          onClick={(e) => e.stopPropagation()}
          onChange={checkbox.toggle}
        />
      )}
      {line !== null && <span className="search-line">{line}</span>}
      <span className="search-text">{body}</span>
    </div>
  );
}

export function SearchPanel({
  root,
  includeHidden,
  runtime,
  historyPort,
  ReplacePreviewComponent,
  onOpen,
  onSelectPaths,
}: {
  root: string;
  includeHidden: boolean;
  runtime: FileSearchRuntime;
  historyPort: SearchHistoryPort;
  ReplacePreviewComponent: ComponentType<ReplacePreviewComponentProps>;
  onOpen: (path: string, line: number) => void;
  /** Name-mode picks, as relative paths; the caller owns the pane. */
  onSelectPaths: (relPaths: string[]) => void;
}) {
  const [mode, setMode] = useState<"content" | "name">("content");
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [globRowOpen, setGlobRowOpen] = useState(false);
  const [result, setResult] = useState<GrepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | ErrorDescription | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [excludesOpen, setExcludesOpen] = useState(false);
  const [excludesInput, setExcludesInput] = useState("");
  const [excludesCfg, setExcludesCfg] = useState<FilesWalkConfig | null>(null);
  const [excludesError, setExcludesError] = useState<string | ErrorDescription | null>(
    null
  );

  useEffect(() => {
    let alive = true;
    runtime
      .filesConfig()
      .then((cfg) => {
        if (!alive) return;
        setExcludesCfg(cfg);
        setExcludesInput(joinExcludeList(cfg.exclude));
      })
      .catch(() => {
        // No config behind the panel (demo tree without one): the row
        // still opens with the defaults rather than hiding half-formed.
        if (alive) setExcludesCfg({ exclude: [], respect_gitignore: false });
      });
    return () => {
      alive = false;
    };
  }, [runtime]);

  /** Write the whole [files] pair in one call; the restore button is
   *  this with the defaults in, not a second path. */
  const commitExcludes = useCallback(
    (next: FilesWalkConfig) => {
      setExcludesError(null);
      runtime
        .setFilesConfig(next)
        .then(() => setExcludesCfg(next))
        .catch((e) =>
          setExcludesError(
            describeError(e, STR.errors.actions.saveExcludeList)
          )
        );
    },
    [runtime]
  );

  const commitExcludesInput = useCallback(() => {
    if (!excludesCfg) return;
    const entries = splitExcludeList(excludesInput);
    setExcludesInput(joinExcludeList(entries));
    if (joinExcludeList(entries) === joinExcludeList(excludesCfg.exclude)) return;
    commitExcludes({ ...excludesCfg, exclude: entries });
  }, [excludesCfg, excludesInput, commitExcludes]);

  const [nameQuery, setNameQuery] = useState("");
  const [nameResult, setNameResult] = useState<WalkResult | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | ErrorDescription | null>(
    null
  );
  const [nameChecked, setNameChecked] = useState<Set<string>>(new Set());

  const [history, setHistory] = useState<SearchParams[]>([]);
  const histIdx = useRef(-1);
  const beforeHistory = useRef<SearchParams | null>(null);

  useEffect(() => {
    void historyPort.load().then(setHistory);
  }, [historyPort]);

  /** Everything on screen as one package — the unit the history stores. */
  const currentParams = useCallback(
    (): SearchParams => ({
      query,
      replacement,
      caseSensitive,
      wholeWord,
      regex: useRegex,
      include: includeGlob.trim() || null,
      exclude: excludeGlob.trim() || null,
    }),
    [query, replacement, caseSensitive, wholeWord, useRegex, includeGlob, excludeGlob]
  );

  /** A package back onto every field it came from — the whole question,
   *  not just its first word. */
  const applyParams = useCallback((p: SearchParams) => {
    setQuery(p.query);
    setReplacement(p.replacement);
    setCaseSensitive(p.caseSensitive);
    setWholeWord(p.wholeWord);
    setUseRegex(p.regex);
    setIncludeGlob(p.include ?? "");
    setExcludeGlob(p.exclude ?? "");
    // The restored package may carry globs, so the advanced row opens to
    // show them rather than hiding half of what just came back.
    setGlobRowOpen(Boolean(p.include || p.exclude));
  }, []);

  const stepHistory = useCallback(
    (dir: -1 | 1) => {
      if (dir === -1 && histIdx.current === -1) {
        beforeHistory.current = currentParams();
      }
      const step = searchHistoryStep(history, histIdx.current, dir);
      if (step) {
        histIdx.current = step.cursor;
        applyParams(step.entry);
        return;
      }
      // Stepping down past the newest returns to what was being typed.
      if (dir === 1 && histIdx.current !== -1) {
        histIdx.current = -1;
        const parked = beforeHistory.current;
        beforeHistory.current = null;
        if (parked) applyParams(parked);
      }
    },
    [history, currentParams, applyParams]
  );

  /** Typing leaves the history; the cursor is only meaningful mid-walk. */
  const leaveHistory = useCallback(() => {
    histIdx.current = -1;
    beforeHistory.current = null;
  }, []);

  const options = useMemo<GrepOptions>(
    () => ({
      caseSensitive,
      wholeWord,
      regex: useRegex,
      includeHidden,
      // Empty means "no filter" on the backend's side of the seam.
      include: includeGlob.trim() || null,
      exclude: excludeGlob.trim() || null,
    }),
    [caseSensitive, wholeWord, useRegex, includeHidden, includeGlob, excludeGlob]
  );

  const run = useCallback(async () => {
    if (!query) {
      setResult(null);
      setError(null);
      return;
    }
    historyPort.record(currentParams());
    setBusy(true);
    setError(null);
    try {
      const r = await runtime.grep(root, query, options, MAX_HITS);
      setResult(r);
    } catch (e) {
      // A bad regex or glob arrives here, and saying so beats an empty
      // result list.
      setError(describeError(e, STR.errors.actions.searchFiles));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [root, query, options, currentParams, historyPort, runtime]);

  const runName = useCallback(async () => {
    const pattern = nameQuery.trim();
    if (!pattern) {
      setNameResult(null);
      setNameError(null);
      return;
    }
    setNameBusy(true);
    setNameError(null);
    setNameChecked(new Set());
    try {
      const r = await runtime.walk(root, includeHidden, pattern);
      setNameResult(r);
    } catch (e) {
      // A broken glob arrives here; saying so beats an empty list that
      // reads as "nothing matches".
      setNameError(describeError(e, STR.errors.actions.searchFiles));
      setNameResult(null);
    } finally {
      setNameBusy(false);
    }
  }, [root, includeHidden, nameQuery, runtime]);

  const [preview, setPreview] = useState<{
    data: ReplacePreview;
    only: string[] | null;
  } | null>(null);

  const byFile = useMemo(() => {
    const groups = new Map<string, GrepResult["hits"]>();
    for (const h of result?.hits ?? []) {
      const list = groups.get(h.rel);
      if (list) list.push(h);
      else groups.set(h.rel, [h]);
    }
    return [...groups.entries()];
  }, [result]);

  const replaceIn = async (files: string[] | null) => {
    setBusy(true);
    setError(null);
    try {
      const p = await runtime.replacePreview(
        root,
        query,
        replacement,
        options,
        files
      );
      if (p.files.length === 0) {
        setError(STR.files.search.previewNothing);
        return;
      }
      setPreview({ data: p, only: files });
    } catch (e) {
      setError(describeError(e, STR.errors.actions.replaceInFiles));
    } finally {
      setBusy(false);
    }
  };

  /** The preview's confirm: execute with the preview's own stamps (a file
   *  that moved refuses the run) and the unchecked sites. */
  const executeReplace = async (
    skip: SkipSite[],
    stamps: ReplaceStamp[]
  ) => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await runtime.replace(root, query, replacement, options, preview.only, {
        stamps,
        skip,
      });
      setError(
        r.failed.length > 0
          ? STR.files.search.replacedResult({
              count: r.replacements,
              files: r.filesChanged,
            }) +
            " " +
            STR.files.search.previewFailed({
              names: r.failed.map((f) => f.rel).join(", "),
            })
          : STR.files.search.replacedResult({
              count: r.replacements,
              files: r.filesChanged,
            })
      );
      setPreview(null);
      await run();
    } catch (e) {
      // The mtime refusal lands here, worded by the backend and named by
      // file — the preview stays up so the user can start it again.
      setError(describeError(e, STR.errors.actions.replaceInFiles));
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <ReplacePreviewComponent
        preview={preview.data}
        query={query}
        replacement={replacement}
        busy={busy}
        onConfirm={(skip, stamps) => void executeReplace(skip, stamps)}
        onCancel={() => setPreview(null)}
      />
    );
  }

  return (
    <div className="search-panel">
      <div className="search-modes" role="group" aria-label={STR.files.search.modeHint}>
        {(
          [
            ["content", STR.files.search.modeContent],
            ["name", STR.files.search.modeName],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`mini-btn${mode === id ? " on" : ""}`}
            aria-pressed={mode === id}
            title={STR.files.search.modeHint}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "content" ? (
        <>
      <div className="search-fields">
        <div className="search-row">
          <input
            className="search-input"
            placeholder={STR.files.search.searchPlaceholder}
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              leaveHistory();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                leaveHistory();
                void run();
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                stepHistory(-1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                stepHistory(1);
              }
              e.stopPropagation();
            }}
          />
          <div className="search-toggles">
            <button
              className={`mini-btn${caseSensitive ? " on" : ""}`}
              title={STR.files.search.matchCaseHint}
              onClick={() => {
                leaveHistory();
                setCaseSensitive((v) => !v);
              }}
            >
              {STR.files.search.matchCaseGlyph}
            </button>
            <button
              className={`mini-btn${wholeWord ? " on" : ""}`}
              title={STR.files.search.wholeWordHint}
              onClick={() => {
                leaveHistory();
                setWholeWord((v) => !v);
              }}
            >
              {STR.files.search.wholeWordGlyph}
            </button>
            <button
              className={`mini-btn${useRegex ? " on" : ""}`}
              title={STR.files.search.regexHint}
              onClick={() => {
                leaveHistory();
                setUseRegex((v) => !v);
              }}
            >
              {STR.files.search.regexGlyph}
            </button>
          </div>
        </div>
        <div className="search-row">
          <input
            className="search-input"
            placeholder={STR.files.search.replacePlaceholder}
            value={replacement}
            onChange={(e) => {
            setReplacement(e.target.value);
            leaveHistory();
          }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button
            className="mini-btn"
            title={STR.files.search.replaceAllHint}
            disabled={!result || result.hits.length === 0 || busy}
            onClick={() => void replaceIn(null)}
          >
            ⇄
          </button>
        </div>
        <button
          className={`search-advanced${globRowOpen ? " on" : ""}`}
          aria-expanded={globRowOpen}
          // The caret span reads as the button's face to the icon-only
          // audit; the label is real, and saying it twice costs nothing.
          aria-label={STR.files.search.globRowLabel}
          onClick={() => setGlobRowOpen((v) => !v)}
        >
          <span className="tree-caret">{globRowOpen ? "▾" : "▸"}</span>
          {STR.files.search.globRowLabel}
          {(includeGlob || excludeGlob) && <span className="search-count">·</span>}
        </button>
        {globRowOpen && (
          <div className="search-row glob-row">
            <GlobInput
              value={includeGlob}
              onChange={(v) => {
                setIncludeGlob(v);
                leaveHistory();
              }}
              placeholder={STR.files.search.includePlaceholder}
            />
            <GlobInput
              value={excludeGlob}
              onChange={(v) => {
                setExcludeGlob(v);
                leaveHistory();
              }}
              placeholder={STR.files.search.excludePlaceholder}
            />
          </div>
        )}
        <button
          className={`search-advanced${excludesOpen ? " on" : ""}`}
          aria-expanded={excludesOpen}
          title={STR.files.search.excludesRowHint}
          aria-label={STR.files.search.excludesRowLabel}
          onClick={() => setExcludesOpen((v) => !v)}
        >
          <span className="tree-caret">{excludesOpen ? "▾" : "▸"}</span>
          {STR.files.search.excludesRowLabel}
          {excludesCfg &&
            (excludesCfg.exclude.length > 0 ||
              excludesCfg.respect_gitignore) && (
              <span className="search-count">·</span>
            )}
        </button>
        {excludesOpen && (
          <div className="search-row glob-row excludes-row">
            <div className="search-row">
              <input
                className="search-input"
                spellCheck={false}
                placeholder={STR.files.search.excludesPlaceholder}
                value={excludesInput}
                onChange={(e) => setExcludesInput(e.target.value)}
                onBlur={commitExcludesInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitExcludesInput();
                  e.stopPropagation();
                }}
              />
              <button
                className={`mini-btn${excludesCfg?.respect_gitignore ? " on" : ""}`}
                title={STR.files.search.excludesGitignoreHint}
                aria-pressed={excludesCfg?.respect_gitignore ?? false}
                onClick={() =>
                  excludesCfg &&
                  commitExcludes({
                    ...excludesCfg,
                    respect_gitignore: !excludesCfg.respect_gitignore,
                  })
                }
              >
                {STR.files.search.excludesGitignore}
              </button>
              <button
                className="mini-btn"
                title={STR.files.search.excludesRestoreHint}
                onClick={() => {
                  setExcludesInput("");
                  commitExcludes({ exclude: [], respect_gitignore: false });
                }}
              >
                {STR.files.search.excludesRestore}
              </button>
            </div>
            <p className="excludes-note">{STR.files.search.excludesNote}</p>
            {excludesError &&
              (typeof excludesError === "string" ? (
                <p className="excludes-note">{excludesError}</p>
              ) : (
                <ErrorState inline error={excludesError} />
              ))}
          </div>
        )}
      </div>

      <div className="search-status">
        {busy
          ? STR.files.search.searching
          : error
            ? typeof error === "string"
              ? error
              : <ErrorState inline error={error} />
            : result
              ? STR.files.search.resultLine({
                  hits: result.hits.length,
                  files: result.filesMatched,
                }) +
                (result.truncated
                  ? STR.files.search.truncatedSuffix({ max: MAX_HITS })
                  : "")
              : STR.files.search.pressEnter}
      </div>

      <div className="search-results">
        {byFile.map(([rel, hits]) => (
          <div key={rel} className="search-group">
            <div
              className="search-file"
              onClick={() =>
                setCollapsed((c) => ({ ...c, [rel]: !c[rel] }))
              }
            >
              <span className="tree-caret">{collapsed[rel] ? "▸" : "▾"}</span>
              <span className="search-file-name" title={rel}>
                {rel}
              </span>
              <span className="search-count">{hits.length}</span>
              <button
                className="mini-btn"
                title={STR.files.search.replaceInFileHint}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void replaceIn([rel]);
                }}
              >
                ⇄
              </button>
            </div>
            {!collapsed[rel] &&
              hits.map((h, i) => (
                <ResultRow
                  key={`${h.line}:${h.col}:${i}`}
                  line={h.line}
                  text={h.text.trim()}
                  title={`${h.rel}:${h.line}`}
                  onOpen={() => onOpen(h.path, h.line)}
                  query={query}
                  options={{
                    caseSensitive,
                    wholeWord,
                    regex: useRegex,
                  }}
                  anchorCol={h.col}
                />
              ))}
          </div>
        ))}
      </div>
        </>
      ) : (
        <>
          <div className="search-fields">
            <div className="search-row">
              <GlobInput
                value={nameQuery}
                onChange={setNameQuery}
                onEnter={() => void runName()}
                placeholder={STR.files.search.namePlaceholder}
              />
            </div>
          </div>

          <div className="search-status name-status">
            {nameBusy ? (
              STR.files.search.searching
            ) : nameError ? (
              typeof nameError === "string" ? (
                nameError
              ) : (
                <ErrorState inline error={nameError} />
              )
            ) : nameResult ? (
              nameResult.paths.length === 0 ? (
                STR.files.search.nameEmpty
              ) : (
                <>
                  {STR.files.search.nameResultLine({
                    files: nameResult.paths.length,
                  }) +
                    (nameResult.truncated
                      ? STR.files.search.truncatedSuffix({ max: WALK_CAP })
                      : "")}
                  <button
                    className="mini-btn"
                    title={STR.files.search.selectInTreeHint}
                    disabled={nameChecked.size === 0 || nameBusy}
                    onClick={() => onSelectPaths([...nameChecked])}
                  >
                    {STR.files.search.selectInTree({ n: nameChecked.size })}
                  </button>
                </>
              )
            ) : (
              STR.files.search.pressEnter
            )}
          </div>

          <div className="search-results">
            {(nameResult?.paths ?? []).map((rel) => (
              <ResultRow
                key={rel}
                line={null}
                text={rel}
                title={rel}
                onOpen={() => onOpen(nameAbsPaths(root, [rel])[0], 1)}
                checkbox={{
                  checked: nameChecked.has(rel),
                  toggle: () =>
                    setNameChecked((prev) => {
                      const next = new Set(prev);
                      if (next.has(rel)) next.delete(rel);
                      else next.add(rel);
                      return next;
                    }),
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
