
import type {
  LocationView,
  PermissionOutcome,
  SessionEvent,
  StopReason,
} from "@tabverse/runtime-contracts";
import { deniedReason } from "@tabverse/runtime-contracts";

export type CallState =
  | "awaiting-permission"
  | "denied"
  | "running"
  | "done"
  | "failed";

export interface CallView {
  callId: string;
  name: string;
  input: unknown;
  state: CallState;
  /** Set once permission resolves; a refusal keeps its reason for display. */
  permission: PermissionOutcome | null;
  /** Output streamed while the tool was still running. */
  progress: string;
  /** What went back to the model. */
  result: string | null;
  location: LocationView | null;
}

export type TurnState = "running" | "done" | "cancelled" | "round-limit" | "failed";

export interface TurnView {
  index: number;
  /** What the user asked, when this turn answers a fresh prompt. */
  prompt: string | null;
  text: string;
  thinking: string;
  calls: CallView[];
  state: TurnState;
  /** Present when the turn ended in failure. */
  error: string | null;
}

/** A point where the history behind it was folded into a summary. */
export interface CompactionNote {
  /** The turn it sits above. */
  beforeTurn: number;
  tokensBefore: number;
  tokensAfter: number;
  replaced: number;
}

export interface Transcript {
  turns: TurnView[];
  /** Rendered as a line across the transcript: below it the model still has
      every detail, above it only a summary. The user has to be able to see
      where that boundary falls. */
  compactions: CompactionNote[];
}

function turnStateFrom(reason: StopReason): TurnState {
  if (typeof reason === "object") return "failed";
  if (reason === "cancelled") return "cancelled";
  if (reason === "round_limit") return "round-limit";
  return "done";
}

/** Fold a whole event list. Safe to call again from scratch on every change. */
export function buildTranscript(events: SessionEvent[]): Transcript {
  const turns: TurnView[] = [];
  const compactions: CompactionNote[] = [];
  // Held until the turn it belongs to starts, so the question renders above the
  // work it caused rather than as a stray entry.
  let pendingPrompt: string | null = null;
  // Calls are addressed by id across turns, so keep one index rather than
  // searching the nested structure for every event.
  const callIndex = new Map<string, CallView>();

  const currentTurn = (): TurnView | undefined => turns[turns.length - 1];

  const ensureTurn = (): TurnView => {
    const existing = currentTurn();
    if (existing) return existing;
    // Text before any turn_started still has to land somewhere.
    const implicit: TurnView = {
      index: turns.length + 1,
      prompt: pendingPrompt,
      text: "",
      thinking: "",
      calls: [],
      state: "running",
      error: null,
    };
    turns.push(implicit);
    return implicit;
  };

  for (const event of events) {
    switch (event.type) {
      case "user_prompt": {
        pendingPrompt = event.text;
        break;
      }
      case "turn_started": {
        // A new round starting is what closes the one before it. The loop no
        // longer claims a round is "done" when it is about to ask the model
        // again, so the previous entry is settled here rather than by an event.
        const previous = currentTurn();
        if (previous && previous.state === "running") previous.state = "done";
        turns.push({
          index: event.turn,
          prompt: pendingPrompt,
          text: "",
          thinking: "",
          calls: [],
          state: "running",
          error: null,
        });
        // Only the first turn of a prompt carries it; the tool rounds that
        // follow are the same question still being answered.
        pendingPrompt = null;
        break;
      }
      case "assistant_text": {
        ensureTurn().text += event.delta;
        break;
      }
      case "assistant_thinking": {
        ensureTurn().thinking += event.delta;
        break;
      }
      case "permission_requested": {
        const call: CallView = {
          callId: event.call_id,
          name: event.name,
          input: event.input,
          state: "awaiting-permission",
          permission: null,
          progress: "",
          result: null,
          location: null,
        };
        callIndex.set(call.callId, call);
        ensureTurn().calls.push(call);
        break;
      }
      case "permission_resolved": {
        const call = callIndex.get(event.call_id);
        if (!call) break;
        call.permission = event.outcome;
        if (deniedReason(event.outcome) !== null) call.state = "denied";
        break;
      }
      case "tool_started": {
        // A tool can start without a permission event when a rule allowed it
        // silently, so this has to be able to create the entry too.
        let call = callIndex.get(event.call_id);
        if (!call) {
          call = {
            callId: event.call_id,
            name: event.name,
            input: event.input,
            state: "running",
            permission: null,
            progress: "",
            result: null,
            location: null,
          };
          callIndex.set(call.callId, call);
          ensureTurn().calls.push(call);
        } else {
          call.state = "running";
        }
        break;
      }
      case "tool_progress": {
        const call = callIndex.get(event.call_id);
        if (call) call.progress += event.chunk;
        break;
      }
      case "tool_finished": {
        const call = callIndex.get(event.call_id);
        if (!call) break;
        call.result = event.result;
        call.location = event.location;
        // A denial already finished this call; do not relabel it as a plain
        // failure, the distinction is what the UI shows differently.
        if (call.state !== "denied") {
          call.state = event.is_error ? "failed" : "done";
        }
        break;
      }
      case "compacted": {
        compactions.push({
          beforeTurn: turns.length + 1,
          tokensBefore: event.tokens_before,
          tokensAfter: event.tokens_after,
          replaced: event.replaced,
        });
        break;
      }
      case "turn_ended": {
        const turn = currentTurn();
        if (!turn) break;
        // The loop now sends one of these per answer, but logs written before
        // that change have one after every tool round, and replaying those has
        // to land in the same place. Hence: a terminal state already set is
        // never overwritten by a later plain "done".
        const next = turnStateFrom(event.reason);
        if (turn.state === "running" || next !== "done") {
          turn.state = next;
        }
        if (typeof event.reason === "object") turn.error = event.reason.error;
        break;
      }
    }
  }

  return { turns, compactions };
}

/** Everything the assistant said across the run, for copying or search. */
export function transcriptText(transcript: Transcript): string {
  return transcript.turns
    .map((t) => t.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Is the agent still working on the last thing it was asked?
 *
 * Derived from the stream rather than tracked alongside it. A component that
 * kept its own flag had to guess what each event meant, and got it wrong: it
 * cleared on every TurnEnded back when the loop sent one after each tool
 * round, so the stop button turned back into send while an approval was still
 * waiting on the user. There is no second copy of this fact to drift.
 */
export function isAnswering(transcript: Transcript): boolean {
  const last = transcript.turns[transcript.turns.length - 1];
  return last !== undefined && last.state === "running";
}

/** Calls still waiting on a human. The composer shows these first. */
export function pendingApprovals(transcript: Transcript): CallView[] {
  return transcript.turns
    .flatMap((t) => t.calls)
    .filter((c) => c.state === "awaiting-permission");
}
