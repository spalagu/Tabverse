import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { STR } from "../strings";
import type {
  PreviewFile,
  ReplacePreview,
  ReplaceStamp,
  SkipSite,
} from "./SearchPanel";

export interface ReplacePreviewEditorProps {
  path: string;
  value: string;
  original?: string | null;
  readOnly?: boolean;
}


/** A site's identity, the same key the execution's skip list speaks. */
export const siteKey = (rel: string, line: number, col: number): string =>
  `${rel}\n${line}:${col}`;

/**
 * The "after" text of one file, from the preview's own spans — splicing
 * the checked sites into the preview's `before`. Unchecked sites keep
 * their original text. The span coordinates are the backend's chars, so
 * the splice works on char arrays, not UTF-16 code units. When nothing is
 * skipped the answer must equal what the backend's rebuild writes — that
 * equivalence is pinned by the same fixture on both sides
 * (replacePreview.test.ts ↔ search.rs).
 */
export function applySites(
  before: string,
  sites: ReadonlyArray<{ line: number; col: number; beforeLen: number }>,
  replacement: string,
  skipped: ReadonlySet<string>,
  rel: string
): string {
  const lines = before.split("\n");
  // Places on one line are spliced right-to-left so earlier splices
  // cannot shift later coordinates.
  const byLine = new Map<number, { col: number; beforeLen: number }[]>();
  for (const s of sites) {
    if (skipped.has(siteKey(rel, s.line, s.col))) continue;
    const list = byLine.get(s.line);
    if (list) list.push(s);
    else byLine.set(s.line, [s]);
  }
  for (const [lineNo, list] of byLine) {
    const idx = lineNo - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const chars = Array.from(lines[idx]);
    list.sort((a, b) => b.col - a.col);
    for (const s of list) {
      const start = s.col - 1;
      if (start > chars.length) continue;
      chars.splice(
        start,
        Math.min(s.beforeLen, chars.length - start),
        ...Array.from(replacement)
      );
    }
    lines[idx] = chars.join("");
  }
  return lines.join("\n");
}

export function previewScope(
  preview: ReplacePreview,
  skipped: ReadonlySet<string>
): { files: number; places: number } {
  let files = 0;
  let places = 0;
  for (const f of preview.files) {
    let here = 0;
    for (const s of f.sites) {
      if (!skipped.has(siteKey(f.rel, s.line, s.col))) here++;
    }
    if (here > 0) files++;
    places += here;
  }
  return { files, places };
}

/** The hit line's text with the replaced span marked, for one site row. */
function MarkedLine({
  text,
  col,
  beforeLen,
  replacement,
  line,
}: {
  text: string;
  col: number;
  beforeLen: number;
  replacement: string;
  line: number;
}) {
  const chars = Array.from(text);
  const start = col - 1;
  const end = start + beforeLen;
  return (
    <span className="preview-ctx-hit">
      <span className="search-line">{line}</span>
      <span className="preview-ctx-text">
        {chars.slice(0, start).join("")}
        <del className="preview-span">{chars.slice(start, end).join("")}</del>
        <ins className="preview-span after">{replacement}</ins>
        {chars.slice(end).join("")}
      </span>
    </span>
  );
}

export function ReplacePreviewPane({
  preview,
  query,
  replacement,
  busy,
  CodeEditorComponent,
  disposeEditorState,
  onConfirm,
  onCancel,
}: {
  preview: ReplacePreview;
  query: string;
  replacement: string;
  busy: boolean;
  CodeEditorComponent: ComponentType<ReplacePreviewEditorProps>;
  disposeEditorState: (path: string) => void;
  onConfirm: (skip: SkipSite[], stamps: ReplaceStamp[]) => void;
  onCancel: () => void;
}) {
  // Every place is ON unless it was unchecked — the destructive act is
  // narrowing, and narrowing must be the user's click.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const scope = useMemo(() => previewScope(preview, skipped), [preview, skipped]);

  // The diff's modified side rides a synthetic path so it can never
  // collide with the per-path model cache a real editor owns; dropped
  // with the pane.
  const syntheticPaths = useMemo(
    () => preview.files.map((f) => `replace-preview:${f.rel}`),
    [preview]
  );
  useEffect(
    () => () => {
      for (const p of syntheticPaths) disposeEditorState(p);
    },
    [disposeEditorState, syntheticPaths]
  );

  const toggleSite = (rel: string, line: number, col: number) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      const k = siteKey(rel, line, col);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const fileChecked = (f: PreviewFile) =>
    f.sites.filter((s) => !skipped.has(siteKey(f.rel, s.line, s.col))).length;

  const confirm = () => {
    const skip: SkipSite[] = [];
    for (const f of preview.files) {
      for (const s of f.sites) {
        if (skipped.has(siteKey(f.rel, s.line, s.col)))
          skip.push({ rel: f.rel, line: s.line, col: s.col });
      }
    }
    onConfirm(
      skip,
      preview.files.map((f) => ({ path: f.path, modified: f.modified }))
    );
  };

  return (
    <div className="replace-preview">
      <div className="preview-head">
        <span className="preview-title" title={STR.files.search.previewNoUndo}>
          {STR.files.search.previewHeader({ query, replacement })}
        </span>
        <div className="preview-actions">
          <button className="mini-btn" onClick={onCancel} disabled={busy}>
            {STR.files.search.previewCancel}
          </button>
          <button
            className="mini-btn on"
            onClick={confirm}
            disabled={busy || scope.places === 0}
            title={STR.files.search.previewNoUndo}
          >
            {STR.files.search.replaceLabel}
          </button>
        </div>
      </div>
      {/* The scope the confirm step quotes: this pane's own count. The
       * search list's count is deliberately not in this component at all. */}
      <div className="search-status">
        {STR.files.search.previewScope({
          files: scope.files,
          places: scope.places,
        })}
      </div>

      <div className="search-results">
        {preview.files.map((f) => {
          const checked = fileChecked(f);
          return (
            <div key={f.rel} className="search-group">
              <div
                className="search-file"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [f.rel]: !c[f.rel] }))
                }
              >
                <span className="tree-caret">
                  {collapsed[f.rel] ? "▸" : "▾"}
                </span>
                <input
                  type="checkbox"
                  className="search-check"
                  checked={checked > 0}
                  // Indeterminate would be honest for a partial file; the
                  // plain checkbox plus the x/y count says the same thing.
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    const all = checked === f.sites.length;
                    setSkipped((prev) => {
                      const next = new Set(prev);
                      for (const s of f.sites) {
                        const k = siteKey(f.rel, s.line, s.col);
                        if (all) next.add(k);
                        else next.delete(k);
                      }
                      return next;
                    });
                  }}
                  title={STR.files.search.previewFileCheckHint}
                />
                <span className="search-file-name" title={f.rel}>
                  {f.rel}
                </span>
                <span className="search-count">
                  {checked}/{f.sites.length}
                </span>
              </div>
              {!collapsed[f.rel] && (
                <>
                  {f.sites.map((s) => {
                    const k = siteKey(f.rel, s.line, s.col);
                    const hit = s.context.find((c) => c.line === s.line);
                    return (
                      <div key={k} className="search-hit preview-site">
                        <input
                          type="checkbox"
                          className="search-check"
                          checked={!skipped.has(k)}
                          onChange={() => toggleSite(f.rel, s.line, s.col)}
                          title={STR.files.search.previewSiteCheckHint}
                        />
                        <span className="preview-ctx">
                          {s.context.map((c) =>
                            c.line === s.line && hit ? (
                              <MarkedLine
                                key={c.line}
                                text={hit.text}
                                col={s.col}
                                beforeLen={s.beforeLen}
                                replacement={replacement}
                                line={c.line}
                              />
                            ) : (
                              <span key={c.line} className="preview-ctx-dim">
                                <span className="search-line">{c.line}</span>
                                <span className="preview-ctx-text">
                                  {c.text.trim()}
                                </span>
                              </span>
                            )
                          )}
                        </span>
                      </div>
                    );
                  })}
                  <CodeEditorComponent
                    path={`replace-preview:${f.rel}`}
                    value={applySites(
                      f.before,
                      f.sites,
                      replacement,
                      skipped,
                      f.rel
                    )}
                    original={f.before}
                    readOnly
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
