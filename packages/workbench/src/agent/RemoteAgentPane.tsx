import { useMemo, useState } from "react";
import type { AgentAccess, SessionEvent } from "@tabverse/runtime-contracts";
import { buildTranscript, isAnswering, pendingApprovals } from "./transcript";
import { describePowers, viewerPowers } from "./viewerPowers";
import { AgentTranscript } from "./AgentTranscript";
import "./agent-view.css";

/**
 * The send side of a shared agent session, or null while not connected.
 *
 * The pane never talks to a transport itself — the desktop wraps the tauri
 * invoke commands, the join page wraps the wasm session. Same nullable
 * pattern as AgentTranscript's onReveal: the prop names what can be done,
 * null says it cannot be done here.
 */
export interface RemoteAgentActions {
  prompt(text: string): void;
  answer(callId: string, allow: boolean): void;
  cancel(): void;
}

export interface RemoteAgentPaneProps {
  events: SessionEvent[];
  access: AgentAccess | null;
  notice: string | null;
  onDismissNotice: () => void;
  actions: RemoteAgentActions | null;
  reconnectAttempt: number;
}

/**
 * A shared agent session, as seen from the other end.
 *
 * The same fold as the host's own pane — that is the point of the transcript
 * being a pure function of the event list, and it is what makes a viewer who
 * joined late land on the state the host is in rather than an approximation of
 * it.
 *
 * What differs is what the viewer may do about it. That comes from the level
 * the host granted, and it decides what is offered, not what is allowed: the
 * host checks every frame, because a disabled button stops only an honest
 * client.
 */
export function RemoteAgentPane({
  events,
  access,
  notice,
  onDismissNotice,
  actions,
  reconnectAttempt,
}: RemoteAgentPaneProps) {
  const [draft, setDraft] = useState("");
  const transcript = useMemo(() => buildTranscript(events), [events]);
  const waiting = pendingApprovals(transcript);
  const busy = isAnswering(transcript);
  const powers = viewerPowers(access);

  const send = () => {
    const text = draft.trim();
    if (!text || !actions || !powers.canSteer) return;
    setDraft("");
    actions.prompt(text);
  };

  const answer = (callId: string, allow: boolean) => {
    if (!actions || !powers.canApprove) return;
    actions.answer(callId, allow);
  };

  const stop = () => {
    if (!actions || !powers.canSteer) return;
    actions.cancel();
  };

  return (
    <div className="agent-view">
      <AgentTranscript
        transcript={transcript}
        // A viewer's tool call does not open a file on this machine: the path
        // belongs to the host's filesystem, and a Files tab here would show
        // either nothing or, worse, a different file with the same name.
        onReveal={null}
        // Same reasoning for commands: they belong to the host's machine, so
        // there is no terminal of ours to put them in.
        onCommand={null}
        emptyTitle="Shared agent"
        emptyHint="Waiting for the host to say something."
      />

      {notice && (
        <div className="agent-approvals">
          <div className="agent-approval">
            <span className="agent-approval-detail">{notice}</span>
            <button className="agent-deny" onClick={onDismissNotice}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="agent-approvals">
          {waiting.map((call) => (
            <div className="agent-approval" key={call.callId}>
              <span className="agent-approval-tool">{call.name}</span>
              <span className="agent-approval-detail">
                {powers.canApprove
                  ? describeInput(call.input)
                  : `${describeInput(call.input)} — waiting on somebody who can approve`}
              </span>
              {powers.canApprove && (
                <>
                  <button
                    className="agent-approve"
                    onClick={() => void answer(call.callId, true)}
                  >
                    Allow
                  </button>
                  <button className="agent-deny" onClick={() => void answer(call.callId, false)}>
                    Deny
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="agent-cwd">
        {describePowers(powers)}
        {reconnectAttempt > 0 && ` · reconnecting (attempt ${reconnectAttempt})…`}
      </div>

      {powers.canSteer ? (
        <div className="agent-composer">
          <textarea
            className="agent-input"
            value={draft}
            placeholder="Say something to the shared agent"
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button className="agent-stop" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button className="agent-send" onClick={() => void send()} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      ) : (
        // No composer at all rather than a disabled one: an input box that
        // cannot be used invites typing into it.
        <div className="agent-composer agent-composer-readonly">
          <span>Watching — the host has not given you a way to reply.</span>
        </div>
      )}
    </div>
  );
}

/** A one-line gloss of what a tool was asked to do. */
function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "pattern"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}
