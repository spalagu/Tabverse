import {
  TAB_TYPES,
  supportsTab,
  type TabType,
  type WorkbenchRuntime,
} from "@tabverse/runtime-contracts";
import { BUILT_IN_FEATURE_MODULES } from "./featureModules";

export interface TabDefinition {
  readonly type: TabType;
  readonly label: string;
  readonly hint: string;
}

/** The public projection of the built-in feature registry. */
export const TAB_DEFINITIONS: readonly TabDefinition[] = BUILT_IN_FEATURE_MODULES.map(
  ({ kind, label, hint }) => ({ type: kind, label, hint }),
);

const byType = new Map(TAB_DEFINITIONS.map((definition) => [definition.type, definition]));

export function tabDefinition(type: TabType): TabDefinition {
  const definition = byType.get(type);
  if (definition === undefined) throw new Error(`No Workbench definition for ${type}`);
  return definition;
}

export function tabDefinitionsForRuntime(
  runtime: WorkbenchRuntime
): readonly TabDefinition[] {
  return TAB_DEFINITIONS.filter((definition) => supportsTab(runtime, definition.type));
}

/** Fails at module load if the runtime contract gains a tab without a UI entry. */
if (TAB_DEFINITIONS.length !== TAB_TYPES.length) {
  throw new Error("Workbench feature registry does not cover every TabType");
}
