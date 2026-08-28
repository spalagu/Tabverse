import { useCallback, useEffect, useRef, useState } from "react";
import { STR } from "../strings";
import { CloseIcon } from "../icons";

export function PreviewFind({
  container,
  isolated,
  onSearchSource,
  onClose,
  previousHint,
  nextHint,
}: {
  /** Where to look. Null while nothing is rendered yet. */
  container: HTMLElement | null;
  /** True when the preview is a frame this app cannot see into. */
  isolated: boolean;
  /** Hand the term to the source view, which can search and replace. */
  onSearchSource: (term: string) => void;
  onClose: () => void;
  previousHint: string;
  nextHint: string;
}) {
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState(0);
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Every mark this component put in the document, so it can take them all
  // back out — a preview must be left exactly as it was found.
  const marks = useRef<HTMLElement[]>([]);

  const clearMarks = useCallback(() => {
    for (const mark of marks.current) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
    marks.current = [];
  }, []);

  const run = useCallback(
    (needle: string) => {
      clearMarks();
      setAt(0);
      if (!container || isolated || needle.trim() === "") {
        setMatches(0);
        return;
      }
      const wanted = needle.toLowerCase();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const hits: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? "").toLowerCase().includes(wanted)) {
          hits.push(node as Text);
        }
      }
      // Wrapped after collecting, because wrapping while walking would put
      // the new nodes in the walker's own path.
      for (const text of hits) {
        const value = text.textContent ?? "";
        const lower = value.toLowerCase();
        const pieces = document.createDocumentFragment();
        let from = 0;
        for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, from)) {
          pieces.appendChild(document.createTextNode(value.slice(from, at)));
          const mark = document.createElement("mark");
          mark.className = "preview-find-hit";
          mark.textContent = value.slice(at, at + wanted.length);
          pieces.appendChild(mark);
          marks.current.push(mark);
          from = at + wanted.length;
        }
        pieces.appendChild(document.createTextNode(value.slice(from)));
        text.parentNode?.replaceChild(pieces, text);
      }
      setMatches(marks.current.length);
      if (marks.current.length > 0) {
        setAt(1);
      }
    },
    [container, isolated, clearMarks]
  );

  // Step to a match: the current one is marked apart from the rest, because
  // "which of the twelve am I on" is the question a count alone cannot
  // answer.
  useEffect(() => {
    marks.current.forEach((mark, i) => {
      mark.classList.toggle("current", i === at - 1);
    });
    const current = marks.current[at - 1];
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [at, matches]);

  useEffect(() => () => clearMarks(), [clearMarks]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const step = (delta: number) => {
    if (matches === 0) return;
    setAt((n) => ((n - 1 + delta + matches) % matches) + 1);
  };

  return (
    <div className="preview-find">
      <input
        ref={inputRef}
        className="preview-find-input"
        placeholder={
          isolated
            ? STR.files.previewFind.isolatedPlaceholder
            : STR.files.previewFind.placeholder
        }
        value={term}
        disabled={isolated}
        onChange={(e) => {
          setTerm(e.target.value);
          run(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onClose();
        }}
      />
      {isolated ? (
        <span className="preview-find-note">
          {STR.files.previewFind.isolatedNote}
        </span>
      ) : (
        <span className="preview-find-count">
          {term.trim() === ""
            ? ""
            : matches === 0
              ? STR.browser.noMatches
              : `${at}/${matches}`}
        </span>
      )}
      {!isolated && (
        <>
          <button
            className="mini-btn"
            title={STR.files.previewFind.prevMatchHint}
            aria-label={STR.files.previewFind.prevMatchHint}
            onClick={() => step(-1)}
          >
            {previousHint}
          </button>
          <button
            className="mini-btn"
            title={STR.files.previewFind.nextMatchHint}
            aria-label={STR.files.previewFind.nextMatchHint}
            onClick={() => step(1)}
          >
            {nextHint}
          </button>
        </>
      )}
      <button
        className="mini-btn"
        title={STR.files.previewFind.searchSourceHint}
        onClick={() => onSearchSource(term)}
      >
        {STR.files.previewFind.inSource}
      </button>
      <button
        className="mini-btn"
        title={STR.common.close}
        aria-label={STR.common.close}
        onClick={onClose}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
