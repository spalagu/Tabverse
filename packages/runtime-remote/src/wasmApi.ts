/**
 * The boundary between the remote runtime and the WebAssembly iroh client.
 *
 * Everything the page knows about the wasm module is this shape — which is
 * what lets the tests drive the page with a plain object, and what lets the
 * two builds load the module differently (fetched by hash on the Pages site,
 * base64-inlined in the single-file artifact) behind one seam.
 */

/** A live connection, as `joinShare` resolves it (a `WebJoin` in Rust). */
export interface WasmSession {
  /** Keyboard/paste bytes for the host's shell (base64 of UTF-8 bytes). */
  sendInput(b64: string): void;
  /** Liveness probe; the host answers with a pong frame. */
  ping(): void;
  /** What this viewer could display, measured at the base font. */
  viewport(cols: number, rows: number): void;
  /** Close the connection (best-effort; the page may be navigating away). */
  leave(): void;
  /** Say something to a shared agent. Host-enforced Steer. */
  sendPrompt(text: string): void;
  /** Answer an agent permission request. Host-enforced Approve. */
  sendAnswer(callId: string, allow: boolean, reason?: string): void;
  /** Stop the agent turn in progress. Host-enforced Steer. */
  sendCancel(): void;
  /** A store action for the host to execute (app share). Steer-gated on
   * the host; the confirmation comes back as an actionApplied broadcast. */
  sendAction(name: string, args: unknown): void;
  /** Clipboard text produced inside the page (app share). Steer-gated on
   * the host, which writes it onto its own pasteboard — the same board
   * the watcher then echoes to every viewer. */
  sendClipPush(text: string): void;
  sendRpc(id: bigint, cmd: string, args: unknown): void;
  sendProxyReq(id: bigint, head: string, body?: string): void;
}

export interface WasmApi {
  joinShare(
    ticket: string,
    clientName: string,
    onEvent: (json: string) => void
  ): Promise<WasmSession>;
}

declare global {
  interface Window {
    /** Installed by the single-file build's injected loader
     * (tools/build-join-page.mjs); absent on the Pages build. */
    __tabverseWasm?: () => Promise<WasmApi>;
  }
}
