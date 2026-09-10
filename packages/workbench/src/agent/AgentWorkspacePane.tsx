import { useState } from "react";
import type { Transcript } from "./transcript";
import { pendingApprovals } from "./transcript";
import { AgentTranscript, describeInput } from "./AgentTranscript";
import "./agent-view.css";

export type AgentSignInState =
  | { readonly phase: "checking" }
  | { readonly phase: "signed-out" }
  | { readonly phase: "waiting"; readonly url: string }
  | { readonly phase: "failed"; readonly reason: string }
  | { readonly phase: "signed-in" };

export interface AgentWorkspacePaneProps {
  readonly transcript: Transcript;
  readonly title: string;
  readonly cwd: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly signIn: AgentSignInState;
  readonly onReveal: (path: string, line?: number) => void;
  readonly onCommand: (text: string) => void;
  /** Returns true when a live runtime accepted the prompt. */
  readonly onPrompt: (text: string) => boolean;
  readonly onAnswer: (callId: string, allow: boolean) => void;
  readonly onStop: () => void;
  readonly onSignIn: () => void;
  readonly onSignOut: () => void;
}

/** The complete platform-independent UI for an owning Agent tab. */
export function AgentWorkspacePane({
  transcript,
  title,
  cwd,
  busy,
  error,
  signIn,
  onReveal,
  onCommand,
  onPrompt,
  onAnswer,
  onStop,
  onSignIn,
  onSignOut,
}: AgentWorkspacePaneProps) {
  const [draft, setDraft] = useState("");
  const waiting = pendingApprovals(transcript);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (onPrompt(text)) setDraft("");
  };

  return (
    <div className="agent-view">
      <AgentTranscript
        transcript={transcript}
        onReveal={onReveal}
        onCommand={onCommand}
        emptyTitle={title}
        emptyHint={
          <>
            Ask for a change and the agent will work in{" "}
            <span className="agent-empty-cwd">{cwd ?? "…"}</span>. Files it
            touches open in a Files tab; commands it runs open in a Terminal tab.
          </>
        }
      />
      {error && <div className="agent-error">{error}</div>}

      {waiting.length > 0 && (
        <div className="agent-approvals">
          {waiting.map((call) => (
            <div className="agent-approval" key={call.callId}>
              <span className="agent-approval-tool">{call.name}</span>
              <span className="agent-approval-detail">
                {describeInput(call.input)}
              </span>
              <button
                className="agent-approve"
                onClick={() => onAnswer(call.callId, true)}
              >
                Allow
              </button>
              <button
                className="agent-deny"
                onClick={() => onAnswer(call.callId, false)}
              >
                Deny
              </button>
            </div>
          ))}
        </div>
      )}

      {signIn.phase === "waiting" && (
        <div className="agent-signin">
          <span>Signing in — finish in the Browser tab that just opened.</span>
          <a className="agent-signin-code" href={signIn.url}>
            open it again
          </a>
        </div>
      )}
      {(signIn.phase === "signed-out" || signIn.phase === "failed") && (
        <div className="agent-signin">
          <span>
            {signIn.phase === "failed"
              ? signIn.reason
              : "Not signed in — running the built-in demo agent."}
          </span>
          <button className="agent-approve" onClick={onSignIn}>
            Sign in to Codex
          </button>
        </div>
      )}
      {signIn.phase === "signed-in" && (
        <div className="agent-signin">
          <span>Signed in to Codex</span>
          <button className="agent-deny" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
      {cwd && (
        <div className="agent-cwd" title={cwd}>
          {cwd}
        </div>
      )}
      <div className="agent-composer">
        <textarea
          className="agent-input"
          value={draft}
          placeholder="Ask the agent to do something"
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="agent-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="agent-send" onClick={send} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
