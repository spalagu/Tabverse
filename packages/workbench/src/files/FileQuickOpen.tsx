import { useEffect, useMemo, useRef, useState } from "react";
import { STR } from "../strings";

/** Subsequence score for quick-open: longer runs and earlier hits win. */
export function scoreFileQuickOpen(needle: string, path: string): number | null {
  if (!needle) return 0;
  const query = needle.toLowerCase();
  const candidate = path.toLowerCase();
  let candidateIndex = 0;
  let streak = 0;
  let best = 0;
  for (const character of query) {
    const at = candidate.indexOf(character, candidateIndex);
    if (at < 0) return null;
    streak = at === candidateIndex ? streak + 1 : 1;
    best = Math.max(best, streak);
    candidateIndex = at + 1;
  }
  const basenameIndex = candidate.lastIndexOf("/") + 1;
  const basenameBonus = candidateIndex > basenameIndex ? 4 : 0;
  return best * 10 + basenameBonus - candidateIndex / 100;
}

export function rankFileQuickOpen(
  paths: readonly string[],
  query: string,
  limit = 14
): { path: string; score: number }[] {
  if (query === "") {
    return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
  }
  return paths
    .map((path) => ({ path, score: scoreFileQuickOpen(query, path) }))
    .filter(
      (entry): entry is { path: string; score: number } =>
        entry.score !== null
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export interface FileQuickOpenProps {
  root: string;
  showHidden: boolean;
  walk: (root: string, showHidden: boolean) => Promise<readonly string[]>;
  onPick: (relativePath: string) => void;
  onClose: () => void;
  placeholder?: string;
}

/** Shared quick-open overlay used for file opening and compare target picking. */
export function FileQuickOpen({
  root,
  showHidden,
  walk,
  onPick,
  onClose,
  placeholder,
}: FileQuickOpenProps) {
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [walkFailed, setWalkFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setWalkFailed(false);
    void walk(root, showHidden)
      .then((paths) => {
        if (alive) setFiles(paths);
      })
      .catch(() => {
        if (!alive) return;
        setFiles([]);
        setWalkFailed(true);
      });
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      alive = false;
      window.clearTimeout(focusTimer);
    };
  }, [root, showHidden, walk]);

  const results = useMemo(
    () => (files === null ? [] : rankFileQuickOpen(files, query)),
    [files, query]
  );

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="switcher-input"
          placeholder={
            files === null
              ? STR.files.quickOpen.indexing
              : (placeholder ?? STR.files.quickOpen.placeholder)
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((index) =>
                Math.min(index + 1, Math.max(0, results.length - 1))
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const result = results[selected];
              if (result) onPick(result.path);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            event.stopPropagation();
          }}
        />
        <div className="switcher-list">
          {results.length === 0 && (
            <div className="switcher-empty">
              {walkFailed
                ? STR.files.quickOpen.indexFailed
                : files === null
                  ? STR.files.quickOpen.indexing
                  : STR.files.quickOpen.empty}
            </div>
          )}
          {results.map((result, index) => {
            const basename = result.path.split("/").pop();
            const directory = result.path.slice(
              0,
              result.path.length - (basename?.length ?? 0)
            );
            return (
              <button
                key={result.path}
                className={`switcher-row${index === selected ? " sel" : ""}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onPick(result.path)}
              >
                <span className="switcher-title">{basename}</span>
                <span className="switcher-group">{directory}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
