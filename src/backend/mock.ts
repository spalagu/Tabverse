import type { SessionEvent } from "../agent/events";
import { STR } from "../strings";
import { createMockTerminal } from "@tabverse/runtime-desktop/terminal";
import type { AgentAccess, AgentHandle, Backend } from "./types";


/**
 * A fake agent session for browser development, mirroring what the Rust
 * DemoProvider does through the real permission policy: a read-only tool runs
 * without asking, a command is put to the user, and the run then ends. Keeping
 * the two in step matters — this is the path the UI is developed against, so a
 * shape that only exists here would be a shape nobody ever tests for real.
 */
function createMockAgent(opts: { cwd: string; sessionId: string }): Promise<AgentHandle> {
  const cbs = new Set<(e: SessionEvent) => void>();
  const backlog: SessionEvent[] = [];
  let turn = 0;
  let closed = false;

  const emit = (event: SessionEvent) => {
    if (closed) return;
    if (cbs.size === 0) backlog.push(event);
    else cbs.forEach((cb) => cb(event));
  };
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

  // Act two parks here until the user answers, exactly as the Rust gate does.
  let pending: { callId: string } | null = null;

  const actOne = () => {
    turn += 1;
    emit({ type: "turn_started", turn });
    emit({ type: "assistant_text", delta: "Let me see what is in this folder." });
    later(120, () => {
      emit({ type: "tool_started", call_id: "demo-1", name: "glob", input: { pattern: "**/*" } });
      later(160, () => {
        emit({
          type: "tool_finished",
          call_id: "demo-1",
          result: `${opts.cwd}/README.md\n${opts.cwd}/src/main.rs`,
          is_error: false,
          location: { path: `${opts.cwd}/README.md`, line: null },
        });
        emit({ type: "turn_ended", turn, reason: "done" });
        later(120, actTwo);
      });
    });
  };

  const actTwo = () => {
    turn += 1;
    emit({ type: "turn_started", turn });
    emit({ type: "assistant_text", delta: "Now I would like to run a command." });
    later(120, () => {
      pending = { callId: "demo-2" };
      emit({
        type: "permission_requested",
        call_id: "demo-2",
        name: "bash",
        input: { command: "echo hello from the agent" },
      });
    });
  };

  const actThree = () => {
    turn += 1;
    emit({ type: "turn_started", turn });
    emit({ type: "assistant_text", delta: "That is everything for this demo run." });
    emit({ type: "turn_ended", turn, reason: "done" });
  };

  return Promise.resolve({
    id: `mock-${opts.sessionId}`,
    async prompt(text) {
      emit({ type: "user_prompt", text });
      actOne();
    },
    async cancel() {
      emit({ type: "turn_ended", turn, reason: "cancelled" });
      pending = null;
    },
    async answer(callId, allow, reason) {
      if (!pending || pending.callId !== callId) return false;
      pending = null;
      if (!allow) {
        const denial = reason ?? "the user declined";
        emit({ type: "permission_resolved", call_id: callId, outcome: { denied: denial } });
        emit({
          type: "tool_finished",
          call_id: callId,
          result: `Permission denied for \`bash\`: ${denial}`,
          is_error: true,
          location: null,
        });
      } else {
        emit({ type: "permission_resolved", call_id: callId, outcome: "approved" });
        emit({ type: "tool_started", call_id: callId, name: "bash", input: {} });
        emit({ type: "tool_progress", call_id: callId, chunk: "hello from the agent\n" });
        emit({
          type: "tool_finished",
          call_id: callId,
          result: "hello from the agent",
          is_error: false,
          location: null,
        });
      }
      emit({ type: "turn_ended", turn, reason: "done" });
      later(120, actThree);
      return true;
    },
    async close() {
      closed = true;
      cbs.clear();
    },
    onEvent(cb) {
      cbs.add(cb);
      if (backlog.length > 0) backlog.splice(0, backlog.length).forEach((e) => cb(e));
      return () => cbs.delete(cb);
    },
  });
}

/** Demo-only result for the generic share framework. */
export interface MockShareStarted {
  shareId: string;
  ticket: string;
  viewers: { id: number; name: string; access: AgentAccess }[];
}

export function mockShareStart(
  access: AgentAccess,
  levels: readonly AgentAccess[]
): MockShareStarted {
  const ticket = `tabvdemo${"ticketticket".repeat(6)}demo`;
  const other = levels.find((level) => level !== access) ?? access;
  return {
    shareId: `demo-share-${crypto.randomUUID()}`,
    ticket,
    viewers: [
      { id: 1, name: "tabverse@demo-mac", access },
      { id: 2, name: "Safari (web)", access: other },
    ],
  };
}

/** The demo has no provider to sign in to; it is always "signed out". */
let mockSignedIn = false;

export const mockBackend: Backend = {
  agentLogin: {
    async status() {
      return mockSignedIn;
    },
    async start() {
      return {
        url: "https://auth.openai.com/oauth/authorize?client_id=mock&state=mock",
        intervalSecs: 1,
      };
    },
    async poll() {
      // Immediately, because there is nobody to wait for.
      mockSignedIn = true;
      return "ready" as const;
    },
    async logout() {
      mockSignedIn = false;
    },
  },
  createAgent: createMockAgent,
  kind: "mock",
  createTerminal: createMockTerminal,
  homeDir: () => Promise.resolve("/home/demo"),
  transferPull: () =>
    Promise.reject(new Error(STR.term.demoNoTransfer)),
  transferPush: () =>
    Promise.reject(new Error(STR.term.demoNoTransfer)),
};
