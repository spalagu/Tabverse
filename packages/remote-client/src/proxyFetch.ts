
/** Milliseconds one proxied request may take page-side — the same
 * whole-exchange budget the host's proxy enforces (remote_proxy.rs's
 * REQ_DEADLINE). Whichever expires first surfaces as a rejection; the
 * pairing means a viewer never waits on one deadline twice. */
export const PROXY_TIMEOUT_MS = 30_000;

/**
 * The same-origin path that stands for "the host's network". A URL under
 * this prefix names its target by mirroring it after the scheme segment:
 *
 *   /__tabverse_proxy/http/intranet.example/dir/page?q=1
 *
 * Path-form (not ?url=) on purpose: relative resolution against a
 * <base href> pointing here rewrites a document's relative subresource
 * paths onto the endpoint — `x.js` beside `/…/dir/page` resolves to
 * `/…/dir/x.js`, root-absolute `/x.js` to `/…/http/intranet.example/x.js`
 * — which a query-parameter form cannot do.
 */
export const PROXY_PATH_PREFIX = "/__tabverse_proxy/";

/**
 * The endpoint path standing for one host-side URL, origin-relative so
 * it is valid as a fetch input, an anchor href or a <base href> on any
 * origin the join page itself is served from (Pages site, single-file
 * artifact, dev server). Non-http(s) schemes are the caller's error:
 * the host's proxy would refuse them anyway.
 * Path-form (not ?url=) on purpose: relative resolution against a
 * <base href> pointing here rewrites a document's directory-relative
 * subresource paths onto the endpoint — `x.js` beside `/…/dir/page`
 * resolves to `/…/dir/x.js`. Two escapes are inherent to URL semantics
 * and stated rather than hidden: a ROOT-absolute `/x.js` resolves
 * against the join origin's root (off the endpoint, unproxied), and a
 * protocol-relative `//host/x` resolves against the join page's own
 * scheme (cross-origin, unproxied). A query-parameter form could not
 * even do the directory-relative case.
 */
export function proxyUrlFor(target: string): string {
  const u = new URL(target);
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`the proxy carries http requests only, not ${u.protocol}`);
  }
  return `${PROXY_PATH_PREFIX}${scheme}/${u.host}${u.pathname}${u.search}`;
}
/**
 * The host-side URL a request to this path is aimed at, or null when the
 * path is not under the endpoint (or names no http scheme). Origin is
 * deliberately NOT checked here — the fetch patch below owns the
 * same-origin gate — so the mapping stays pure path arithmetic and the
 * same function reads back what proxyUrlFor wrote, from any origin.
 */
export function targetFromProxyUrl(url: URL): string | null {
  if (!url.pathname.startsWith(PROXY_PATH_PREFIX)) return null;
  const rest = url.pathname.slice(PROXY_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const scheme = rest.slice(0, slash);
  if (scheme !== "http" && scheme !== "https") return null;
  return `${scheme}://${rest.slice(slash + 1)}${url.search}`;
}

/** What the page hands the client: the wasm seam's send, with the id the
 * answer will correlate on. Kept as a parameter so tests (and any future
 * non-wasm transport) supply their own. */
export type ProxyReqSend = (
  id: number,
  head: string,
  body: string | undefined
) => void;

/** One request head as the host's proxy parses it (remote_proxy.rs
 * target_of): request line in absolute form, a Host the authority is
 * read from, and the length said when a body rides along. */
function buildRequestHead(req: Request, body: string | undefined): string {
  const lines = [
    `${req.method} ${req.url} HTTP/1.1`,
    `Host: ${new URL(req.url).host}`,
  ];
  req.headers.forEach((value, name) => {
    // The head's own Host line above is the authority; a caller's copy
    // would only duplicate it.
    if (name.toLowerCase() !== "host") lines.push(`${name}: ${value}`);
  });
  if (body !== undefined) {
    // Bytes, not characters: the host reads this many bytes off the wire.
    lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** The Response one ProxyRes amounts to: status line and headers parsed
 * back out of the head text, the body decoded from its base64 frame
 * into the exact bytes (text and binary alike — an image or a font
 * crosses intact). Throws — settling the waiter with a rejection — when
 * the head is not an HTTP status line, which is a malformed answer, not
 * a page to render. */
function responseFrom(head: string, bodyB64: string | undefined): Response {
  const lines = head.split(/\r?\n/);
  const statusMatch = /^HTTP\/\d(?:\.\d)? (\d+)(?: (.*))?$/.exec(
    lines[0] ?? ""
  );
  if (statusMatch === null) {
    throw new Error("the host's proxy answer was not an HTTP head");
  }
  const status = Number(statusMatch[1]);
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  // 204/205/304 may not carry a Response body — the constructor throws
  // on one, and a proxied 204 must resolve, not explode on arrival.
  const nullBody = status === 204 || status === 205 || status === 304;
  let payload: ArrayBuffer | null = null;
  if (bodyB64 !== undefined && !nullBody) {
    const bin = atob(bodyB64);
    payload = new ArrayBuffer(bin.length);
    const view = new Uint8Array(payload);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  }
  return new Response(payload, {
    status,
    statusText: statusMatch[2] ?? "",
    headers,
  });
}

/** One waiting request: its timer and the promise's two ends. */
interface Waiting {
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}

/** The client the page keeps for the session's lifetime. */
export interface ProxyClient {
  /** One fetch through the host's network. Rejection is transport or
   * budget (timeout, refused target, dead session) — an HTTP error
   * status is a resolved Response, the same split window.fetch has. */
  requestViaProxy(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response>;
  /** A proxyRes landed: resolve the waiter it correlates. Unknown ids —
   * already answered, timed out, or never ours — are dropped silently. */
  settle(id: number, head: string, body?: string): void;
  /** The host's error arm: a ProxyReq it could not run comes back as an
   * rpcResult carrying the same id (app_share.rs), not a proxyRes.
   * Returns whether this frame claimed a waiter; anything else falls
   * through to the ordinary frame dispatch untouched. */
  consumeRpcResult(frame: unknown): boolean;
  /** Reject every waiter — the session ended. Pending panes surface as
   * errors instead of riding out their timers. */
  failAll(reason: string): void;
}

export interface BrowserAttachment {
  readonly id: string;
  readonly generation: number;
}

export interface BrowserStreamSend {
  open(frame: {
    streamId: number;
    tabId: string;
    grantId: string;
    attachmentId: string;
    attachmentGeneration: number;
    method: string;
    url: string;
    headers: Array<[string, string]>;
    bodyLen?: number;
  }): void;
  requestChunk(streamId: number, seq: number, b64: string): void;
  requestEnd(streamId: number): void;
  credit(streamId: number, bytes: number): void;
  cancel(streamId: number, reason?: string): void;
}

export type BrowserStreamHostFrame =
  | {
      type: "browserResponseHead";
      streamId: number;
      status: number;
      headers: Array<[string, string]>;
      finalUrl: string;
    }
  | { type: "browserResponseChunk"; streamId: number; seq: number; b64: string }
  | { type: "browserResponseEnd"; streamId: number }
  | { type: "browserResponseError"; streamId: number; code: string; message: string };

interface BrowserWaiting {
  readonly method: string;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
  readonly abort?: () => void;
  readonly headTimer: ReturnType<typeof setTimeout>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  expectedSeq: number;
  uncreditedBytes: number;
  settled: boolean;
}

export interface BrowserStreamClient {
  requestViaHost(
    tabId: string,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response>;
  consume(frame: unknown): boolean;
  failAll(reason: string): void;
}

const STREAM_ID_START = 2 ** 31;
const REQUEST_CHUNK_BYTES = 64 * 1024;
const INITIAL_RESPONSE_CREDIT = 512 * 1024;

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Browser A's http-stream-v2 client: binary request chunks up, a
 * requester-private ReadableStream down, explicit byte credit, and AbortSignal
 * cancellation. The host-issued attachment identity is read at open time so a
 * reconnect cannot reuse an old generation. */
export function createBrowserStreamClient(
  send: BrowserStreamSend,
  attachment: () => BrowserAttachment | null,
): BrowserStreamClient {
  const waiting = new Map<number, BrowserWaiting>();
  let nextStreamId = STREAM_ID_START;

  async function requestViaHost(
    tabId: string,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const owner = attachment();
    if (owner === null) throw new Error("browser stream has no live attachment");
    const request = new Request(input, init);
    if (!/^https?:$/.test(new URL(request.url).protocol)) {
      throw new Error("Browser A carries HTTP(S) only");
    }
    if (request.signal.aborted) throw new DOMException("request aborted", "AbortError");
    const body = request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
    const streamId = ++nextStreamId;
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, name) => headers.push([name, value]));

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        send.cancel(streamId, "viewer-abort");
        const current = waiting.get(streamId);
        if (current === undefined) return;
        waiting.delete(streamId);
        clearTimeout(current.headTimer);
        const error = new DOMException("request aborted", "AbortError");
        if (current.controller !== undefined) current.controller.error(error);
        if (!current.settled) current.reject(error);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const headTimer = setTimeout(() => {
        const current = waiting.get(streamId);
        if (current === undefined || current.settled) return;
        waiting.delete(streamId);
        send.cancel(streamId, "response-head-timeout");
        current.abort?.();
        current.reject(new Error(`browser response head timed out after ${PROXY_TIMEOUT_MS}ms`));
      }, PROXY_TIMEOUT_MS);
      waiting.set(streamId, {
        method: request.method,
        resolve,
        reject,
        abort: () => request.signal.removeEventListener("abort", onAbort),
        headTimer,
        expectedSeq: 0,
        uncreditedBytes: 0,
        settled: false,
      });
      send.open({
        streamId,
        tabId,
        grantId: `browser-grant-v1:${owner.id}:${owner.generation}:${tabId}`,
        attachmentId: owner.id,
        attachmentGeneration: owner.generation,
        method: request.method,
        url: request.url,
        headers,
        bodyLen: body.length === 0 ? undefined : body.length,
      });
      for (let offset = 0, seq = 0; offset < body.length; offset += REQUEST_CHUNK_BYTES, seq += 1) {
        send.requestChunk(
          streamId,
          seq,
          bytesToB64(body.subarray(offset, offset + REQUEST_CHUNK_BYTES)),
        );
      }
      send.credit(streamId, INITIAL_RESPONSE_CREDIT);
      send.requestEnd(streamId);
    });
  }

  function consume(frame: unknown): boolean {
    if (typeof frame !== "object" || frame === null) return false;
    const value = frame as Partial<BrowserStreamHostFrame> & Record<string, unknown>;
    if (
      value.type !== "browserResponseHead" &&
      value.type !== "browserResponseChunk" &&
      value.type !== "browserResponseEnd" &&
      value.type !== "browserResponseError"
    ) return false;
    const streamId = Number(value.streamId);
    const current = waiting.get(streamId);
    if (current === undefined) return true;

    if (value.type === "browserResponseHead") {
      if (current.settled) return true;
      clearTimeout(current.headTimer);
      const status = Number(value.status);
      const nullBody = current.method === "HEAD" || status === 204 || status === 205 || status === 304;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = nullBody ? null : new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
          current.controller = next;
        },
        pull() {
          if (current.uncreditedBytes > 0) {
            send.credit(streamId, current.uncreditedBytes);
            current.uncreditedBytes = 0;
          }
        },
        cancel(reason) {
          send.cancel(streamId, String(reason ?? "response-body-cancelled"));
          waiting.delete(streamId);
          current.abort?.();
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: INITIAL_RESPONSE_CREDIT }));
      const headers = new Headers(value.headers as Array<[string, string]>);
      if (typeof value.finalUrl === "string") {
        headers.set("x-tabverse-final-url", value.finalUrl);
      }
      current.controller = controller;
      current.settled = true;
      current.resolve(new Response(body, { status, headers }));
      return true;
    }
    if (value.type === "browserResponseChunk") {
      if (Number(value.seq) !== current.expectedSeq || current.controller === undefined) {
        send.cancel(streamId, "response-chunk-gap");
        current.controller?.error(new Error("browser response chunk gap"));
        if (!current.settled) current.reject(new Error("browser response chunk gap"));
        current.abort?.();
        clearTimeout(current.headTimer);
        waiting.delete(streamId);
        return true;
      }
      const bytes = b64ToBytes(String(value.b64));
      current.expectedSeq += 1;
      current.controller.enqueue(bytes);
      current.uncreditedBytes += bytes.byteLength;
      // Credit follows consumption pressure: while the byte-length queue is
      // below its high-water mark it can safely take another chunk; once it
      // fills, pull() alone replenishes the host window.
      if ((current.controller.desiredSize ?? 0) > 0) {
        send.credit(streamId, current.uncreditedBytes);
        current.uncreditedBytes = 0;
      }
      return true;
    }
    waiting.delete(streamId);
    clearTimeout(current.headTimer);
    current.abort?.();
    if (value.type === "browserResponseEnd") {
      current.controller?.close();
      if (!current.settled) current.reject(new Error("browser response ended before its head"));
    } else {
      const error = new Error(`${String(value.code)}: ${String(value.message)}`);
      current.controller?.error(error);
      if (!current.settled) current.reject(error);
    }
    return true;
  }

  function failAll(reason: string): void {
    for (const [streamId, current] of waiting) {
      send.cancel(streamId, "session-ended");
      const error = new Error(reason);
      current.controller?.error(error);
      if (!current.settled) current.reject(error);
      current.abort?.();
      clearTimeout(current.headTimer);
    }
    waiting.clear();
  }

  return { requestViaHost, consume, failAll };
}

/**
 * The proxy ids start far above the rpc channel's counter so the two
 * waiting maps can never both hold the same id: the host echoes whatever
 * id a request rode in on, and one answer frame must find exactly one
 * claimant. Any monotonic range the rpc side cannot reach is correct.
 */
const ID_SEED_START = 2 ** 30;

export function createProxyClient(send: ProxyReqSend): ProxyClient {
  const waiting = new Map<number, Waiting>();
  let seed = ID_SEED_START;

  function requestViaProxy(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    // Request does the merging and the URL validation the platform
    // already promises; the head is built from the normalized result.
    const req = new Request(input, init);
    const build = async (): Promise<Response> => {
      // A GET/HEAD body is the caller's error; the platform already
      // threw for one at Request construction.
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.text();
      const head = buildRequestHead(req, body);
      const id = ++seed;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(
              `proxied fetch of ${new URL(req.url).host} timed out after ${PROXY_TIMEOUT_MS}ms`
            )
          );
        }, PROXY_TIMEOUT_MS);
        waiting.set(id, { timer, resolve, reject });
        send(id, head, body);
      });
    };
    return build();
  }

  function settle(id: number, head: string, body?: string): void {
    const w = waiting.get(id);
    if (w === undefined) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    try {
      w.resolve(responseFrom(head, body));
    } catch (e) {
      // A malformed head is this one request's failure, not the
      // session's.
      w.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function consumeRpcResult(frame: unknown): boolean {
    if (typeof frame !== "object" || frame === null) return false;
    const f = frame as Record<string, unknown>;
    if (f.type !== "rpcResult") return false;
    const w = waiting.get(Number(f.id));
    if (w === undefined) return false;
    waiting.delete(Number(f.id));
    clearTimeout(w.timer);
    w.reject(
      new Error(
        typeof f.err === "string" ? f.err : "the host's proxy request failed"
      )
    );
    return true;
  }

  function failAll(reason: string): void {
    for (const [, w] of waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    waiting.clear();
  }

  return { requestViaProxy, settle, consumeRpcResult, failAll };
}

export function installProxyFetchPatch(
  client: Pick<ProxyClient, "requestViaProxy">,
  href: () => string = () => location.href
): () => void {
  const original = globalThis.fetch;
  const pageOrigin = new URL(href()).origin;
  const patched = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    let url: URL;
    try {
      const raw = input instanceof Request ? input.url : String(input);
      url = new URL(raw, href());
    } catch {
      // An unparseable target was never proxyable; let the platform's
      // own fetch say so.
      return original(input, init);
    }
    if (url.origin !== pageOrigin) return original(input, init);
    const target = targetFromProxyUrl(url);
    return target === null
      ? original(input, init)
      : client.requestViaProxy(target, init);
  };
  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = original;
  };
}
