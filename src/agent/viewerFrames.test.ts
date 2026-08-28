import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./events";
import {
  applyViewerFrame,
  initialViewerAgentState,
  type ViewerAgentState,
  type ViewerFrame,
} from "./viewerFrames";

const text = (delta: string): SessionEvent => ({ type: "assistant_text", delta });

/** Fold a run of frames, the way the component does. */
function fold(frames: ViewerFrame[], from: ViewerAgentState = initialViewerAgentState) {
  return frames.reduce(applyViewerFrame, from);
}

describe("what a viewer makes of the frames it receives", () => {
  it("stays a terminal until a welcome says otherwise", () => {
    // null and empty are different states: one draws xterm, the other draws an
    // empty transcript.
    expect(fold([{ type: "welcome" }]).events).toBeNull();
    expect(fold([{ type: "welcome", tabType: "terminal" }]).events).toBeNull();
    expect(fold([{ type: "welcome", tabType: "agent" }]).events).toEqual([]);
  });

  it("shows an agent share as such before any event arrives", () => {
    // Otherwise the wait is spent looking at an empty terminal.
    const state = fold([{ type: "welcome", tabType: "agent" }]);
    expect(state.events).toEqual([]);
    expect(state.events).not.toBeNull();
  });

  it("appends live events in order", () => {
    const state = fold([
      { type: "welcome", tabType: "agent" },
      { type: "agentEvent", event: text("one") },
      { type: "agentEvent", event: text("two") },
    ]);
    expect(state.events).toEqual([text("one"), text("two")]);
  });

  it("replaces on a snapshot rather than appending it", () => {
    // The failure this exists for: a reconnect delivers the whole run again.
    // Appending would show every earlier turn twice, which reads as the agent
    // having done the work twice.
    const state = fold([
      { type: "agentSnapshot", events: [text("a"), text("b")] },
      { type: "agentEvent", event: text("c") },
      // …connection drops, rejoins, host sends the lot again
      { type: "agentSnapshot", events: [text("a"), text("b"), text("c")] },
    ]);
    expect(state.events).toEqual([text("a"), text("b"), text("c")]);
  });

  it("keeps a live event that arrived before any snapshot", () => {
    const state = fold([{ type: "agentEvent", event: text("early") }]);
    expect(state.events).toEqual([text("early")]);
  });

  it("takes the level from a mode frame that carries one", () => {
    expect(fold([{ type: "mode", readOnly: false, access: "steer" }]).access).toBe("steer");
    expect(fold([{ type: "mode", readOnly: false, access: "approve" }]).access).toBe("approve");
  });

  it("does not let a v1 mode frame demote a viewer that was told its level", () => {
    // A host speaking v1 sends the bit and no level. Clearing `access` on a
    // reconnect would silently take away powers the viewer was granted.
    const state = fold(
      [{ type: "mode", readOnly: false }],
      { ...initialViewerAgentState, access: "approve" },
    );
    expect(state.access).toBe("approve");
  });

  it("says out loud when somebody else answered first", () => {
    const state = fold([
      { type: "agentDecisionTaken", callId: "c1", by: "somebody else" },
    ]);
    expect(state.notice).toContain("somebody else");
    expect(state.notice).toContain("first");
  });

  it("leaves itself alone for frames it does not know", () => {
    // Terminal frames arrive on the same connection, and a frame from a newer
    // host must not disturb what is on screen.
    const before = fold([{ type: "agentSnapshot", events: [text("a")] }]);
    const after = fold(
      [{ type: "output" }, { type: "presence" }, { type: "somethingNew" }],
      before,
    );
    expect(after).toEqual(before);
  });
});
