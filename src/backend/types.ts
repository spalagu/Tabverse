import type { SessionEvent } from "@tabverse/runtime-contracts";
import type {
  CreateTermOpts,
  TermHandle,
} from "@tabverse/runtime-desktop/terminal";

export { type AgentAccess, type RemoteHostMsgPayload } from "@tabverse/runtime-contracts";
export type {
  CreateTermOpts,
  TermEventPayload,
  TermHandle,
} from "@tabverse/runtime-desktop/terminal";

/**
 * Backend abstraction: the same UI runs against
 *  - the Tauri desktop core (real PTYs),
 *  - a mock (plain-browser development),
 *  - and later an iroh wasm client (browser remote control).
 */
/** One agent session, owned by one agent tab. */
export interface AgentHandle {
  readonly id: string;
  /** Send a user turn. Resolves once accepted, not once answered. */
  prompt(text: string): Promise<void>;
  /** Stop the run; a turn parked on an approval is released too. */
  cancel(): Promise<void>;
  /** Answer a pending approval. False means nothing was waiting on that call. */
  answer(callId: string, allow: boolean, reason?: string): Promise<boolean>;
  close(): Promise<void>;
  /** Subscribe to session events; returns an unsubscribe fn. Events produced
   * before the first subscriber are replayed on subscription. */
  onEvent(cb: (event: SessionEvent) => void): () => void;
}

/** What one poll of a sign-in came back with. */
export type LoginPoll = "pending" | "slow_down" | "ready";

export interface LoginStarted {
  /** Where to send the browser. Opened in a Browser tab of ours. */
  url: string;
  intervalSecs: number;
}

/** Signing in to the agent's provider. Global, not per tab. */
export interface AgentLogin {
  status(): Promise<boolean>;
  start(): Promise<LoginStarted>;
  /** One poll. `pending` is the ordinary answer while the user is busy.
   *  Takes nothing: the host is holding the one sign-in that is in flight,
   *  along with the verifier, which must never reach the interface. */
  poll(): Promise<LoginPoll>;
  logout(): Promise<void>;
}

export interface Backend {
  agentLogin: AgentLogin;
  readonly kind: "tauri" | "mock" | "remote";
  createTerminal(opts: CreateTermOpts): Promise<TermHandle>;
  createAgent(opts: { cwd: string; sessionId: string }): Promise<AgentHandle>;
  homeDir(): Promise<string>;
  transferPull(host: string, remotePath: string): Promise<string>;
  transferPush(
    host: string,
    dir: string,
    name: string,
    dataB64: string
  ): Promise<void>;
}
