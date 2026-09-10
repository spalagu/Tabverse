import { describe, expect, it, vi } from "vitest";
import { TAB_TYPES, type TabType } from "@tabverse/runtime-contracts";
import {
  defineTabViewRenderers,
  renderWorkbenchTabView,
  type WorkbenchTabViewModel,
} from "./tabView";

interface FixtureTab extends WorkbenchTabViewModel {
  readonly marker: string;
}

describe("Workbench tab view dispatch", () => {
  it("dispatches every contract tab through one exhaustive renderer map", () => {
    const calls: TabType[] = [];
    const renderer = (type: TabType) =>
      vi.fn(({ tab }: { tab: FixtureTab }) => {
        calls.push(type);
        return tab.marker;
      });
    const renderers = defineTabViewRenderers<FixtureTab, null>({
      terminal: renderer("terminal"),
      files: renderer("files"),
      browser: renderer("browser"),
      agent: renderer("agent"),
      remote: renderer("remote"),
      settings: renderer("settings"),
    });

    for (const type of TAB_TYPES) {
      expect(
        renderWorkbenchTabView(
          { id: type, type, title: type, marker: `rendered-${type}` },
          true,
          null,
          renderers,
        ),
      ).toBe(`rendered-${type}`);
    }

    expect(calls).toEqual(TAB_TYPES);
  });
});
