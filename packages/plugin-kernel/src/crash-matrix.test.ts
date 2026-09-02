import { describe, expect, it } from "vitest";
import type { InstalledPlugin, PluginState } from "@tabverse/tab-contracts";
import {
  emptyCatalog,
  MemoryCatalogStore,
  PluginKernel,
  SimulatedProcessCrash,
  type CatalogOperation,
  type CatalogPluginRecord,
  type CatalogSnapshot,
} from "./index";

const testPlugin: InstalledPlugin = {
  manifest: {
    id: "matrix",
    version: "1.0.0",
    apiVersion: 1,
    dependencies: [],
    tabs: [],
    builtIn: true,
    enabledByDefault: false,
  },
  activate: async () => ({ dispose: () => undefined }),
};

function record(state: PluginState, failureOperation: CatalogOperation = "enable"): CatalogPluginRecord {
  return {
    manifest: testPlugin.manifest,
    state,
    lastStableState: state === "failed" ? "installed" : state as "installed" | "enabled" | "disabled",
    failure: state === "failed"
      ? { operation: failureOperation, message: "injected failure", atRevision: 1 }
      : undefined,
  };
}

function snapshot(state: "absent" | "installed" | "enabled" | "disabled" | "failed", failureOperation?: CatalogOperation): CatalogSnapshot {
  return {
    ...emptyCatalog(),
    revision: state === "absent" ? 0 : 1,
    plugins: state === "absent" ? {} : { matrix: record(state, failureOperation) },
  };
}

interface Scenario {
  readonly name: string;
  readonly initial: CatalogSnapshot;
  readonly saves: number;
  readonly lastStable: PluginState;
  readonly target: PluginState;
  readonly invoke: (kernel: PluginKernel, revision: number) => Promise<unknown>;
}

const scenarios: readonly Scenario[] = [
  {
    name: "install",
    initial: snapshot("absent"),
    saves: 2,
    lastStable: "not-installed",
    target: "installed",
    invoke: (kernel, revision) => kernel.install(testPlugin, { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "enable",
    initial: snapshot("installed"),
    saves: 3,
    lastStable: "installed",
    target: "enabled",
    invoke: (kernel, revision) => kernel.enable("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "disable",
    initial: snapshot("enabled"),
    saves: 3,
    lastStable: "enabled",
    target: "disabled",
    invoke: (kernel, revision) => kernel.disable("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "uninstall",
    initial: snapshot("disabled"),
    saves: 3,
    lastStable: "disabled",
    target: "not-installed",
    invoke: (kernel, revision) => kernel.uninstall("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "repair",
    initial: snapshot("failed", "enable"),
    saves: 3,
    lastStable: "installed",
    target: "installed",
    invoke: (kernel, revision) => kernel.repair("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "retry",
    initial: snapshot("failed", "enable"),
    saves: 3,
    lastStable: "installed",
    target: "enabled",
    invoke: (kernel, revision) => kernel.retry("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
  {
    name: "controlled-uninstall",
    initial: snapshot("failed", "enable"),
    saves: 3,
    lastStable: "installed",
    target: "not-installed",
    invoke: (kernel, revision) => kernel.controlledUninstall("matrix", { commandId: "matrix-command", expectedRevision: revision }),
  },
];

describe("PluginCatalog persisted crash matrix", () => {
  for (const scenario of scenarios) {
    for (let boundary = 1; boundary <= scenario.saves; boundary += 1) {
      it(`${scenario.name} converges after durable save boundary ${boundary}/${scenario.saves}`, async () => {
        const store = new MemoryCatalogStore(scenario.initial);
        const before = new PluginKernel({ store, available: [testPlugin] });
        if (scenario.initial.plugins.matrix?.state === "enabled") await before.bootstrap();
        store.crashAfterSave(boundary);
        await expect(scenario.invoke(before, scenario.initial.revision)).rejects.toBeInstanceOf(SimulatedProcessCrash);
        await before.dispose();

        const restarted = new PluginKernel({ store, available: [testPlugin] });
        const reconciled = await restarted.bootstrap();
        const expectedState = boundary === scenario.saves ? scenario.target : scenario.lastStable;
        expect(reconciled.journal).toBeUndefined();
        expect(reconciled.commandResults["matrix-command"]).toMatchObject({
          state: expectedState,
          outcome: boundary === scenario.saves ? "committed" : "reconciled",
        });
        expect(reconciled.plugins.matrix?.state ?? "not-installed").toBe(expectedState);
        expect(await restarted.diagnostics()).toMatchObject({
          activePlugins: expectedState === "enabled" ? ["matrix"] : [],
          journal: null,
        });
        await restarted.dispose();
      });
    }
  }
});
