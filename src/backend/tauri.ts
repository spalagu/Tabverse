import { Channel, invoke } from "@tauri-apps/api/core";
import {
  createTauriTerminal,
  transferPull,
  transferPush,
} from "@tabverse/runtime-desktop/terminal";
import type { SessionEvent } from "../agent/events";
import type { AgentHandle, LoginPoll, LoginStarted, Backend } from "./types";

async function createAgent(opts: { cwd: string; sessionId: string }): Promise<AgentHandle> {
  const cbs = new Set<(e: SessionEvent) => void>();
  // Events can arrive between agent_start resolving and the view subscribing;
  // the terminal path has the same race and solves it the same way.
  const backlog: SessionEvent[] = [];

  const ch = new Channel<SessionEvent>();
  ch.onmessage = (event) => {
    if (cbs.size === 0) backlog.push(event);
    else cbs.forEach((cb) => cb(event));
  };

  // sessionId is the tab's own id: it is what lets a reopened tab find the
  // log it wrote last time.
  const id = await invoke<string>("agent_start", {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    onEvent: ch,
  });

  return {
    id,
    async prompt(text) {
      await invoke("agent_prompt", { id, text });
    },
    async cancel() {
      await invoke("agent_cancel", { id });
    },
    async answer(callId, allow, reason) {
      return await invoke<boolean>("agent_answer", {
        id,
        callId,
        allow,
        reason: reason ?? null,
      });
    },
    async close() {
      await invoke("agent_close", { id });
    },
    onEvent(cb) {
      cbs.add(cb);
      if (backlog.length > 0) {
        const pending = backlog.splice(0, backlog.length);
        pending.forEach((e) => cb(e));
      }
      return () => cbs.delete(cb);
    },
  };
}

export const tauriBackend: Backend = {
  agentLogin: {
    async status() {
      return await invoke<boolean>("agent_login_status");
    },
    async start() {
      return await invoke<LoginStarted>("agent_login_start");
    },
    async poll() {
      return await invoke<LoginPoll>("agent_login_poll");
    },
    async logout() {
      await invoke("agent_logout");
    },
  },

  createAgent,
  kind: "tauri",
  createTerminal: createTauriTerminal,
  homeDir: () => invoke<string>("home_dir"),
  transferPull,
  transferPush,
};
