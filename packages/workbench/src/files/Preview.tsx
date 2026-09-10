import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";

export type FilePreviewKind =
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "binary";

export interface FilePreviewMeta {
  path: string;
  name: string;
  size: number;
  kind: FilePreviewKind;
  mime: string;
}

export interface FilePreviewRuntime {
  url: (path: string) => string;
  inspectImage: (path: string) => Promise<{ width: number; height: number } | null>;
  reveal: (path: string) => Promise<void>;
  formatSize: (bytes: number) => string;
}

export interface FilePreviewRenderers<Meta extends FilePreviewMeta> {
  InspectView: ComponentType<{ meta: Meta }>;
  SqliteView: ComponentType<{ meta: Meta }>;
  FontView: ComponentType<{ meta: Meta }>;
  HexView: ComponentType<{ meta: Meta }>;
}

export interface FilePreviewProps<Meta extends FilePreviewMeta> {
  meta: Meta;
  runtime: FilePreviewRuntime;
  renderers: FilePreviewRenderers<Meta>;
}

interface ContentHandlerContext<Meta extends FilePreviewMeta> {
  readonly meta: Meta;
  readonly runtime: FilePreviewRuntime;
  readonly renderers: FilePreviewRenderers<Meta>;
  readonly url: string;
}

export interface ContentHandler {
  readonly id: string;
  supports(meta: FilePreviewMeta): boolean;
  open<Meta extends FilePreviewMeta>(context: ContentHandlerContext<Meta>): ReactNode;
}

/** Ordered because content evidence is stronger than a generic binary fallback. */
export const CONTENT_HANDLERS: readonly ContentHandler[] = [
  {
    id: "image",
    supports: (meta) => meta.kind === "image",
    open: ({ meta, runtime, url }) =>
      meta.name.toLowerCase().endsWith(".svg") ? (
        <SvgPreview meta={meta} runtime={runtime} />
      ) : (
        <div className="preview-center column">
          <img className="preview-img" src={url} alt={meta.name} />
          <ImageCaption meta={meta} runtime={runtime} />
        </div>
      ),
  },
  {
    id: "pdf",
    supports: (meta) => meta.kind === "pdf",
    open: ({ meta, url }) => <iframe className="preview-frame" src={url} title={meta.name} />,
  },
  {
    id: "audio",
    supports: (meta) => meta.kind === "audio",
    open: ({ url }) => <div className="preview-center"><audio controls src={url} /></div>,
  },
  {
    id: "video",
    supports: (meta) => meta.kind === "video",
    open: ({ url }) => <div className="preview-center"><video className="preview-video" controls src={url} /></div>,
  },
  {
    id: "office",
    supports: (meta) => meta.kind === "document",
    open: ({ meta, runtime }) => <DocumentPreview meta={meta} runtime={runtime} />,
  },
  {
    id: "archive",
    supports: (meta) => meta.kind === "archive",
    open: ({ meta, renderers }) => <renderers.InspectView meta={meta} />,
  },
  {
    id: "sqlite",
    supports: (meta) => meta.kind === "binary" && meta.mime === "application/vnd.sqlite3",
    open: ({ meta, renderers }) => <renderers.SqliteView meta={meta} />,
  },
  {
    id: "font",
    supports: (meta) => meta.kind === "binary" && meta.mime.startsWith("font/"),
    open: ({ meta, renderers }) => <renderers.FontView meta={meta} />,
  },
  {
    id: "executable",
    supports: (meta) => meta.kind === "binary" && meta.mime === "application/x-executable",
    open: ({ meta, renderers }) => <renderers.InspectView meta={meta} />,
  },
  {
    id: "plist",
    supports: (meta) => meta.kind === "binary" && meta.name.toLowerCase().endsWith(".plist"),
    open: ({ meta, renderers }) => <renderers.InspectView meta={meta} />,
  },
  {
    id: "binary",
    supports: () => true,
    open: ({ meta, renderers }) => <renderers.HexView meta={meta} />,
  },
];

export function contentHandlerFor(meta: FilePreviewMeta): ContentHandler {
  const handler = CONTENT_HANDLERS.find((candidate) => candidate.supports(meta));
  if (handler === undefined) throw new Error("Content handler registry has no fallback");
  return handler;
}

/**
 * Non-text viewers. Images, PDF, audio and video are handed to the webview's
 * own decoders through the app's file protocol — nothing to bundle, and it
 * covers whatever the platform covers. Office documents are converted to HTML
 * or a table in JS, since no browser renders them natively.
 */
export function Preview<Meta extends FilePreviewMeta>({
  meta,
  runtime,
  renderers,
}: FilePreviewProps<Meta>) {
  const url = runtime.url(meta.path);
  const context: ContentHandlerContext<Meta> = { meta, runtime, renderers, url };
  return contentHandlerFor(meta).open(context);
}

function ImageCaption({
  meta,
  runtime,
}: {
  meta: FilePreviewMeta;
  runtime: FilePreviewRuntime;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDims(null);

    (async () => {
      try {
        const info = await runtime.inspectImage(meta.path);
        if (!cancelled && info) {
          setDims({ w: info.width, h: info.height });
        }
      } catch {
        // No caption beats an error banner under a working image.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path, runtime]);

  if (dims === null) return null;
  return (
    <div className="preview-sub">
      {STR.files.preview.imageCaption({
        w: dims.w,
        h: dims.h,
        size: runtime.formatSize(meta.size),
      })}
    </div>
  );
}

/**
 * SVGs render as images by default, but the markup is often what the user
 * actually came for — a toggle beats forcing them out to an editor.
 */
function SvgPreview({
  meta,
  runtime,
}: {
  meta: FilePreviewMeta;
  runtime: FilePreviewRuntime;
}) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const url = runtime.url(meta.path);

  useEffect(() => {
    setMode("rendered");
    setSource(null);
    setError(null);
  }, [meta.path]);

  useEffect(() => {
    if (mode !== "source" || source !== null || error !== null) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(runtime.url(meta.path));
        const text = await res.text();
        if (!cancelled) setSource(text);
      } catch (e) {
        if (!cancelled) setError(describeError(e, STR.errors.actions.readFile));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, source, error, meta.path, runtime]);

  return (
    <div className="svg-preview">
      <div className="svg-toggle">
        <button
          className={`btn${mode === "rendered" ? " active" : ""}`}
          onClick={() => setMode("rendered")}
        >
          {STR.files.preview.rendered}
        </button>
        <button
          className={`btn${mode === "source" ? " active" : ""}`}
          onClick={() => setMode("source")}
        >
          {STR.files.preview.source}
        </button>
      </div>
      {mode === "rendered" ? (
        <div className="preview-center column">
          <img className="preview-img" src={url} alt={meta.name} />
          <ImageCaption meta={meta} runtime={runtime} />
        </div>
      ) : error !== null ? (
        <div className="preview-center">
          <ErrorState inline error={error} />
        </div>
      ) : source === null ? (
        <div className="preview-center">
          {STR.files.viewers.loading({ name: meta.name })}
        </div>
      ) : (
        <pre className="inspect-mono-block">{source}</pre>
      )}
    </div>
  );
}

type DocState =
  | { phase: "loading" }
  | { phase: "html"; html: string }
  | { phase: "sheets"; sheets: { name: string; html: string }[] }
  | { phase: "error"; message: string | ErrorDescription };

function DocumentPreview({
  meta,
  runtime,
}: {
  meta: FilePreviewMeta;
  runtime: FilePreviewRuntime;
}) {
  const [state, setState] = useState<DocState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });

    (async () => {
      try {
        const res = await fetch(runtime.url(meta.path));
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        if (meta.name.toLowerCase().endsWith(".docx")) {
          const mammoth = await import("mammoth");
          const out = await mammoth.convertToHtml({ arrayBuffer: buf });
          // The converter parses an arbitrary file; its HTML must not be
          // able to script this webview (which holds full IPC).
          if (!cancelled)
            setState({ phase: "html", html: DOMPurify.sanitize(out.value) });
          return;
        }
        if (/\.(xlsx|xlsm|xls)$/i.test(meta.name)) {
          const XLSX = await import("xlsx");
          const wb = XLSX.read(buf, { type: "array" });
          const sheets = wb.SheetNames.map((name) => ({
            name,
            html: DOMPurify.sanitize(
              XLSX.utils.sheet_to_html(wb.Sheets[name], { id: `s-${name}` })
            ),
          }));
          if (!cancelled) setState({ phase: "sheets", sheets });
          return;
        }
        setState({
          phase: "error",
          message:
            meta.name.toLowerCase().endsWith(".pptx")
              ? STR.files.preview.pptxNote
              : STR.files.preview.legacyOfficeNote,
        });
      } catch (e) {
        if (!cancelled)
          setState({
            phase: "error",
            message: describeError(e, STR.errors.actions.previewFile),
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path, meta.name, runtime]);

  if (state.phase === "loading") {
    return (
      <div className="preview-center">
        {STR.files.viewers.converting({ name: meta.name })}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="preview-center column">
        {typeof state.message === "string" ? (
          <div className="preview-note">{state.message}</div>
        ) : (
          <ErrorState inline error={state.message} />
        )}
        <button className="btn" onClick={() => void runtime.reveal(meta.path)}>
          {STR.files.tree.revealInFinder}
        </button>
      </div>
    );
  }
  if (state.phase === "sheets") {
    return (
      <div className="doc-view">
        {state.sheets.map((s) => (
          <section key={s.name}>
            <h3 className="sheet-name">{s.name}</h3>
            <div
              className="sheet-table"
              dangerouslySetInnerHTML={{ __html: s.html }}
            />
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="doc-view">
      <div dangerouslySetInnerHTML={{ __html: state.html }} />
    </div>
  );
}
