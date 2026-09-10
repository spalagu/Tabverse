import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./events";
import {
  buildTranscript,
  isAnswering,
  pendingApprovals,
  transcriptText,
} from "./transcript";

/** The event sequence the Rust loop emits for one allowed tool call. */
function allowedCall(callId: string, name: string): SessionEvent[] {
  return [
    { type: "permission_requested", call_id: callId, name, input: { path: "a.txt" } },
    { type: "permission_resolved", call_id: callId, outcome: "approved" },
    { type: "tool_started", call_id: callId, name, input: { path: "a.txt" } },
    {
      type: "tool_finished",
      call_id: callId,
      result: "file contents",
      is_error: false,
      location: { path: "/w/a.txt", line: 1 },
    },
  ];
}

describe("buildTranscript", () => {
  it("accumulates streamed text into one message per turn", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "assistant_text", delta: "Hel" },
      { type: "assistant_text", delta: "lo " },
      { type: "assistant_text", delta: "there" },
      { type: "turn_ended", turn: 1, reason: "done" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Hello there");
    expect(turns[0].state).toBe("done");
  });

  it("keeps thinking separate from the answer", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "assistant_thinking", delta: "weighing options" },
      { type: "assistant_text", delta: "the answer" },
    ]);
    expect(turns[0].thinking).toBe("weighing options");
    expect(turns[0].text).toBe("the answer");
  });

  it("walks a tool call from request to result", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      ...allowedCall("c1", "read"),
    ]);
    const call = turns[0].calls[0];
    expect(call.name).toBe("read");
    expect(call.state).toBe("done");
    expect(call.result).toBe("file contents");
    expect(call.location).toEqual({ path: "/w/a.txt", line: 1 });
  });

  it("shows a call awaiting a human as pending", () => {
    const transcript = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "permission_requested", call_id: "c1", name: "bash", input: {} },
    ]);
    expect(transcript.turns[0].calls[0].state).toBe("awaiting-permission");
    expect(pendingApprovals(transcript).map((c) => c.callId)).toEqual(["c1"]);
  });

  it("marks a refused call denied and keeps the reason, never showing it as run", () => {
    const transcript = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "permission_requested", call_id: "c1", name: "bash", input: {} },
      {
        type: "permission_resolved",
        call_id: "c1",
        outcome: { denied: "the user said no" },
      },
      {
        type: "tool_finished",
        call_id: "c1",
        result: "Permission denied for `bash`: the user said no",
        is_error: true,
        location: null,
      },
    ]);
    const call = transcript.turns[0].calls[0];
    expect(call.state).toBe("denied");
    expect(call.permission).toEqual({ denied: "the user said no" });
    expect(pendingApprovals(transcript)).toHaveLength(0);
  });

  it("distinguishes a tool that failed from one that was refused", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "tool_started", call_id: "c1", name: "read", input: {} },
      {
        type: "tool_finished",
        call_id: "c1",
        result: "file not found: nope.txt",
        is_error: true,
        location: null,
      },
    ]);
    expect(turns[0].calls[0].state).toBe("failed");
  });

  it("creates the call entry when a rule allowed it without asking", () => {
    // No permission_requested event at all — a rule let it straight through.
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "tool_started", call_id: "c9", name: "grep", input: {} },
    ]);
    expect(turns[0].calls).toHaveLength(1);
    expect(turns[0].calls[0].state).toBe("running");
  });

  it("accumulates progress emitted while a tool runs", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "tool_started", call_id: "c1", name: "bash", input: {} },
      { type: "tool_progress", call_id: "c1", chunk: "line one\n" },
      { type: "tool_progress", call_id: "c1", chunk: "line two\n" },
    ]);
    expect(turns[0].calls[0].progress).toBe("line one\nline two\n");
  });

  it("keeps several calls in one turn in arrival order", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      ...allowedCall("c1", "write"),
      ...allowedCall("c2", "read"),
    ]);
    expect(turns[0].calls.map((c) => c.name)).toEqual(["write", "read"]);
  });

  it("separates turns and carries a failure message", () => {
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "assistant_text", delta: "first" },
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "turn_started", turn: 2 },
      { type: "assistant_text", delta: "second" },
      { type: "turn_ended", turn: 2, reason: { error: "provider exploded" } },
    ]);
    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
    expect(turns[1].state).toBe("failed");
    expect(turns[1].error).toBe("provider exploded");
  });

  it("reports cancellation and the round limit distinctly", () => {
    const cancelled = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "turn_ended", turn: 1, reason: "cancelled" },
    ]);
    expect(cancelled.turns[0].state).toBe("cancelled");

    const capped = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "turn_ended", turn: 1, reason: "round_limit" },
    ]);
    expect(capped.turns[0].state).toBe("round-limit");
  });

  it("does not let a later plain done overwrite a terminal state", () => {
    // The loop emits turn_ended after each tool round as well as at the end.
    const { turns } = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "turn_ended", turn: 1, reason: "round_limit" },
      { type: "turn_ended", turn: 1, reason: "done" },
    ]);
    expect(turns[0].state).toBe("round-limit");
  });

  it("ignores events about a call it never saw start", () => {
    // A viewer that joined mid-run gets exactly this: references to ids whose
    // beginning is not in its slice of the stream. It must render, not throw.
    expect(() =>
      buildTranscript([
        { type: "tool_progress", call_id: "unknown", chunk: "x" },
        {
          type: "tool_finished",
          call_id: "unknown",
          result: "y",
          is_error: false,
          location: null,
        },
        { type: "permission_resolved", call_id: "unknown", outcome: "approved" },
      ]),
    ).not.toThrow();
  });

  it("places text that arrives before any turn_started", () => {
    const { turns } = buildTranscript([{ type: "assistant_text", delta: "orphan" }]);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("orphan");
  });

  it("is a pure fold: replaying the same events gives the same result", () => {
    const events: SessionEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "assistant_text", delta: "hi" },
      ...allowedCall("c1", "read"),
      { type: "turn_ended", turn: 1, reason: "done" },
    ];
    expect(buildTranscript(events)).toEqual(buildTranscript(events));
    // Rebuilding from a prefix then the whole list must not accumulate state.
    buildTranscript(events.slice(0, 2));
    expect(buildTranscript(events)).toEqual(buildTranscript(events));
  });

  it("shows the question above the work it caused, once", () => {
    const { turns } = buildTranscript([
      { type: "user_prompt", text: "what is in hello.txt?" },
      { type: "turn_started", turn: 1 },
      ...allowedCall("c1", "read"),
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "turn_started", turn: 2 },
      { type: "assistant_text", delta: "it says hello" },
      { type: "turn_ended", turn: 2, reason: "done" },
    ]);
    expect(turns[0].prompt).toBe("what is in hello.txt?");
    // Turn two is the same question still being answered, not a new one.
    expect(turns[1].prompt).toBeNull();
  });

  it("keeps each prompt with its own turn across several exchanges", () => {
    const { turns } = buildTranscript([
      { type: "user_prompt", text: "first question" },
      { type: "turn_started", turn: 1 },
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "user_prompt", text: "second question" },
      { type: "turn_started", turn: 2 },
      { type: "turn_ended", turn: 2, reason: "done" },
    ]);
    expect(turns.map((t) => t.prompt)).toEqual(["first question", "second question"]);
  });

  it("joins assistant text across turns for copy and search", () => {
    const transcript = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "assistant_text", delta: "one" },
      { type: "turn_started", turn: 2 },
      { type: "assistant_text", delta: "two" },
    ]);
    expect(transcriptText(transcript)).toBe("one\ntwo");
  });
});

/**
 * The event shape a real run produces: three rounds for one question, the
 * second of them stopping to ask the user about a command.
 *
 * Hand-written sequences were what hid the defect this covers — they never
 * had two rounds, so nothing ever asked what "the turn ended" meant in the
 * middle of an answer.
 */
const realRun: SessionEvent[] = [
  { type: "user_prompt", text: "look around and run something" },
  { type: "turn_started", turn: 1 },
  { type: "assistant_text", delta: "Let me see what is in this folder." },
  { type: "permission_requested", call_id: "demo-1", name: "glob", input: { pattern: "**/*" } },
  { type: "permission_resolved", call_id: "demo-1", outcome: "approved" },
  { type: "tool_started", call_id: "demo-1", name: "glob", input: { pattern: "**/*" } },
  { type: "tool_finished", call_id: "demo-1", result: "a.txt\nb.txt", is_error: false, location: null },
  { type: "turn_started", turn: 2 },
  { type: "assistant_text", delta: "Now I would like to run a command." },
  { type: "permission_requested", call_id: "demo-2", name: "bash", input: { command: "echo hi" } },
  { type: "permission_resolved", call_id: "demo-2", outcome: "approved" },
  { type: "tool_started", call_id: "demo-2", name: "bash", input: { command: "echo hi" } },
  { type: "tool_progress", call_id: "demo-2", chunk: "hi\n" },
  { type: "tool_finished", call_id: "demo-2", result: "hi\n", is_error: false, location: null },
  { type: "turn_started", turn: 3 },
  { type: "assistant_text", delta: "That is everything." },
  { type: "turn_ended", turn: 3, reason: "done" },
];

/** How far the stream had got when the second round stopped to ask. */
const untilApproval = realRun.slice(
  0,
  realRun.findIndex((e) => e.type === "permission_requested" && e.call_id === "demo-2") + 1,
);

describe("whether the agent is still working", () => {
  it("says yes while an approval is waiting on the user", () => {
    // The defect this exists for: the composer showed Send here, so the one
    // moment a user most wants to stop was the moment they could not.
    const transcript = buildTranscript(untilApproval);
    expect(isAnswering(transcript)).toBe(true);
    expect(pendingApprovals(transcript).map((c) => c.callId)).toEqual(["demo-2"]);
  });

  it("says yes between rounds, when one tool has finished and the next has not begun", () => {
    const betweenRounds = realRun.slice(0, realRun.findIndex((e) => e.type === "turn_started" && e.turn === 2));
    expect(isAnswering(buildTranscript(betweenRounds))).toBe(true);
  });

  it("says no once the answer is over", () => {
    expect(isAnswering(buildTranscript(realRun))).toBe(false);
  });

  it("says no before anything has been asked", () => {
    expect(isAnswering(buildTranscript([]))).toBe(false);
  });

  it("says no after a cancelled or failed answer, not just a clean one", () => {
    const cancelled = [...untilApproval, { type: "turn_ended", turn: 2, reason: "cancelled" } as SessionEvent];
    expect(isAnswering(buildTranscript(cancelled))).toBe(false);
    const failed = [
      ...untilApproval,
      { type: "turn_ended", turn: 2, reason: { error: "provider exploded" } } as SessionEvent,
    ];
    expect(isAnswering(buildTranscript(failed))).toBe(false);
  });

  it("still answers correctly for a log written under the old contract", () => {
    // Logs from before the loop stopped announcing every round carry a
    // turn_ended after each one. Replaying them must land in the same place.
    const oldShape: SessionEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "tool_started", call_id: "c1", name: "glob", input: {} },
      { type: "tool_finished", call_id: "c1", result: "x", is_error: false, location: null },
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "turn_started", turn: 2 },
      { type: "permission_requested", call_id: "c2", name: "bash", input: {} },
    ];
    expect(isAnswering(buildTranscript(oldShape))).toBe(true);
  });
});

describe("rounds within one answer", () => {
  it("settles each round when the next one starts", () => {
    const { turns } = buildTranscript(realRun);
    expect(turns.map((t) => t.state)).toEqual(["done", "done", "done"]);
  });

  it("keeps the question above the first round only", () => {
    const { turns } = buildTranscript(realRun);
    expect(turns.map((t) => t.prompt)).toEqual([
      "look around and run something",
      null,
      null,
    ]);
  });

  it("leaves the round in progress marked running", () => {
    const { turns } = buildTranscript(untilApproval);
    expect(turns.map((t) => t.state)).toEqual(["done", "running"]);
  });
});

describe("a folded history", () => {
  it("marks the boundary above the turn that follows it", () => {
    const transcript = buildTranscript([
      { type: "turn_started", turn: 1 },
      { type: "assistant_text", delta: "early work" },
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "compacted", tokens_before: 96000, tokens_after: 12000, replaced: 41 },
      { type: "turn_started", turn: 2 },
      { type: "assistant_text", delta: "carrying on" },
    ]);
    expect(transcript.compactions).toEqual([
      { beforeTurn: 2, tokensBefore: 96000, tokensAfter: 12000, replaced: 41 },
    ]);
    // The turns either side are untouched: compaction changes what the model
    // holds, not what the user already read.
    expect(transcript.turns.map((t) => t.text)).toEqual(["early work", "carrying on"]);
  });

  it("records every fold in a long session, not just the first", () => {
    const transcript = buildTranscript([
      { type: "compacted", tokens_before: 90000, tokens_after: 10000, replaced: 20 },
      { type: "turn_started", turn: 1 },
      { type: "turn_ended", turn: 1, reason: "done" },
      { type: "compacted", tokens_before: 95000, tokens_after: 11000, replaced: 30 },
      { type: "turn_started", turn: 2 },
    ]);
    expect(transcript.compactions.map((c) => c.beforeTurn)).toEqual([1, 2]);
  });

  it("says nothing when nothing was folded", () => {
    expect(buildTranscript([{ type: "turn_started", turn: 1 }]).compactions).toEqual([]);
  });

  it("does not break a viewer that joined after the fold", () => {
    // Someone who joins mid-run sees the notice with no turn before it.
    expect(() =>
      buildTranscript([
        { type: "compacted", tokens_before: 90000, tokens_after: 10000, replaced: 20 },
      ]),
    ).not.toThrow();
  });
});
