import {
  serviceToken,
  type InstalledPlugin,
  type TabRendererArgs,
} from "@tabverse/tab-contracts";

export const SETTINGS_PLUGIN_ID = "tabverse.tab.settings";
export const SETTINGS_KIND = "settings";
export const SETTINGS_STATE_VERSION = 1;

export interface SettingsTabState extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly section?: string;
}

export interface SettingsTabViewRequest extends TabRendererArgs<SettingsTabState> {
  readonly runtimeKind: "desktop" | "test";
  readonly kind: typeof SETTINGS_KIND;
}

export interface SettingsRuntimeService {
  readonly runtimeKind: SettingsTabViewRequest["runtimeKind"];
  render(args: TabRendererArgs<SettingsTabState>): unknown;
}

export const SETTINGS_RUNTIME_SERVICE = serviceToken<SettingsRuntimeService>(
  "tabverse.settings.runtime.v1",
);

export function createSettingsRuntimePlugin(options: {
  readonly id: string;
  readonly service: SettingsRuntimeService;
}): InstalledPlugin {
  return {
    manifest: {
      id: options.id,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [],
      tabs: [],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      context.provide(SETTINGS_RUNTIME_SERVICE, options.service);
    },
  };
}

function parseState(input: unknown): SettingsTabState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("settings state must be an object");
  }
  return input as SettingsTabState;
}

/** Local-only by construction: no remote or resident contribution exists. */
export function createSettingsPlugin(options: {
  readonly runtimePluginId: string;
}): InstalledPlugin {
  return {
    manifest: {
      id: SETTINGS_PLUGIN_ID,
      version: "1.0.0",
      apiVersion: 1,
      dependencies: [{ id: options.runtimePluginId, range: "^1.0.0" }],
      tabs: [SETTINGS_KIND],
      builtIn: true,
      enabledByDefault: true,
    },
    activate(context) {
      context.contributeTab<SettingsTabState>({
        manifest: {
          kind: SETTINGS_KIND,
          version: 1,
          stateVersion: SETTINGS_STATE_VERSION,
          presentation: {
            label: "Settings",
            hint: "Preferences",
            icon: "settings",
            order: 50,
          },
        },
        view: {
          requiredServices: [SETTINGS_RUNTIME_SERVICE],
          render: (args) => args.services.get(SETTINGS_RUNTIME_SERVICE).render(args),
        },
        state: {
          parse: parseState,
          migrate: (input, from) => {
            if (from !== 0 && from !== SETTINGS_STATE_VERSION) {
              throw new Error(`unsupported settings state version: ${from}`);
            }
            return parseState(input);
          },
        },
        permissions: [],
        fallback: "unsupported",
      });
    },
  };
}
