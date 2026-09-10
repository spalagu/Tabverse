import { describe, expect, it } from "vitest";
import { TAB_TYPES } from "@tabverse/runtime-contracts";
import { desktopRuntime } from "@tabverse/runtime-desktop";
import { remoteRuntime } from "@tabverse/runtime-remote";
import { createTestRuntime } from "@tabverse/test-runtime";
import { TAB_DEFINITIONS, tabDefinitionsForRuntime } from "./tabs";

describe("Workbench tab registry", () => {
  it("covers every runtime contract tab exactly once", () => {
    expect(TAB_DEFINITIONS.map((definition) => definition.type)).toEqual(TAB_TYPES);
    expect(TAB_DEFINITIONS.find((definition) => definition.type === "remote")?.label).toBe(
      "Join remote…"
    );
  });

  it("keeps desktop and Join lists on one capability contract", () => {
    expect(tabDefinitionsForRuntime(desktopRuntime).map((definition) => definition.type)).toEqual(TAB_TYPES);
    expect(tabDefinitionsForRuntime(remoteRuntime).map((definition) => definition.type)).toEqual([
      "terminal",
      "files",
      "browser",
      "agent",
      "settings",
    ]);
  });

  it("removes a tab when its capability is absent", () => {
    const fixture = createTestRuntime(["terminal", "settings"]);
    expect(tabDefinitionsForRuntime(fixture).map((definition) => definition.type)).toEqual([
      "terminal",
      "settings",
    ]);
  });
});
