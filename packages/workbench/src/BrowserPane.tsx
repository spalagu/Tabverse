import { useEffect, useState } from "react";
import { STR } from "./strings";

/** The pane's one route to the host's network — App hands it the proxy
 * client's requestViaProxy. */
export type HostFetch = (url: string) => Promise<Response>;

const directUrl = (target: string): string => target;

type PaneState =
  | { kind: "loading" }
  | { kind: "mirrored"; doc: string }
  | { kind: "unmirrored"; line: string; detail: string | null };

/** Why a fetched-but-unshowable answer refuses mirroring, as one STR
 * line: the host's proxy spoke HTTP and this is what it said. */
function refusalOf(res: Response): string {
  if (!res.ok) {
    const status = `${res.status} ${res.statusText}`.trim();
    return STR.remote.web.browserPane.unmirroredStatus({ status });
  }
  // ok, but not a document the pane can render.
  return STR.remote.web.browserPane.unmirroredType;
}

/** The URL a document's relative subresources resolve against: its own
 * directory, query dropped — the standard base of an HTML page. */
function documentBase(url: string): string {
  const u = new URL(url);
  const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  return `${u.protocol}//${u.host}${dir}`;
}

/**
 * The document as the pane renders it: our <base> first in <head> —
 * document order decides which base wins, and ours names the proxy
 * endpoint the pane's whole mirror is addressed by — with a synthetic
 * head for documents that ship without one.
 */
function mirroredDocument(
  html: string,
  url: string,
  resolveProxyUrl: (target: string) => string,
): string {
  const tag = `<base href="${resolveProxyUrl(documentBase(url))}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${tag}</head>`);
  }
  return `<html><head>${tag}</head><body>${html}</body></html>`;
}

export function BrowserPane({
  url,
  fetchViaHost,
  resolveProxyUrl = directUrl,
}: {
  /** The host browser tab's address. */
  url: string;
  fetchViaHost: HostFetch;
  /** Maps a host URL to the runtime's same-origin proxy endpoint. */
  resolveProxyUrl?: (target: string) => string;
}) {
  const [state, setState] = useState<PaneState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    // http AND https both ride the host's proxy now: the host terminates
    // TLS itself (remote_proxy.rs's reqwest half), so an https target is
    // fetched on the host's network like any other — its resolver, its
    // certificates, its egress.
    fetchViaHost(url)
      .then(async (res) => {
        const body = res.ok ? await res.text() : "";
        if (!alive) return;
        // An HTML document is what the pane can mirror; anything else —
        // a PDF, an image, a download — is a refusal line, not a broken
        // frame.
        const html = (res.headers.get("content-type") ?? "")
          .toLowerCase()
          .includes("text/html");
        if (res.ok && html) {
          setState({
            kind: "mirrored",
            doc: mirroredDocument(body, url, resolveProxyUrl),
          });
        } else {
          setState({ kind: "unmirrored", line: refusalOf(res), detail: null });
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setState({
          kind: "unmirrored",
          line: STR.remote.web.browserPane.unmirroredWhy,
          // The transport's own words (timeout, refused name, https) as
          // the detail line, never spliced into the sentence.
          detail: e instanceof Error ? e.message : null,
        });
      });
    return () => {
      alive = false;
    };
  }, [url, fetchViaHost, resolveProxyUrl]);

  if (state.kind === "loading") {
    return (
      <div className="browser-pane browser-pane-loading" role="status">
        {STR.remote.web.browserPane.loading}
      </div>
    );
  }
  if (state.kind === "unmirrored") {
    return (
      <div className="browser-pane browser-pane-unmirrored">
        <p className="browser-pane-label">
          {STR.remote.web.browserPane.unmirroredLabel}
        </p>
        <p className="browser-pane-reason">{state.line}</p>
        {state.detail !== null && (
          <p className="browser-pane-detail">{state.detail}</p>
        )}
        <a
          className="browser-pane-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {STR.remote.web.browserPane.openOriginal}
        </a>
      </div>
    );
  }
  return (
    <div className="browser-pane browser-pane-mirrored">
      {/* allow-same-origin, no allow-scripts: the document's relative
          URLs load against this origin (no CORS wall on top of the
          endpoint 404s), while nothing it carries can execute — the
          sandbox omits script permission entirely. */}
      <iframe
        className="browser-pane-frame"
        title={STR.remote.web.browserPane.frameTitle({ url })}
        sandbox="allow-same-origin"
        srcDoc={state.doc}
      />
      <span className="browser-pane-chip">
        {STR.remote.web.browserPane.mirroredChip}
      </span>
    </div>
  );
}
