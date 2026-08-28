import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  parseNotebook,
  type Notebook,
  type NotebookCell,
  type NotebookOutput,
} from "./notebook";
import { ErrorState } from "../state/ErrorState";
import { STR } from "../strings";

export function NotebookView({ text }: { text: string }) {
  const parsed = useMemo(() => parseNotebook(text), [text]);

  if (!parsed.ok) {
    return (
      <div className="nb-view">
        <div className="preview-center">
          <ErrorState inline error={parsed.error} />
        </div>
      </div>
    );
  }

  return (
    <div
      className="nb-view"
      // Backstop matching MarkdownView: whatever clickable thing survived
      // sanitization must never navigate the app's webview.
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest("a")) e.preventDefault();
      }}
    >
      <Cells notebook={parsed.notebook} />
    </div>
  );
}

function Cells({ notebook }: { notebook: Notebook }) {
  return (
    <>
      {notebook.cells.map((cell, i) =>
        cell.type === "markdown" ? (
          <MarkdownCell key={i} source={cell.source} />
        ) : cell.type === "code" ? (
          <CodeCell key={i} cell={cell} language={notebook.language} />
        ) : (
          cell.source !== "" && (
            <pre key={i} className="nb-raw">
              {cell.source}
            </pre>
          )
        )
      )}
    </>
  );
}

function MarkdownCell({ source }: { source: string }) {
  // No DOMPurify hooks here: the notebook preview rewrites nothing, so a bare
  // sanitize call keeps the shared singleton exactly as other views left it.
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true })),
    [source]
  );
  return <div className="nb-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeCell({
  cell,
  language,
}: {
  cell: NotebookCell;
  language: string | null;
}) {
  return (
    <div className="nb-code">
      <div className="nb-code-head">
        <span className="nb-badge">
          {STR.files.notebook.inBadge({
            n: String(cell.executionCount ?? " "),
          })}
        </span>
        {language !== null && <span className="nb-lang">{language}</span>}
      </div>
      <pre className="nb-src">{cell.source}</pre>
      {cell.outputs.map((output, i) => (
        <Output key={i} output={output} />
      ))}
    </div>
  );
}

function Output({ output }: { output: NotebookOutput }) {
  switch (output.kind) {
    case "text":
    case "error":
      return (
        <>
          <pre className={`nb-output${output.kind === "error" ? " nb-error" : ""}`}>
            {output.text}
          </pre>
          {output.truncated && (
            <div className="nb-truncation">{STR.files.notebook.outputTruncated}</div>
          )}
        </>
      );
    case "image":
      return (
        <img
          className="nb-img"
          src={`data:image/png;base64,${output.base64}`}
          alt={STR.files.notebook.outputAlt}
        />
      );
    case "html":
      return <HtmlOutput html={output.html} />;
  }
}

function HtmlOutput({ html }: { html: string }) {
  // Rich outputs (pandas tables and the like) come straight from the file;
  // they must not be able to script this webview, which holds full IPC.
  const safe = useMemo(() => DOMPurify.sanitize(html), [html]);
  return (
    <div className="nb-output nb-html" dangerouslySetInnerHTML={{ __html: safe }} />
  );
}
