/**
 * The v3 frame plumbing an app-level join speaks: multiplexed RPC over the
 * iroh stream, plus the incoming-frame dispatch the mirrored store and the
 * clipboard/proxy owners hang off.
 *
 * SEPARATION. This module knows frames and ids; it knows nothing about React,
 * the store, or what any command does. The wasm seam (`WasmSession`) gained
 * four send methods for the v3 family; here they become one `rpc()` promise
 * per call, answered when the matching `rpcResult` arrives — the same
 * id-correlation shape the desktop world gets from Tauri's invoke, rebuilt
 * on a stream that also carries broadcasts.
 */

/** The v3 host frames this dispatcher consumes (camelCase wire shapes). */
export type AppHostFrame =
  | { type: "rpcResult"; id: number; ok?: unknown; err?: string }
  | { type: "actionApplied"; name: string; args: unknown }
  | { type: "appSnapshot"; state: unknown }
  | { type: "clipSync"; seq: number; text: string }
  | { type: "proxyRes"; id: number; head: string; body?: string }
  | {
      type: "browserResponseHead";
      streamId: number;
      status: number;
      headers: Array<[string, string]>;
      finalUrl: string;
    }
  | { type: "browserResponseChunk"; streamId: number; seq: number; b64: string }
  | { type: "browserResponseEnd"; streamId: number }
  | { type: "browserResponseError"; streamId: number; code: string; message: string }
  | {
      type: "contributionSnapshot";
      tabId: string;
      kind: string;
      epoch: string;
      snapshotRevision: number;
      lastFrameSeq: number;
      state: unknown;
    }
  | {
      type: "contributionFrame";
      tabId: string;
      kind: string;
      epoch: string;
      frameSeq: number;
      payload: unknown;
    }
  | {
      type: "intentResult";
      attachmentId: string;
      attachmentGeneration: number;
      intentId: string;
      ok?: unknown;
      err?: string;
    }
  | {
      type: "privateStream";
      attachmentId: string;
      attachmentGeneration: number;
      streamId: string;
      seq: number;
      fin: boolean;
      payloadB64: string;
    };

/** The frame families this dispatcher can be handed wholesale; non-v3
 * frames pass through untouched (the caller's v1/v2 handling stays). */
export function isAppFrame(frame: { type: string }): frame is AppHostFrame {
  return (
    frame.type === "rpcResult" ||
    frame.type === "actionApplied" ||
    frame.type === "appSnapshot" ||
    frame.type === "clipSync" ||
    frame.type === "proxyRes" ||
    frame.type === "browserResponseHead" ||
    frame.type === "browserResponseChunk" ||
    frame.type === "browserResponseEnd" ||
    frame.type === "browserResponseError" ||
    frame.type === "contributionSnapshot" ||
    frame.type === "contributionFrame" ||
    frame.type === "intentResult" ||
    frame.type === "privateStream"
  );
}

export interface AppFrameSinks {
  onAction(name: string, args: unknown): void;
  onSnapshot(state: unknown): void;
  onClip(seq: number, text: string): void;
  onProxy(id: number, head: string, body?: string): void;
  onContributionSnapshot?(frame: Extract<AppHostFrame, { type: "contributionSnapshot" }>): void;
  onContributionFrame?(frame: Extract<AppHostFrame, { type: "contributionFrame" }>): void;
  onIntentResult?(frame: Extract<AppHostFrame, { type: "intentResult" }>): void;
  onPrivateStream?(frame: Extract<AppHostFrame, { type: "privateStream" }>): void;
}

/** Milliseconds before an rpc() rejects: a host that never answers must
 * surface as an error the UI can show, not a promise that hangs forever. */
export const RPC_TIMEOUT_MS = 15_000;

/** One waiting rpc, its timer, and the reject that answers it. */
interface Waiting {
  timer: ReturnType<typeof setTimeout>;
  settle: (v: { ok?: unknown; err?: string }) => void;
}

/**
 * Drive the v3 family off one live session.
 *
 * `sendRpc` is the wasm seam's method; kept as a parameter so the tests (and
 * any future non-wasm transport) can supply their own. `nextId` starts the
 * correlation ids — the host only echoes them, so any monotonic source is
 * correct; collisions cannot happen within one session because both ends
 * share the sequence.
 */
export function createAppChannel(sendRpc: (id: number, cmd: string, args: unknown) => void) {
  const waiting = new Map<number, Waiting>();

  /** Handle one incoming frame; false when it is not one of ours. */
  function consume(frame: Record<string, unknown>): boolean {
    if (frame.type === "rpcResult") {
      const id = Number(frame.id);
      const w = waiting.get(id);
      if (w !== undefined) {
        waiting.delete(id);
        clearTimeout(w.timer);
        w.settle({ ok: frame.ok, err: frame.err as string | undefined });
      }
      return true;
    }
    return false;
  }

  /** One RPC round trip. Rejection on timeout; error object on host error. */
  function rpc(cmd: string, args: unknown): Promise<unknown> {
    const id = nextId();
    // Executor form: the target is ES2022, before Promise.withResolvers —
    // and the executor here is one timer plus one map entry, not the
    // nested-callback shape the rule exists for.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`rpc ${cmd} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      waiting.set(id, {
        timer,
        settle: (v) => (v.err !== undefined ? reject(new Error(v.err)) : resolve(v.ok)),
      });
      sendRpc(id, cmd, args);
    });
  }

  let idSeed = 0;
  function nextId(): number {
    idSeed += 1;
    return idSeed;
  }

  /** Drop every waiting rpc with an error — the stream ended. */
  function failAll(reason: string): void {
    for (const [, w] of waiting) {
      clearTimeout(w.timer);
      w.settle({ err: reason });
    }
    waiting.clear();
  }

  return { rpc, consume, failAll };
}

/**
 * Split one incoming frame into the sinks. The store mirror hears actions
 * and snapshots; the clipboard owner hears clipSync; the proxy owner hears
 * proxyRes. Frames neither sink claims are ignored here — the terminal
 * families (output/snapshot/...) belong to the tab-level renderers the page
 * already runs.
 */
export function dispatchAppFrame(frame: unknown, sinks: AppFrameSinks): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  switch (f.type) {
    case "actionApplied":
      sinks.onAction(String(f.name), f.args);
      return true;
    case "appSnapshot":
      sinks.onSnapshot(f.state);
      return true;
    case "clipSync":
      sinks.onClip(Number(f.seq), String(f.text));
      return true;
    case "proxyRes":
      sinks.onProxy(Number(f.id), String(f.head), f.body === undefined ? undefined : String(f.body));
      return true;
    case "browserResponseHead":
    case "browserResponseChunk":
    case "browserResponseEnd":
    case "browserResponseError":
      return true;
    case "contributionSnapshot":
      sinks.onContributionSnapshot?.(f as unknown as Extract<AppHostFrame, { type: "contributionSnapshot" }>);
      return true;
    case "contributionFrame":
      sinks.onContributionFrame?.(f as unknown as Extract<AppHostFrame, { type: "contributionFrame" }>);
      return true;
    case "intentResult":
      sinks.onIntentResult?.(f as unknown as Extract<AppHostFrame, { type: "intentResult" }>);
      return true;
    case "privateStream":
      sinks.onPrivateStream?.(f as unknown as Extract<AppHostFrame, { type: "privateStream" }>);
      return true;
    default:
      return false;
  }
}
