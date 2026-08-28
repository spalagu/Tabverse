import { describe, expect, it, vi } from "vitest";

/**
 * The registry is module state, so every test rebuilds the module graph:
 * "nothing registered" is a real state of the app (a type nobody declared),
 * not a fixture trick, and the shipped declarations are loaded exactly the
 * way the app bootstrap loads them.
 */

type Capability = typeof import("./capability");

async function freshRegistry(): Promise<Capability> {
  vi.resetModules();
  return await import("./capability");
}

async function shippedRegistry(): Promise<Capability> {
  vi.resetModules();
  await import("../capabilities");
  return await import("./capability");
}

describe("the share capability registry", () => {
  it("answers not-shareable, with a reason, for a type nobody registered", async () => {
    const { shareCapability } = await freshRegistry();
    // Even "terminal": shareable is something a type declares, never
    // something the framework assumes.
    const cap = shareCapability("terminal");
    expect(cap.shareable).toBe(false);
    if (!cap.shareable) expect(cap.reason).toBeTruthy();
  });

  it("hands back a declaration exactly as registered", async () => {
    const { registerShareCapability, shareCapability } = await freshRegistry();
    const declared = {
      shareable: true,
      levels: ["view"],
      defaultLevel: "view",
      payload: "dom",
    } as const;
    registerShareCapability("files", declared);
    expect(shareCapability("files")).toBe(declared);
  });
});

describe("the shipped declarations (src/share/capabilities)", () => {
  it("terminal: view or steer, steering by default, on the built-in grid", async () => {
    const { shareCapability } = await shippedRegistry();
    const cap = shareCapability("terminal");
    expect(cap).toMatchObject({
      shareable: true,
      levels: ["view", "steer"],
      defaultLevel: "steer",
      payload: "grid",
    });
  });

  it("agent: all three levels, with View as the floor", async () => {
    const { shareCapability } = await shippedRegistry();
    const cap = shareCapability("agent");
    expect(cap).toMatchObject({
      shareable: true,
      levels: ["view", "steer", "approve"],
      defaultLevel: "view",
      payload: "dom",
    });
  });

  it("browser, files, settings and remote each declare themselves unshareable", async () => {
    const { shareCapability } = await shippedRegistry();
    for (const type of ["browser", "files", "settings", "remote"] as const) {
      const cap = shareCapability(type);
      expect(cap.shareable, type).toBe(false);
      if (!cap.shareable) expect(cap.reason, type).toBeTruthy();
    }
  });
});
