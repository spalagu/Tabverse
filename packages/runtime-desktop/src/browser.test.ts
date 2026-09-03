import { describe, expect, it } from "vitest";
import type { BrowserEventEnvelope } from "@tabverse/tab-browser";
import { createTauriBrowserSessionPort } from "./browser";

describe("Tauri BrowserSessionPort", () => {
  it("keeps generation and surface revision on every native command for 100 lifecycles", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    let generation = 0;
    const invoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (command === "browser_session_ensure") {
        generation += 1;
        return {
          tabId: args?.tabId,
          sessionGeneration: generation,
          engine: "cef",
        } as T;
      }
      if (command === "browser_session_command") return { ok: true } as T;
      return undefined as T;
    };
    const port = createTauriBrowserSessionPort(invoke, async () => () => {});

    for (let index = 1; index <= 100; index += 1) {
      const handle = await port.ensureSession({
        tabId: "browser-a",
        profileId: "default",
        initialUrl: "https://example.test/",
        network: { kind: "system" },
        privateMode: false,
      });
      expect(handle.sessionGeneration).toBe(BigInt(index));
      await port.attachSurface("browser-a", {
        slotId: "slot-a",
        slotRevision: BigInt(index),
        ownerWindowId: "main",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      });
      expect(await port.command("browser-a", { type: "reload" })).toEqual({
        ok: true,
      });
      await port.closeSession("browser-a", "tab-close");
    }

    expect(port.engine).toBe("cef");
    const creates = calls.filter(({ command }) => command === "browser_create");
    const closes = calls.filter(({ command }) => command === "browser_close");
    expect(creates).toHaveLength(100);
    expect(closes).toHaveLength(100);
    expect(creates[99]?.args).toMatchObject({
      generation: 100,
      slotRevision: 100,
    });
    expect(closes[99]?.args).toMatchObject({
      generation: 100,
      reason: "tab-close",
    });
  });

  it("converts native event counters to bigint and disposes the listener", async () => {
    let sink: ((event: { payload: unknown }) => void) | undefined;
    let unlistened = false;
    const port = createTauriBrowserSessionPort(
      async <T>() => ({ ok: true }) as T,
      async <T>(_name: string, handler: (event: { payload: T }) => void) => {
        sink = handler as (event: { payload: unknown }) => void;
        return () => {
          unlistened = true;
        };
      },
    );
    const events: BrowserEventEnvelope[] = [];
    const subscription = port.subscribe("browser-a", (event) =>
      events.push(event),
    );
    sink?.({
      payload: {
        tabId: "browser-a",
        sessionGeneration: 9,
        eventSeq: 4,
        event: { type: "session-ready" },
      },
    });
    expect(events[0]).toMatchObject({ sessionGeneration: 9n, eventSeq: 4n });
    await subscription.dispose();
    expect(unlistened).toBe(true);
  });
});
