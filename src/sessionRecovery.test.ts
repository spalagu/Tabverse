import { describe, expect, it, vi } from "vitest";
import { recoverOrInitializeSession } from "./sessionRecovery";

describe("recoverOrInitializeSession", () => {
  it("initializes a fresh run without touching durable session state", async () => {
    const initialize = vi.fn();
    const replace = vi.fn();

    await expect(
      recoverOrInitializeSession({
        fresh: true,
        restore: vi.fn(),
        initialize,
        replace,
        ask: vi.fn(),
      })
    ).resolves.toBe("initialized");

    expect(initialize).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("creates a default session automatically only when no session exists", async () => {
    const initialize = vi.fn();
    const ask = vi.fn();

    await expect(
      recoverOrInitializeSession({
        fresh: false,
        restore: async () => "missing",
        initialize,
        replace: vi.fn(),
        ask,
      })
    ).resolves.toBe("initialized");

    expect(initialize).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    "read-failed",
    "invalid-json",
    "unsupported-version",
    "invalid-shape",
    "empty-tabs",
  ] as const)("preserves a %s session when replacement is declined", async (reason) => {
    const initialize = vi.fn();
    const ask = vi.fn(async () => false);

    await expect(
      recoverOrInitializeSession({
        fresh: false,
        restore: async () => reason,
        initialize,
        replace: vi.fn(),
        ask,
      })
    ).resolves.toBe("preserved");

    expect(initialize).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith(reason);
  });

  it("initializes an existing invalid session only after explicit consent", async () => {
    const initialize = vi.fn();
    const replace = vi.fn();
    await expect(
      recoverOrInitializeSession({
        fresh: false,
        restore: async () => "invalid-json",
        initialize,
        replace,
        ask: async () => true,
      })
    ).resolves.toBe("initialized");
    expect(initialize).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
  });
});
