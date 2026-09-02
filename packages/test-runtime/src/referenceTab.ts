import type { InstalledPlugin } from "@tabverse/tab-contracts";

export const REFERENCE_TAB_KIND = "fixture.reference";
export const REFERENCE_PLUGIN_ID = "tabverse.test.reference";

export interface ReferenceTabState {
  readonly message: string;
  readonly count: number;
}

export interface ReferencePluginProbe {
  pluginActivations: number;
  pluginDisposals: number;
  instanceActivations: number;
  instanceDisposals: number;
  commandRuns: number;
}

function parseReferenceState(input: unknown): ReferenceTabState {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as { message?: unknown }).message !== "string" ||
    !Number.isSafeInteger((input as { count?: unknown }).count)
  ) {
    throw new Error("invalid reference tab state");
  }
  return input as ReferenceTabState;
}

/** Full-surface test plugin. It is never included in a production catalog. */
export function createReferenceTabPlugin(
  probe: ReferencePluginProbe,
): InstalledPlugin {
  const remoteStates = new Map<string, ReferenceTabState>();
  return {
    manifest: {
      id: REFERENCE_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [REFERENCE_TAB_KIND],
      builtIn: false,
      enabledByDefault: true,
    },
    activate(context) {
      probe.pluginActivations += 1;
      context.defer(() => {
        probe.pluginDisposals += 1;
      });
      context.contributeTab<ReferenceTabState>({
        manifest: {
          kind: REFERENCE_TAB_KIND,
          version: 1,
          stateVersion: 1,
          presentation: {
            label: "Reference",
            hint: "Reference contribution",
            icon: "reference",
          },
        },
        view: {
          requiredServices: [],
          render: ({ tabId, state, active }) => {
            remoteStates.set(tabId, state);
            return {
              component: "ReferenceTab",
              tabId,
              state,
              active,
            };
          },
        },
        state: {
          parse: parseReferenceState,
          migrate: (input, from) => {
            if (from === 0 && typeof input === "string") {
              return { message: input, count: 0 };
            }
            return parseReferenceState(input);
          },
        },
        commands: [
          {
            id: "fixture.reference.increment",
            title: "Increment reference count",
            run: (_tabId, input) => {
              probe.commandRuns += 1;
              const state = parseReferenceState(input);
              return { ...state, count: state.count + 1 };
            },
          },
        ],
        remote: {
          protocol: {
            name: "fixture-reference",
            minVersion: 1,
            maxVersion: 1,
          },
          state: {
            snapshot: (tabId) => {
              const state = remoteStates.get(tabId);
              if (state === undefined) throw new Error(`unknown reference tab: ${tabId}`);
              return {
                epoch: `reference:${tabId}`,
                snapshotRevision: 1n,
                lastFrameSeq: 0n,
                state,
              };
            },
            subscribe: () => ({ dispose: () => {} }),
          },
          client: {
            fold: (state) => state,
            render: ({ tabId, state, active }) => ({
              component: "ReferenceTab",
              tabId,
              state,
              active,
            }),
          },
          intents: [
            {
              name: "fixture.reference.increment",
              schema: {
                id: "fixture.reference.increment/v1",
                validate: (input): input is { readonly amount: number } =>
                  typeof input === "object" &&
                  input !== null &&
                  Number.isSafeInteger((input as { amount?: unknown }).amount),
              },
              minAccess: "steer",
              idempotent: false,
            },
          ],
          privateStreams: {
            streams: [{ name: "fixture.private", minAccess: "view" }],
          },
          fallback: "read-only",
        },
        resident: {
          capability: "state-only",
          runtimeKind: "fixture-reference",
        },
        permissions: [
          { capability: "fixture.read", reason: "Exercise permission metadata" },
        ],
        fallback: "read-only",
        activate(instance) {
          probe.instanceActivations += 1;
          instance.defer(() => {
            probe.instanceDisposals += 1;
          });
        },
      });
    },
  };
}
