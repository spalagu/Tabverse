import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginComposition, type PluginComposition } from "@tabverse/plugin-composition";
import type { InstalledPlugin } from "@tabverse/tab-contracts";
import { PluginCatalogSection } from "./PluginCatalogSection";

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function plugin(): InstalledPlugin {
  return {
    manifest: {
      id: "fixture.optional",
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: ["fixture"],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      context.contributeTab({
        manifest: {
          kind: "fixture",
          version: 1,
          stateVersion: 1,
          presentation: { label: "Fixture", hint: "Fixture", icon: "fixture" },
        },
        view: { render: () => null, requiredServices: [] },
        state: { parse: (input) => input, migrate: (input) => input },
        permissions: [],
        fallback: "placeholder",
      });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function render(composition: PluginComposition): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(PluginCatalogSection, { composition })));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
    void composition.dispose();
  });
  return host;
}

describe("PluginCatalog Settings section", () => {
  it("shows trusted artifacts and explains a structured lifecycle blocker", async () => {
    const composition = createPluginComposition({
      plugins: [plugin()],
      blockers: async () => [{ type: "remote-share", id: "share-1", detail: "tab-1" }],
    });
    const host = render(composition);
    await settle();
    expect(host.textContent).toContain("fixture.optional");
    const disable = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Disable");
    expect(disable).toBeDefined();
    flushSync(() => disable!.click());
    await settle();
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "remote-share / share-1 / tab-1",
    );
    expect((await composition.catalog())[0].state).toBe("enabled");
  });
});
