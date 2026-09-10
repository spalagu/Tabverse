/**
 * Folding the frames a viewer receives into the state its pane renders.
 *
 * Pulled out of the component because two of these rules are the kind that
 * look obviously right and are obviously wrong the first time a connection
 * drops — and neither is reachable from a test while it lives inside a switch
 * in a 370-line xterm component.
 */

import type { AgentAccess, SessionEvent } from "@tabverse/runtime-contracts";

/** What a viewer knows about the session it is watching. */
export interface ViewerAgentState {
  /**
   * The events so far, or null when this is not an agent share at all.
   *
   * Null and empty are different: null means "a terminal, draw xterm", empty
   * means "an agent that has not said anything yet, draw an empty transcript".
   */
  events: SessionEvent[] | null;
  access: AgentAccess | null;
  /** Something to tell the viewer once, such as losing an approval race. */
  notice: string | null;
}

export const initialViewerAgentState: ViewerAgentState = {
  events: null,
  access: null,
  notice: null,
};

/** The frames this fold understands. Everything else leaves it unchanged. */
export type ViewerFrame =
  | { type: "welcome"; tabType?: "terminal" | "agent" }
  | { type: "mode"; readOnly: boolean; access?: AgentAccess }
  | { type: "agentSnapshot"; events: SessionEvent[] }
  | { type: "agentEvent"; event: SessionEvent }
  | { type: "agentDecisionTaken"; callId: string; by: string }
  | { type: string };

export function applyViewerFrame(
  state: ViewerAgentState,
  frame: ViewerFrame,
): ViewerAgentState {
  switch (frame.type) {
    case "welcome": {
      const welcome = frame as { tabType?: "terminal" | "agent" };
      // Marks this as an agent share before any event arrives, so the pane
      // does not spend the wait showing an empty terminal.
      if (welcome.tabType === "agent" && state.events === null) {
        return { ...state, events: [] };
      }
      return state;
    }
    case "mode": {
      const mode = frame as { access?: AgentAccess };
      // A v1 host sends only the read-only bit and no level. Leaving `access`
      // as it was — rather than clearing it — matters on a reconnect, where a
      // frame without the field must not silently demote the viewer.
      return mode.access ? { ...state, access: mode.access } : state;
    }
    case "agentSnapshot": {
      const snapshot = frame as { events: SessionEvent[] };
      // Replaces, never appends. A reconnect delivers the whole run again, and
      // appending would show every earlier turn twice — which reads as the
      // agent having done the work twice.
      return { ...state, events: snapshot.events };
    }
    case "agentEvent": {
      const live = frame as { event: SessionEvent };
      // An event arriving before any snapshot still has to land somewhere.
      return { ...state, events: [...(state.events ?? []), live.event] };
    }
    case "agentDecisionTaken": {
      const taken = frame as { by: string };
      // Said out loud. A button that silently does nothing cannot be told from
      // a broken one.
      return { ...state, notice: `${taken.by} answered that request first` };
    }
    default:
      return state;
  }
}
