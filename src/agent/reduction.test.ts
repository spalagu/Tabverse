import { describe, expect, it } from "vitest";
// Loaded as text by the bundler rather than through node:fs, so this suite
// needs no node type definitions to typecheck.
import recorded from "./__fixtures__/synthetic-session.jsonl?raw";
import type { SessionEvent } from "./events";
import { buildTranscript, transcriptText } from "./transcript";

/**
 * The reducer's contract: one event stream, three consumers, one state.
 *
 * The criterion is that what the interface shows, what the log holds, and what
 * a remote viewer is sent all agree. They cannot be compared inside one test
 * — two of them are Rust — so the agreement is pinned instead: this file and
 * `session::tests::the_same_stream_reduces_the_same_way_everywhere` fold the
 * *same* recorded session and assert the *same* numbers. Either side drifting
 * turns one of them red.
 *
 * The fixture is synthetic and public-safe. It retains the reducer event
 * shapes without embedding local paths or user data in the repository.
 */

/** Kept identical to REDUCTION in crates/tabverse-agent/src/session.rs. */
const REDUCTION = {
  events: 19,
  messages: 6,
  turns: 3,
  toolCalls: 2,
  assistantText:
    "I will inspect the sample workspace.I will run a harmless sample command.The sample session is complete.",
  /**
   * Lines in what each tool handed back, in order.
   *
   * Lines rather than length: Rust's String::len counts bytes and JavaScript's
   * .length counts UTF-16 units, so the same text measures differently on the
   * two sides — 221922 against 221888 for the glob output, whose paths are not
   * all ASCII. A cross-language invariant has to be something both languages
   * define the same way.
   */
  toolResultLines: [2, 1],
  /**
   * Every round settled.
   *
   * Worth noting what this proves: the recording predates the loop sending one
   * TurnEnded per answer, so it carries three of them — the old shape. Folding
   * it into three settled rounds is the backward-compatibility defence in
   * buildTranscript doing its job on a real old log, not on a synthetic one.
   */
  turnStates: ["done", "done", "done"],
};

function loadFixture(): { events: SessionEvent[]; messages: number } {
  const events: SessionEvent[] = [];
  let messages = 0;
  for (const line of recorded.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { kind: string; data: unknown };
    if (record.kind === "event") events.push(record.data as SessionEvent);
    else messages += 1;
  }
  return { events, messages };
}

describe("one stream, one state, three consumers", () => {
  const { events, messages } = loadFixture();

  it("reads the recorded session the log actually holds", () => {
    // Guards the fixture itself: if the file were truncated or rewritten, every
    // assertion below would still pass against a different session.
    expect(events).toHaveLength(REDUCTION.events);
    expect(messages).toBe(REDUCTION.messages);
  });

  it("folds to the turns and calls the other side counts", () => {
    const transcript = buildTranscript(events);
    expect(transcript.turns).toHaveLength(REDUCTION.turns);
    expect(transcript.turns.flatMap((t) => t.calls)).toHaveLength(REDUCTION.toolCalls);
  });

  it("settles every round of a finished run", () => {
    // Counting turns is not enough: a fold that never closes a round leaves
    // the same number of them, all claiming to be running, and a viewer would
    // show a finished session as still working. Found by a mutation that the
    // count assertion above let through.
    const states = buildTranscript(events).turns.map((t) => t.state);
    expect(states).toEqual(REDUCTION.turnStates);
  });

  it("assembles the same assistant text", () => {
    // Note what this does *not* check: this recording has one delta per round,
    // so it cannot tell concatenation from last-writer-wins. That property is
    // held by transcript.test.ts ("accumulates streamed text into one message
    // per turn") against a stream built for it. Here the point is that both
    // sides read the same string out of the same file.
    expect(transcriptText(buildTranscript(events)).replace(/\n/g, "")).toBe(
      REDUCTION.assistantText,
    );
  });

  it("carries each tool result through at the size it had", () => {
    // A truncation applied on one side and not the other would show up here:
    // Two lines exercise multi-line output without carrying local paths.
    const results = buildTranscript(events)
      .turns.flatMap((t) => t.calls)
      .map((c) => (c.result ?? "").split("\n").filter((l, i, a) => i < a.length - 1 || l !== "").length);
    expect(results).toEqual(REDUCTION.toolResultLines);
  });

  it("is a fold, so replaying the log twice lands in the same place", () => {
    // What makes a late viewer's catch-up equal the host's state at all.
    expect(buildTranscript(events)).toEqual(buildTranscript(events));
  });
});
