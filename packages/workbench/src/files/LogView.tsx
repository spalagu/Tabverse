import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LOG_TEXT_CAP,
  LOG_WINDOW,
  alignToLineStart,
  decodeLossy,
  prependCapped,
  utf8Len,
} from "./logWindow";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";

export interface LogViewMeta {
  path: string;
  name: string;
}

export interface LogViewRuntime {
  readRange: (
    path: string,
    offset: number,
    len: number
  ) => Promise<{ b64: string; total: number }>;
  decodeBase64: (value: string) => Uint8Array;
}

export interface LogViewProps<Meta extends LogViewMeta = LogViewMeta> {
  meta: Meta;
  runtime: LogViewRuntime;
}


interface Win {
  /** Byte offset of the first displayed character. */
  lo: number;
  /**
   * Byte offset just past the last displayed character. Approximate after a
   * cap trim over invalid UTF-8, where replacement chars re-encode to a
   * different length than the bytes they stood for.
   */
  hi: number;
  /** File size at the last stat — refresh re-reads it, logs grow. */
  total: number;
  text: string;
  /** Set once the cap has forced the newest end out of memory. */
  capTrimmed: boolean;
}

type Scroll = "top" | "bottom" | { fromBottom: number };

export function LogView<Meta extends LogViewMeta>({
  meta,
  runtime,
}: LogViewProps<Meta>) {
  const [win, setWin] = useState<Win | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<Scroll | null>(null);
  // Bumped on every new load and on unmount/path change, so a stale response
  // can never overwrite a newer window.
  const epoch = useRef(0);

  const loadEdge = useCallback(
    async (edge: "head" | "tail") => {
      const id = ++epoch.current;
      setBusy(true);
      setError(null);
      try {
        // Probe for the current size first: the tail offset depends on it,
        // and meta.size goes stale the moment a log keeps growing.
        const probe = await runtime.readRange(meta.path, 0, 1);
        const total = probe.total;
        let lo = edge === "tail" ? Math.max(0, total - LOG_WINDOW) : 0;
        let hi = lo;
        let text = "";
        if (total > 0) {
          const res = await runtime.readRange(
            meta.path,
            lo,
            Math.min(LOG_WINDOW, total - lo)
          );
          const raw = runtime.decodeBase64(res.b64);
          hi = lo + raw.length;
          const { bytes, droppedBytes } = alignToLineStart(raw, lo === 0);
          lo += droppedBytes;
          text = decodeLossy(bytes);
        }
        if (epoch.current !== id) return;
        pendingScroll.current = edge === "tail" ? "bottom" : "top";
        setWin({ lo, hi, total, text, capTrimmed: false });
      } catch (e) {
        if (epoch.current === id) setError(describeError(e, STR.errors.actions.readFile));
      } finally {
        if (epoch.current === id) setBusy(false);
      }
    },
    [meta.path]
  );

  const loadEarlier = useCallback(async () => {
    if (!win || win.lo === 0) return;
    const id = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const newLo = Math.max(0, win.lo - LOG_WINDOW);
      const res = await runtime.readRange(meta.path, newLo, win.lo - newLo);
      const raw = runtime.decodeBase64(res.b64);
      const { bytes, droppedBytes } = alignToLineStart(raw, newLo === 0);
      const older = decodeLossy(bytes);
      const { text, cut } = prependCapped(older, win.text, LOG_TEXT_CAP);
      if (epoch.current !== id) return;
      // Anchor on the distance to the bottom: prepended text grows the top,
      // so keeping that distance keeps the same lines in front of the eye.
      const el = scrollRef.current;
      pendingScroll.current = {
        fromBottom: el ? el.scrollHeight - el.scrollTop : 0,
      };
      setWin({
        lo: newLo + droppedBytes,
        hi: win.hi - utf8Len(cut),
        total: win.total,
        text,
        capTrimmed: win.capTrimmed || cut.length > 0,
      });
    } catch (e) {
      if (epoch.current === id) setError(describeError(e, STR.errors.actions.readFile));
    } finally {
      if (epoch.current === id) setBusy(false);
    }
  }, [win, meta.path]);

  useEffect(() => {
    setWin(null);
    setError(null);
    void loadEdge("tail");
    return () => {
      epoch.current++;
    };
  }, [loadEdge]);

  // Scroll after the new text is in the DOM but before paint, so neither a
  // tail jump nor a prepend ever flashes at the wrong position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const intent = pendingScroll.current;
    if (!el || intent === null) return;
    pendingScroll.current = null;
    if (intent === "bottom") el.scrollTop = el.scrollHeight;
    else if (intent === "top") el.scrollTop = 0;
    else el.scrollTop = el.scrollHeight - intent.fromBottom;
  }, [win]);

  if (win === null) {
    return error !== null ? (
      <div className="preview-center column">
        <ErrorState inline error={error} />
        <button className="btn" onClick={() => void loadEdge("tail")}>
          {STR.common.retry}
        </button>
      </div>
    ) : (
      <div className="preview-center">
        {STR.files.viewers.loadingTail({ name: meta.name })}
      </div>
    );
  }

  const position =
    win.hi >= win.total ? "tail" : win.lo === 0 ? "head" : "mid";

  return (
    <div className="log-view">
      <div className="log-head">
        <span className="log-range">
          {STR.files.log.range({
            lo: win.lo.toLocaleString(),
            hi: win.hi.toLocaleString(),
            total: win.total.toLocaleString(),
            position,
          })}
          {win.capTrimmed && STR.files.log.capTrimmedSuffix}
        </span>
        <span className="log-head-spacer" />
        <button
          className="mini-btn"
          disabled={busy}
          title={STR.files.log.jumpStartHint}
          onClick={() => void loadEdge("head")}
        >
          {STR.files.hex.start}
        </button>
        <button
          className="mini-btn"
          disabled={busy}
          title={STR.files.log.jumpEndHint}
          onClick={() => void loadEdge("tail")}
        >
          {STR.files.hex.end}
        </button>
        <button
          className="mini-btn"
          disabled={busy || win.lo === 0}
          onClick={() => void loadEarlier()}
        >
          {STR.files.log.loadEarlier}
        </button>
        <button
          className="mini-btn"
          disabled={busy}
          title={STR.files.log.refreshHint}
          onClick={() => void loadEdge("tail")}
        >
          {STR.files.log.refresh}
        </button>
      </div>
      {error !== null && <ErrorState inline error={error} />}
      <div className="log-scroll" ref={scrollRef}>
        {win.total === 0 ? (
          <div className="preview-center">
            <div className="preview-note">{STR.files.log.emptyFile}</div>
          </div>
        ) : (
          <pre className="log-text">{win.text}</pre>
        )}
      </div>
    </div>
  );
}
