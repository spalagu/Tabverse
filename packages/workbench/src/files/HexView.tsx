import { useEffect, useState } from "react";
import {
  HEX_PAGE,
  clampToRow,
  hexGroups,
  hexRows,
  lastPageStart,
  offsetDigits,
  parseOffsetInput,
} from "./hex";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";

export interface HexViewMeta {
  path: string;
  name: string;
  size: number;
}

export interface HexViewRuntime {
  readRange: (
    path: string,
    offset: number,
    len: number
  ) => Promise<{ b64: string; total: number }>;
  decodeBase64: (value: string) => Uint8Array;
  reveal: (path: string) => Promise<void>;
}

export interface HexViewProps<Meta extends HexViewMeta = HexViewMeta> {
  meta: Meta;
  runtime: HexViewRuntime;
}


interface Page {
  bytes: Uint8Array;
  /** The offset these bytes were read at — not the one being fetched. */
  base: number;
}

export function HexView<Meta extends HexViewMeta>({
  meta,
  runtime,
}: HexViewProps<Meta>) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [total, setTotal] = useState(meta.size);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);

  useEffect(() => {
    setOffset(0);
    setPage(null);
    setTotal(meta.size);
    setError(null);
  }, [meta.path, meta.size]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);

    (async () => {
      try {
        const res = await runtime.readRange(meta.path, offset, HEX_PAGE);
        if (cancelled) return;
        const bytes = runtime.decodeBase64(res.b64);
        setTotal(res.total);
        if (bytes.length === 0 && res.total > 0 && offset > 0) {
          // The file shrank under us; snap back to its (new) last page.
          setOffset(lastPageStart(res.total));
          return;
        }
        setPage({ bytes, base: offset });
      } catch (e) {
        if (!cancelled) setError(describeError(e, STR.errors.actions.readFile));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path, offset]);

  const jumpTo = (raw: string) => {
    const parsed = parseOffsetInput(raw);
    if (parsed === null) return;
    setOffset(clampToRow(parsed, total));
  };

  const digits = offsetDigits(total);
  const reveal = (
    <button className="mini-btn" onClick={() => void runtime.reveal(meta.path)}>
      {STR.files.tree.revealInFinder}
    </button>
  );

  return (
    <div className="hex-view">
      <div className="hex-head">
        <span className="hex-pos">
          {STR.files.hex.position({
            offset: offset.toString(16),
            total: total.toLocaleString(),
          })}
        </span>
        <span className="hex-head-spacer" />
        <button
          className="mini-btn"
          disabled={busy || offset === 0}
          title={STR.files.hex.firstPageHint}
          onClick={() => setOffset(0)}
        >
          {STR.files.hex.start}
        </button>
        <button
          className="mini-btn"
          disabled={busy || offset === 0}
          title={STR.files.hex.prevPageHint}
          onClick={() => setOffset(Math.max(0, offset - HEX_PAGE))}
        >
          {STR.files.hex.prev}
        </button>
        <button
          className="mini-btn"
          disabled={busy || offset + HEX_PAGE >= total}
          title={STR.files.hex.nextPageHint}
          onClick={() => setOffset(offset + HEX_PAGE)}
        >
          {STR.files.hex.next}
        </button>
        <button
          className="mini-btn"
          disabled={busy || offset >= lastPageStart(total)}
          title={STR.files.hex.lastPageHint}
          onClick={() => setOffset(lastPageStart(total))}
        >
          {STR.files.hex.end}
        </button>
        <input
          className="hex-jump"
          placeholder={STR.files.hex.jumpPlaceholder}
          spellCheck={false}
          title={STR.files.hex.jumpHint}
          onKeyDown={(e) => {
            if (e.key === "Enter") jumpTo(e.currentTarget.value);
            e.stopPropagation();
          }}
        />
        {reveal}
      </div>
      {error !== null ? (
        <div className="preview-center column">
          <ErrorState inline error={error} />
        </div>
      ) : page === null ? (
        <div className="preview-center">
          {STR.files.viewers.reading({ name: meta.name })}
        </div>
      ) : total === 0 ? (
        <div className="preview-center">
          <div className="preview-note">{STR.files.hex.emptyFile}</div>
        </div>
      ) : (
        <div className="hex-scroll">
          <pre className="hex-dump">
            {hexRows(page.bytes, page.base, digits).map((r) => (
              <span key={r.offset}>
                <span className="hex-off">{r.offset}</span>
                {"  "}
                <span className="hex-bytes">
                  {hexGroups(r.hex).map((group, gi) => (
                    <span key={gi} className="hex-group">
                      {group}
                    </span>
                  ))}
                </span>
                {"  "}
                <span className="hex-ascii">{r.ascii}</span>
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
