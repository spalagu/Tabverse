import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcript } from "./transcript";
import { AgentWorkspacePane } from "./AgentWorkspacePane";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const transcript: Transcript = {
  turns: [
    {
      index: 1,
      prompt: "Update the project",
      text: "",
      thinking: "",
      calls: [
        {
          callId: "call-1",
          name: "write_file",
          input: { path: "/workspace/app.ts" },
          state: "awaiting-permission",
          permission: null,
          progress: "",
          result: null,
          location: null,
        },
      ],
      state: "running",
      error: null,
    },
  ],
  compactions: [],
};

describe("AgentWorkspacePane", () => {
  it("owns the desktop agent transcript, approvals, sign-in and composer UI", () => {
    const onPrompt = vi.fn(() => true);
    const onAnswer = vi.fn();
    const onSignIn = vi.fn();

    act(() => {
      root.render(
        <AgentWorkspacePane
          transcript={transcript}
          title="Agent"
          cwd="/workspace"
          busy={false}
          error={null}
          signIn={{ phase: "signed-out" }}
          onReveal={vi.fn()}
          onCommand={vi.fn()}
          onPrompt={onPrompt}
          onAnswer={onAnswer}
          onStop={vi.fn()}
          onSignIn={onSignIn}
          onSignOut={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("/workspace/app.ts");
    act(() => host.querySelector<HTMLButtonElement>(".agent-approve")?.click());
    expect(onAnswer).toHaveBeenCalledWith("call-1", true);

    const signIn = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Sign in to Codex",
    );
    act(() => signIn?.click());
    expect(onSignIn).toHaveBeenCalledOnce();

    const input = host.querySelector<HTMLTextAreaElement>(".agent-input");
    act(() => {
      if (input === null) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "  ship it  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => host.querySelector<HTMLButtonElement>(".agent-send")?.click());
    expect(onPrompt).toHaveBeenCalledWith("ship it");
    expect(input?.value).toBe("");
  });
});
