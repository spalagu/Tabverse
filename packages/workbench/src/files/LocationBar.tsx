import { useEffect, useRef, useState } from "react";
import { STR } from "../strings";
import { collapseRepeatedSlashes, trimTrailingSlashes } from "./pathStrings";

export interface LocationDirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export function normalizeLocationPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function resolveLocationInput(value: string, root: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return trimmed;
  const base = trimTrailingSlashes(root.trim());
  if (!base || base === "~") return normalizeLocationPath(`/${trimmed}`);
  if (base.startsWith("~")) {
    return collapseRepeatedSlashes(`${base}/${trimmed}`);
  }
  return normalizeLocationPath(`${base}/${trimmed}`);
}

export function locationSegmentCandidates(
  value: string,
  root: string
): { dir: string; partial: string } | null {
  const resolved = resolveLocationInput(value, root);
  if (!resolved) return null;
  const cut = resolved.lastIndexOf("/");
  return {
    dir: cut <= 0 ? "/" : resolved.slice(0, cut),
    partial: resolved.slice(cut + 1),
  };
}

export function completeLocationDirectories<T extends LocationDirectoryEntry>(
  entries: readonly T[],
  partial: string
): T[] {
  const prefix = partial.toLowerCase();
  return entries.filter(
    (entry) => entry.isDir && entry.name.toLowerCase().startsWith(prefix)
  );
}

export function applyLocationCompletion(
  value: string,
  name: string,
  isDirectory: boolean
): string {
  const cut = value.lastIndexOf("/");
  const head = cut <= 0 ? "" : value.slice(0, cut);
  const joined = head ? `${head}/${name}` : `/${name}`;
  return isDirectory ? `${joined}/` : joined;
}

export interface LocationBarProps {
  root: string;
  completionHint: string;
  listDirectories: (dir: string) => Promise<readonly LocationDirectoryEntry[]>;
  loadHistory: () => Promise<readonly string[]>;
  onSubmit: (resolved: string) => void;
  onClose: () => void;
}

/** Shared jump-to-directory control with completion and local history. */
export function LocationBar({
  root,
  completionHint,
  listDirectories,
  loadHistory,
  onSubmit,
  onClose,
}: LocationBarProps) {
  const [value, setValue] = useState(root);
  const [completions, setCompletions] = useState<
    readonly LocationDirectoryEntry[] | null
  >(null);
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<readonly string[]>([]);
  const historyIndex = useRef(-1);
  const beforeHistory = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadHistory().then(setHistory);
    inputRef.current?.focus();
  }, [loadHistory]);

  const complete = async () => {
    const segment = locationSegmentCandidates(value, root);
    if (!segment) return;
    try {
      const directories = completeLocationDirectories(
        await listDirectories(segment.dir),
        segment.partial
      );
      if (directories.length === 1) {
        setValue((current) =>
          applyLocationCompletion(current, directories[0].name, true)
        );
        setCompletions(null);
        return;
      }
      setCompletions(directories.length > 1 ? directories : null);
      setSelected(0);
    } catch {
      setCompletions(null);
    }
  };

  const take = (entry: LocationDirectoryEntry) => {
    setValue((current) =>
      applyLocationCompletion(current, entry.name, true)
    );
    setCompletions(null);
  };

  const stepHistory = (direction: 1 | -1) => {
    if (history.length === 0) return;
    if (direction === -1) {
      if (historyIndex.current === -1) beforeHistory.current = value;
      const next = Math.min(historyIndex.current + 1, history.length - 1);
      historyIndex.current = next;
      setValue(history[next]);
      return;
    }
    if (historyIndex.current === -1) return;
    const next = historyIndex.current - 1;
    historyIndex.current = next;
    setValue(next === -1 ? (beforeHistory.current ?? value) : history[next]);
  };

  return (
    <div className="loc-bar" style={{ gridColumn: "1 / -1" }}>
      <input
        ref={inputRef}
        className="loc-input"
        spellCheck={false}
        placeholder={STR.files.view.jumpPlaceholder}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setCompletions(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            const resolved = resolveLocationInput(value, root);
            onClose();
            if (resolved) onSubmit(resolved);
          } else if (event.key === "Escape") {
            onClose();
          } else if (
            event.key === "Tab" &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            void complete();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            if (completions && completions.length > 0) {
              setSelected((index) => (index + 1) % completions.length);
            } else {
              stepHistory(1);
            }
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (completions && completions.length > 0) {
              setSelected(
                (index) =>
                  (index - 1 + completions.length) % completions.length
              );
            } else {
              stepHistory(-1);
            }
          }
          event.stopPropagation();
        }}
        onBlur={onClose}
        aria-expanded={completions !== null}
      />
      {completions && completions.length > 0 && (
        <div
          className="loc-completions"
          onMouseDown={(event) => event.preventDefault()}
        >
          {completions.map((entry, index) => (
            <button
              key={entry.path}
              className={`loc-completion${index === selected ? " sel" : ""}`}
              aria-label={entry.path}
              onClick={() => take(entry)}
              onMouseEnter={() => setSelected(index)}
            >
              <span className="tree-name dir">{entry.name}</span>
              <span className="loc-completion-hint">{completionHint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
