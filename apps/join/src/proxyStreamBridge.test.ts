import { describe, expect, it, vi } from "vitest";
import { relayProxyResponse } from "./proxyStreamBridge";

function messagesUntilEnd(port: MessagePort): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    port.onmessage = (event) => {
      messages.push(event.data);
      if (["end", "error"].includes((event.data as { type: string }).type)) {
        resolve(messages);
      }
    };
  });
}

describe("Service Worker proxy byte stream bridge", () => {
  it("streams method, headers and raw request body into the Host fetch", async () => {
    const channel = new MessageChannel();
    const received = messagesUntilEnd(channel.port2);
    let requestBody: number[] = [];
    const fetchViaHost = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = Array.from(
        new Uint8Array(await new Response(init.body).arrayBuffer()),
      );
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream");
      return new Response(null, { status: 204 });
    });

    const relaying = relayProxyResponse(
      channel.port1,
      "http://host.local/upload",
      fetchViaHost,
      {
        method: "POST",
        headers: [["content-type", "application/octet-stream"]],
        hasBody: true,
      },
    );
    const first = new Uint8Array([0, 1, 255]).buffer;
    const second = new Uint8Array([2, 3]).buffer;
    channel.port2.postMessage({ type: "request-chunk", bytes: first }, [first]);
    channel.port2.postMessage({ type: "request-chunk", bytes: second }, [second]);
    channel.port2.postMessage({ type: "request-end" });
    await relaying;
    await received;

    expect(requestBody).toEqual([0, 1, 255, 2, 3]);
  });

  it("transfers response chunks as raw bytes without whole-body buffering", async () => {
    const channel = new MessageChannel();
    const received = messagesUntilEnd(channel.port2);
    const fetchViaHost = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 255]));
          controller.enqueue(new Uint8Array([2, 3]));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/octet-stream" } },
    ));

    await relayProxyResponse(channel.port1, "http://host.local/file", fetchViaHost);
    const messages = await received as Array<Record<string, unknown>>;

    expect(messages.map((message) => message.type)).toEqual([
      "start", "chunk", "chunk", "end",
    ]);
    expect(Array.from(new Uint8Array(messages[1].bytes as ArrayBuffer))).toEqual([0, 1, 255]);
    expect(Array.from(new Uint8Array(messages[2].bytes as ArrayBuffer))).toEqual([2, 3]);
    expect(JSON.stringify(messages)).not.toContain("bodyB64");
  });

  it("turns a Service Worker cancel message into Host fetch cancellation", async () => {
    const channel = new MessageChannel();
    const received = messagesUntilEnd(channel.port2);
    let signal: AbortSignal | undefined;
    const fetchViaHost = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    const relaying = relayProxyResponse(
      channel.port1,
      "http://host.local/slow",
      fetchViaHost,
    );
    channel.port2.postMessage({ type: "cancel" });
    await relaying;
    const messages = await received as Array<{ type: string; message?: string }>;

    expect(signal?.aborted).toBe(true);
    expect(messages).toEqual([
      { type: "error", message: "The operation was aborted" },
    ]);
  });
});
