import {
  TAB_TYPES,
  supportsTab,
  type TabType,
  type WorkbenchRuntime,
} from "@tabverse/runtime-contracts";

export interface TabDefinition {
  readonly type: TabType;
  readonly label: string;
  readonly hint: string;
}

/** The one renderer-facing registry for every Tabverse tab type. */
export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { type: "terminal", label: "Terminal", hint: "A shell session" },
  { type: "files", label: "Files", hint: "Explorer with git status and previews" },
  { type: "browser", label: "Browser", hint: "Embedded web page, loaded by the host" },
  { type: "agent", label: "Agent", hint: "A coding agent working in a folder" },
  { type: "remote", label: "Join remote…", hint: "Join a shared Tabverse session" },
  { type: "settings", label: "Settings", hint: "Preferences" },
] as const;

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
  throw new Error("Workbench tab registry does not cover every TabType");
}
