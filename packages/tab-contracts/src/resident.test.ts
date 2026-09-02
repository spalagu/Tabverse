import { describe, expect, it } from "vitest";
import {
  effectiveResidentMode,
  type ResidentContribution,
  type ResidentPolicy,
} from "./index";

const continuous: ResidentContribution = {
  capability: "continuous",
  runtimeKind: "fixture",
  descriptor: async () => ({
    pluginId: "tabverse.fixture",
    pluginVersion: "1.0.0",
    artifactHash: "a".repeat(64),
    entrypoint: "fixture-worker",
    permissions: [],
    protocolRange: { min: 1, max: 2 },
    signature: "fixture-signature",
  }),
  initialStateSchema: {
    id: "fixture.initial/v1",
    validate: (_input): _input is unknown => true,
  },
  checkpointSchema: {
    id: "fixture.checkpoint/v1",
    validate: (_input): _input is unknown => true,
  },
};

const stateOnly: ResidentContribution = {
  capability: "state-only",
  runtimeKind: "fixture-state",
};

describe("Resident policy matrix", () => {
  it.each([
    ["on", "inherit", "continuous"],
    ["off", "inherit", "none"],
    ["on", "on", "continuous"],
    ["off", "on", "continuous"],
    ["on", "off", "none"],
    ["off", "off", "none"],
  ] as const)(
    "app=%s tab=%s resolves continuous contribution to %s",
    (appDefault, tab, expected) => {
      const policy: ResidentPolicy = { appDefault, tab };
      expect(effectiveResidentMode(continuous, policy)).toBe(expected);
    },
  );

  it("does not let a policy upgrade state-only or absent capabilities", () => {
    const forced: ResidentPolicy = { appDefault: "on", tab: "on" };
    expect(effectiveResidentMode(stateOnly, forced)).toBe("state-only");
    expect(effectiveResidentMode(undefined, forced)).toBe("none");
  });

  it("resolves a platform descriptor only when a continuous runtime is ensured", async () => {
    await expect(continuous.capability === "continuous"
      ? continuous.descriptor()
      : undefined).resolves.toMatchObject({
      pluginId: "tabverse.fixture",
      protocolRange: { min: 1, max: 2 },
    });
  });
});
