import type { SessionEvent } from "./agent";

export type AgentAccess = "view" | "steer" | "approve";

export type RemoteHostMsgPayload =
  | {
      type: "welcome";
      proto: number;
      tabTitle: string;
      cols: number;
      rows: number;
      tabType?: "terminal" | "agent" | "app";
    }
  | { type: "snapshot"; b64: string; cols: number; rows: number }
  | { type: "output"; b64: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "presence"; viewers: number }
  | { type: "end"; reason: string }
  | { type: "pong" }
  | { type: "agentSnapshot"; events: SessionEvent[] }
  | { type: "agentEvent"; event: SessionEvent }
  | { type: "agentDecisionTaken"; callId: string; by: string };
