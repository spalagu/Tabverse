import { describe, expect, it } from "vitest";
import { MemoryCatalogStore, PluginKernel } from "@tabverse/plugin-kernel";
import type { InstalledPlugin } from "@tabverse/tab-contracts";
import { PluginComposition } from "./index";

function plugin(
  id: string,
  activate: InstalledPlugin["activate"] = () => undefined,
): InstalledPlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [],
      builtIn: true,
      enabledByDefault: true,
    },
    activate,
  };
}

describe("PluginComposition", () => {
  it("bootstraps persisted enabled state without reinstalling", async () => {
    const store = new MemoryCatalogStore();
    let activations = 0;
    const first = new PluginComposition({
      plugins: [plugin("persisted", () => { activations += 1; })],
      store,
    });
    expect((await first.start()).revision).toBe(2);
    await first.dispose();

    const second = new PluginComposition({
      plugins: [plugin("persisted", () => { activations += 1; })],
      store,
    });
    expect((await second.start()).revision).toBe(2);
    expect(activations).toBe(2);
    await second.dispose();
  });

  it("does not undo a persisted explicit disable", async () => {
    const store = new MemoryCatalogStore();
    const descriptor = plugin("disabled");
    const first = new PluginComposition({ plugins: [descriptor], store });
    await first.start();
    await first.dispose();

    const administrator = new PluginKernel({ available: [descriptor], store });
    await administrator.bootstrap();
    await administrator.disable("disabled", {
      commandId: "user.disable:disabled",
      expectedRevision: 2,
    });
    await administrator.dispose();

    const restarted = new PluginComposition({ plugins: [descriptor], store });
    const snapshot = await restarted.start();
    expect(snapshot.plugins.disabled.state).toBe("disabled");
    expect(await restarted.diagnostics()).toMatchObject({ activePlugins: [] });
    await restarted.dispose();
  });

  it("can retry a compensated first-start activation failure", async () => {
    const store = new MemoryCatalogStore();
    let attempts = 0;
    const descriptor = plugin("retryable", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected first activation failure");
    });
    const composition = new PluginComposition({ plugins: [descriptor], store });

    await expect(composition.start()).rejects.toMatchObject({
      code: "ACTIVATION_FAILED",
    });
    expect((await store.load()).plugins.retryable.state).toBe("installed");
    expect((await composition.start()).plugins.retryable.state).toBe("enabled");
    expect(attempts).toBe(2);
    await composition.dispose();
  });
});
