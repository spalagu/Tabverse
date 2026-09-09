import { useEffect, useState } from "react";
import { STR } from "./strings";
import { rewriteRemoteHtml, type ProxyUrlResolver } from "./remoteBrowserDocument";

export { rewriteRemoteHtml as mirroredDocument } from "./remoteBrowserDocument";

/** The pane's one route to the host's network — App hands it the proxy
 * client's requestViaProxy. */
export type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;

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

export function BrowserPane({
  url,
  contextId,
  fetchViaHost,
  resolveProxyUrl = directUrl,
  networkProxyRoot,
}: {
  /** The host browser tab's address. */
  url: string;
  /** Stable routing key for this remote Browser tab; never an authority. */
  contextId?: string;
  fetchViaHost: HostFetch;
  /** Maps a host URL to the runtime's same-origin proxy endpoint. */
  resolveProxyUrl?: ProxyUrlResolver;
  /** Absolute same-origin root reserved for Host-network requests. */
  networkProxyRoot?: string;
}) {
  const [state, setState] = useState<PaneState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    setState({ kind: "loading" });
    // http AND https both ride the host's proxy now: the host terminates
    // TLS itself (the host gateway's reqwest half), so an https target is
    // fetched on the host's network like any other — its resolver, its
    // certificates, its egress.
    fetchViaHost(url, { signal: abort.signal })
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
            doc: rewriteRemoteHtml(
              body,
              res.url || url,
              resolveProxyUrl,
              contextId,
              networkProxyRoot,
            ),
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
      abort.abort();
    };
  }, [url, contextId, fetchViaHost, resolveProxyUrl, networkProxyRoot]);

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
      {/* Scripts run in an opaque sandbox origin. The injected CSP and
          bootstrap restrict their network access to this tab's Host proxy;
          no same-origin grant exposes the Join application or ticket. */}
      <iframe
        className="browser-pane-frame"
        title={STR.remote.web.browserPane.frameTitle({ url })}
        sandbox={networkProxyRoot === undefined ? "allow-forms" : "allow-forms allow-scripts"}
        srcDoc={state.doc}
      />
      <span className="browser-pane-chip">
        {STR.remote.web.browserPane.mirroredChip}
      </span>
    </div>
  );
}
