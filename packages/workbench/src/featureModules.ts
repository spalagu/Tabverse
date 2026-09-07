import type { TabType } from "@tabverse/runtime-contracts";

/**
 * V3 built-in feature composition.
 *
 * These modules are trusted, compile-time application features. They are
 * intentionally not modeled as runtime-installable third-party plugins.
 */
export type FeatureCloseBehavior = "close" | "stop-runtime" | "detach-runtime" | "ask";

export interface BuiltInFeatureModuleDefinition {
  readonly kind: TabType;
  readonly label: string;
  readonly hint: string;
  readonly closeBehavior: FeatureCloseBehavior;
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
  },
  {
    kind: "files",
    label: "Files",
    hint: "Explorer with git status and previews",
    closeBehavior: "close",
  },
  {
    kind: "browser",
    label: "Browser",
    hint: "Embedded web page",
    closeBehavior: "close",
  },
  {
    kind: "agent",
    label: "Agent",
    hint: "A coding agent working in a folder",
    closeBehavior: "ask",
  },
  {
    kind: "remote",
    label: "Join remote…",
    hint: "Join a shared Tabverse session",
    closeBehavior: "close",
  },
  {
    kind: "settings",
    label: "Settings",
    hint: "Preferences",
    closeBehavior: "close",
  },
] as const);
