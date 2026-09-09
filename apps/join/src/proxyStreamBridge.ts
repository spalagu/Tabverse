export type ProxyFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Relay one Host response to the Service Worker without buffering or base64. */
export async function relayProxyResponse(
  port: MessagePort,
  target: string,
  fetchViaHost: ProxyFetch,
): Promise<void> {
  const abort = new AbortController();
  port.onmessage = (message: MessageEvent) => {
    if ((message.data as { type?: string })?.type === "cancel") abort.abort();
  };
  try {
    const res = await fetchViaHost(target, { signal: abort.signal });
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
