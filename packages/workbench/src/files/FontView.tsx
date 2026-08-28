import { useEffect, useState } from "react";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";

export interface FontViewMeta {
  path: string;
  name: string;
  size: number;
  mime: string;
}


const PANGRAM = "The quick brown fox jumps over the lazy dog";
const FIGURES = "0123456789 ·,.;:!?_-–—/\\ ()[]{}<> @#$%&*+=~ '\"";
const BODY =
  "Body text is where a face earns its keep: even color, open counters, and " +
  "clear pairs like Il1, O0, rn and m are what make a paragraph readable at " +
  "small sizes long before any display setting flatters it.";

/** Stable per-path family name so two open previews never collide. */
function familyFor(path: string): string {
  // FNV-1a, 32-bit — not cryptographic, just a distinct CSS identifier.
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `tabverse-specimen-${(h >>> 0).toString(16)}`;
}

export type FontMeta = {
  family: string;
  style: string;
  glyphCount: number;
  variable: boolean;
};

export interface FontViewRuntime {
  url: (path: string) => string;
  inspectFont: (path: string) => Promise<FontMeta | null>;
  reveal: (path: string) => Promise<void>;
  formatSize: (bytes: number) => string;
}

export interface FontViewProps<Meta extends FontViewMeta = FontViewMeta> {
  meta: Meta;
  runtime: FontViewRuntime;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; family: string }
  | { phase: "error"; message: string | ErrorDescription };

export function FontView<Meta extends FontViewMeta>({
  meta,
  runtime,
}: FontViewProps<Meta>) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [info, setInfo] = useState<FontMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: "loading" });

    const family = familyFor(meta.path);
    let face: FontFace;
    try {
      face = new FontFace(family, `url("${runtime.url(meta.path)}")`);
    } catch (e) {
      setLoad({
        phase: "error",
        message: describeError(e, STR.errors.actions.loadFont),
      });
      return;
    }
    document.fonts.add(face);

    // A corrupt file must surface as an error, never as the specimen quietly
    // rendering in a fallback face: document.fonts.load rejects (or leaves
    // the face un-loaded) when the bytes don't decode as a font.
    document.fonts.load(`16px "${family}"`).then(
      () => {
        if (cancelled) return;
        if (face.status === "loaded") setLoad({ phase: "ready", family });
        else
          setLoad({
            phase: "error",
            message: STR.files.font.notFont,
          });
      },
      (e) => {
        if (!cancelled)
          setLoad({
            phase: "error",
            message: describeError(e, STR.errors.actions.loadFont),
          });
      }
    );

    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [meta.path]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);

    // Metadata is a bonus on top of the specimen: "unsupported" (woff/woff2)
    // and inspection failures both just mean no header line.
    (async () => {
      try {
        const data = await runtime.inspectFont(meta.path);
        if (!cancelled) setInfo(data);
      } catch {
        // Specimen still stands on its own.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  if (load.phase === "loading") {
    return (
      <div className="preview-center">
        {STR.files.viewers.loading({ name: meta.name })}
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div className="preview-center column">
        {typeof load.message === "string" ? (
          <div className="preview-note">{load.message}</div>
        ) : (
          <ErrorState inline error={load.message} />
        )}
        <div className="preview-sub">
          {meta.name} · {runtime.formatSize(meta.size)} · {meta.mime}
        </div>
        <button className="btn" onClick={() => void runtime.reveal(meta.path)}>
          {STR.files.tree.revealInFinder}
        </button>
      </div>
    );
  }

  const specimen = { fontFamily: `"${load.family}"` };
  return (
    <div className="font-view">
      {info !== null && (
        <div className="font-meta">
          <span className="font-meta-family">{info.family}</span>
          {info.style && <span>{info.style}</span>}
          <span>{STR.files.font.glyphCount({ n: info.glyphCount })}</span>
          <span>
            {info.variable ? STR.files.font.variable : STR.files.font.static}
          </span>
        </div>
      )}
      <div className="font-line" style={{ ...specimen, fontSize: 42 }}>
        {PANGRAM}
      </div>
      <div className="font-line" style={{ ...specimen, fontSize: 26 }}>
        {PANGRAM}
      </div>
      <div className="font-line" style={{ ...specimen, fontSize: 15 }}>
        {PANGRAM}
      </div>
      <div className="font-figures" style={{ ...specimen, fontSize: 20 }}>
        {FIGURES}
      </div>
      <p className="font-body" style={specimen}>
        {BODY}
      </p>
    </div>
  );
}
