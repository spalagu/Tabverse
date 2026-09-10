import type { TabType } from "@tabverse/runtime-contracts";

/**
 * V3 built-in feature composition.
 *
 * These modules are trusted, compile-time application features. They are
 * intentionally not modeled as runtime-installable third-party plugins.
 */
export type FeatureCloseBehavior = "close" | "stop-runtime" | "detach-runtime" | "ask";

export type FeatureStateDecodeResult<State> =
  | { readonly kind: "ready"; readonly version: number; readonly state: State }
  | {
      readonly kind: "unsupported-newer";
      readonly version: number;
      readonly original: unknown;
    }
  | { readonly kind: "invalid"; readonly reason: string; readonly original: unknown };

export interface FeatureStateCodec<State> {
  readonly currentVersion: number;
  decode(version: number, original: unknown): FeatureStateDecodeResult<State>;
}

type StateMigration = (state: Record<string, unknown>) => Record<string, unknown>;

/** Versioned object state shared by today's built-ins. Missing migrations
 * fail without rewriting the payload; future versions remain byte-for-byte
 * available to the unsupported-state UI. */
export function objectStateCodec(
  currentVersion: number,
  migrations: Readonly<Record<number, StateMigration>> = {},
): FeatureStateCodec<Record<string, unknown>> {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new Error("Feature state version must be a positive integer");
  }
  return {
    currentVersion,
    decode(version, original) {
      if (!Number.isSafeInteger(version) || version < 1) {
        return { kind: "invalid", reason: "invalid-version", original };
      }
      if (version > currentVersion) {
        return { kind: "unsupported-newer", version, original };
      }
      if (typeof original !== "object" || original === null || Array.isArray(original)) {
        return { kind: "invalid", reason: "invalid-shape", original };
      }
      let state = original as Record<string, unknown>;
      for (let from = version; from < currentVersion; from += 1) {
        const migrate = migrations[from];
        if (migrate === undefined) {
          return { kind: "invalid", reason: `missing-migration-${from}`, original };
        }
        state = migrate(state);
      }
      return { kind: "ready", version: currentVersion, state };
    },
  };
}

export interface BuiltInFeatureModuleDefinition {
  readonly kind: TabType;
  readonly label: string;
  readonly hint: string;
  readonly closeBehavior: FeatureCloseBehavior;
  readonly state: FeatureStateCodec<Record<string, unknown>>;
}

/**
 * Identity helper that keeps definitions readonly while leaving room for
 * feature-specific state/runtime/remote contracts to be added incrementally.
 */
export function defineBuiltInFeatureModules<
  const TModules extends readonly BuiltInFeatureModuleDefinition[],
>(modules: TModules): TModules {
  const kinds = new Set<TabType>();
  for (const module of modules) {
    if (kinds.has(module.kind)) {
      throw new Error(`Duplicate built-in feature module: ${module.kind}`);
    }
    kinds.add(module.kind);
  }
  return modules;
}

export const BUILT_IN_FEATURE_MODULES = defineBuiltInFeatureModules([
  {
    kind: "terminal",
    label: "Terminal",
    hint: "A shell session",
    closeBehavior: "stop-runtime",
    state: objectStateCodec(1),
  },
  {
    kind: "files",
    label: "Files",
    hint: "Explorer with git status and previews",
    closeBehavior: "close",
    state: objectStateCodec(1),
  },
  {
    kind: "browser",
    label: "Browser",
    hint: "Embedded web page",
    closeBehavior: "close",
    state: objectStateCodec(1),
  },
  {
    kind: "agent",
    label: "Agent",
    hint: "A coding agent working in a folder",
    closeBehavior: "ask",
    state: objectStateCodec(1),
  },
  {
    kind: "remote",
    label: "Join remote…",
    hint: "Join a shared Tabverse session",
    closeBehavior: "close",
    state: objectStateCodec(1),
  },
  {
    kind: "settings",
    label: "Settings",
    hint: "Preferences",
    closeBehavior: "close",
    state: objectStateCodec(1),
  },
] as const);
