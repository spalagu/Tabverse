export interface LocationView {
  path: string;
  line: number | null;
}

export interface ToolCallView {
  call_id: string;
  name: string;
  input: unknown;
}

export type PermissionOutcome =
  | "allowed_by_rule"
  | "approved"
  | { denied: string };

export type StopReason =
  | "done"
  | "cancelled"
  | "round_limit"
  | { error: string };

export type SessionEvent =
  | { type: "user_prompt"; text: string }
  | { type: "turn_started"; turn: number }
  | { type: "assistant_text"; delta: string }
  | { type: "assistant_thinking"; delta: string }
  | ({ type: "permission_requested" } & ToolCallView)
  | { type: "permission_resolved"; call_id: string; outcome: PermissionOutcome }
  | ({ type: "tool_started" } & ToolCallView)
  | { type: "tool_progress"; call_id: string; chunk: string }
  | {
      type: "tool_finished";
      call_id: string;
      result: string;
      is_error: boolean;
      location: LocationView | null;
    }
  | { type: "turn_ended"; turn: number; reason: StopReason }
  | {
      type: "compacted";
      tokens_before: number;
      tokens_after: number;
      replaced: number;
    };

export function deniedReason(outcome: PermissionOutcome): string | null {
  return typeof outcome === "object" && "denied" in outcome
    ? outcome.denied
    : null;
}

export function stopError(reason: StopReason): string | null {
  return typeof reason === "object" && "error" in reason ? reason.error : null;
}
