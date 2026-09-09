export type ProxyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProxyRequestStart {
  method: string;
  headers: [string, string][];
  hasBody: boolean;
}

/** Relay one Host response to the Service Worker without buffering or base64. */
export async function relayProxyResponse(
  port: MessagePort,
  target: string,
  fetchViaHost: ProxyFetch,
  request: ProxyRequestStart = { method: "GET", headers: [], hasBody: false },
): Promise<void> {
  const abort = new AbortController();
  let requestBody: ReadableStreamDefaultController<Uint8Array> | null = null;
  port.onmessage = (message: MessageEvent) => {
    const data = message.data as {
      type?: string;
      bytes?: ArrayBuffer;
      message?: string;
    };
    if (data.type === "cancel") abort.abort();
    else if (data.type === "request-chunk" && data.bytes !== undefined) {
      requestBody?.enqueue(new Uint8Array(data.bytes));
    } else if (data.type === "request-end") requestBody?.close();
    else if (data.type === "request-error") {
      requestBody?.error(new Error(data.message ?? "request body failed"));
    }
  };
  try {
    const body = request.hasBody
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            requestBody = controller;
          },
          cancel() {
            abort.abort();
          },
        })
      : undefined;
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.headers,
      body,
      signal: abort.signal,
    };
    if (body !== undefined) init.duplex = "half";
    const res = await fetchViaHost(target, init);
    port.postMessage({
      type: "start",
      status: res.status,
      statusText: res.statusText,
      headers: Array.from(res.headers.entries()),
    });
    if (res.body !== null) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value.slice().buffer as ArrayBuffer;
        port.postMessage({ type: "chunk", bytes }, [bytes]);
      }
    }
    port.postMessage({ type: "end" });
  } catch (error) {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "proxy failed",
    });
  } finally {
    port.close();
  }
}
