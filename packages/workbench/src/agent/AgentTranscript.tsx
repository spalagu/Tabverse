import { Fragment, useEffect, useRef } from "react";
import { deniedReason } from "@tabverse/runtime-contracts";
import type { CallView, Transcript } from "./transcript";

/**
 * The conversation, rendered.
 *
 * Shared by the tab that owns a session and the tab that is watching somebody
 * else's, because a viewer landing on the same screen as the host is the whole
 * point of the transcript being a pure fold of the event list. Anything that
 * differs between the two — who may reply, whether a path can be opened here —
 * is a prop rather than a second copy of this.
 */
export function AgentTranscript({
  transcript,
  onReveal,
  onCommand,
  emptyTitle,
  emptyHint,
}: {
  transcript: Transcript;
  /**
   * What to do when a tool's location is clicked, or null when there is
   * nothing sensible to do. A viewer's paths belong to the host's filesystem:
   * opening them here would show nothing, or — worse — a different file with
   * the same name.
   */
  onReveal: ((path: string, line?: number) => void) | null;
  /**
   * What to do when a call's command is clicked, or null when there is no
   * terminal of ours it could run in. Same nullable pattern as onReveal —
   * threading it as a prop is what lets the join page render this component
   * without the app store existing at all.
   */
  onCommand: ((text: string) => void) | null;
  emptyTitle: string;
  emptyHint: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnCount = transcript.turns.length;
  const lastCallCount = transcript.turns.at(-1)?.calls.length ?? 0;
  const lastTextLength = transcript.turns.at(-1)?.text.length ?? 0;

  // Follow the tail as output arrives, the way a terminal does.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnCount, lastCallCount, lastTextLength]);

  return (
    <div className="agent-transcript" ref={scrollRef}>
      {transcript.turns.length === 0 ? (
        <div className="agent-empty">
          <div className="agent-empty-title">{emptyTitle}</div>
          <div className="agent-empty-hint">{emptyHint}</div>
        </div>
      ) : (
        transcript.turns.map((turn) => (
          <Fragment key={turn.index}>
            {transcript.compactions
              .filter((c) => c.beforeTurn === turn.index)
              .map((c, i) => (
                <div className="agent-compaction" key={i}>
                  History folded to fit the context window — {c.replaced} messages
                  summarised, about {Math.round(c.tokensBefore / 1000)}k tokens down to{" "}
                  {Math.round(c.tokensAfter / 1000)}k
                </div>
              ))}
            <section className="agent-turn" data-state={turn.state}>
              {turn.prompt && <div className="agent-prompt">{turn.prompt}</div>}
              {turn.thinking && (
                <details className="agent-thinking">
                  <summary>Thinking</summary>
                  <pre>{turn.thinking}</pre>
                </details>
              )}
              {turn.text && <div className="agent-text">{turn.text}</div>}
              {turn.calls.map((call) => (
                <ToolCallRow
                  call={call}
                  onReveal={onReveal}
                  onCommand={onCommand}
                  key={call.callId}
                />
              ))}
              {turn.error && <div className="agent-error">{turn.error}</div>}
            </section>
          </Fragment>
        ))
      )}
    </div>
  );
}

function ToolCallRow({
  call,
  onReveal,
  onCommand,
}: {
  call: CallView;
  onReveal: ((path: string, line?: number) => void) | null;
  onCommand: ((text: string) => void) | null;
}) {
  const refusal = call.permission ? deniedReason(call.permission) : null;
  const command = commandOf(call);

  return (
    <div className="agent-call" data-state={call.state}>
      <div className="agent-call-head">
        <span className="agent-call-name">{call.name}</span>
        <span className="agent-call-detail">{describeInput(call.input)}</span>
        {command && onCommand && (
          // Only where a terminal of ours could run it. A viewer's command
          // belongs to the host's machine.
          <button
            className="agent-call-location"
            title="Put this command in a Terminal tab, ready to run"
            onClick={() => onCommand(command)}
          >
            Terminal ↗
          </button>
        )}
        {call.location && onReveal && (
          <button
            className="agent-call-location"
            title="Open in a Files tab"
            onClick={() => onReveal(call.location!.path, call.location!.line ?? undefined)}
          >
            {call.location.path}
            {call.location.line !== null ? `:${call.location.line}` : ""}
          </button>
        )}
        {call.location && !onReveal && (
          // Shown, not clickable: the reader still wants to know which file it
          // was, and a link that opened the wrong one would be worse than none.
          <span className="agent-call-location agent-call-location-plain">
            {call.location.path}
            {call.location.line !== null ? `:${call.location.line}` : ""}
          </span>
        )}
      </div>
      {refusal && <div className="agent-call-refusal">Denied: {refusal}</div>}
      {/* While it runs, the streamed output is all there is. Once it finishes,
          the result supersedes it — it holds the same text plus whatever the
          tool appended, so showing both would print the output twice. */}
      {call.state === "running" && call.progress && (
        <pre className="agent-call-progress">{call.progress}</pre>
      )}
      {call.state !== "running" && call.result && call.state !== "denied" && (
        <pre className="agent-call-result">{call.result}</pre>
      )}
    </div>
  );
}

/** The command a call ran, when it ran one. */
export function commandOf(call: { name: string; input: unknown }): string | null {
  if (call.name !== "bash") return null;
  if (!call.input || typeof call.input !== "object") return null;
  const value = (call.input as Record<string, unknown>).command;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A one-line gloss of what a tool was asked to do. */
export function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "pattern"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}
