import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sharing an agent tab, exercised through the unified framework — the same
 * startShare/stopShare path a terminal takes, gated by the capability the
 * agent type declares. The per-handle share seam this file used to test
 * (AgentHandle.share / stopShare over the retired agent-only commands) is
 * gone; what can be held now is the contract that replaced it: view is the
 * default, every level is a deliberate request, the command speaks the tab
 * id, and share state lives on tab.share in the one unified shape.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

async function fresh() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  await import("../share/capabilities");
  const { useStore } = await import("../state/store");
  const actions = await import("../share/framework/actions");
  useStore.setState({ tabs: [], activeTabId: null });
  return { useStore, actions };
}

/** The share_start calls made so far, ignoring persistence traffic. */
function shareStartCalls() {
  return mocks.invoke.mock.calls.filter(([cmd]) => cmd === "share_start");
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "share_start")
      return { shareId: "share-agent-1", ticket: "tabv-agent" };
    return undefined;
  });
});

describe("sharing an agent tab through the unified framework", () => {
  it("starts at the declared floor — view — when nobody chose a level", async () => {
    // Watching is the default favour; driving and approving each have to be
    // asked for by name. Nothing here may quietly upgrade one into the other.
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "agent" });
    await actions.startShare(id);
    expect(shareStartCalls()).toHaveLength(1);
    const [, args] = shareStartCalls()[0];
    expect(args).toMatchObject({ tabId: id, access: "view" });
  });

  it("carries a deliberately chosen level through to the command", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "agent" });
    await actions.startShare(id, { access: "approve" });
    const [, args] = shareStartCalls()[0];
    expect(args).toMatchObject({ tabId: id, access: "approve" });
  });

  it("stores the unified share state on tab.share, exactly as a terminal does", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "agent" });
    await actions.startShare(id, { access: "steer" });
    const share = useStore.getState().tabs.find((t) => t.id === id)?.share;
    expect(share).toMatchObject({
      shareId: "share-agent-1",
      ticket: "tabv-agent",
      access: "steer",
      viewers: [],
      ttlSecs: actions.SHARE_TTL_SECS,
    });
  });

  it("stopShare ends the share by tab id and clears tab.share", async () => {
    const { useStore, actions } = await fresh();
    const id = useStore.getState().addTab({ type: "agent" });
    await actions.startShare(id);
    await actions.stopShare(id);
    expect(
      mocks.invoke.mock.calls.some(
        ([cmd, args]) =>
          cmd === "share_stop" && (args as { tabId: string }).tabId === id
      )
    ).toBe(true);
    expect(useStore.getState().tabs.find((t) => t.id === id)?.share).toBe(
      undefined
    );
  });
});
