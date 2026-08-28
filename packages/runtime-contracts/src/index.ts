export * from "./agent";
export * from "./appShare";
export * from "./remote";

/** Shared facts that every Tabverse renderer may depend on. This package is
 * deliberately free of React, Tauri, browser globals and transport code. */
export const TAB_TYPES = [
  "terminal",
  "files",
  "browser",
  "agent",
  "remote",
  "settings",
] as const;

export type TabType = (typeof TAB_TYPES)[number];
export type RuntimeKind = "desktop" | "remote" | "test";

export const RUNTIME_CAPABILITIES = [
  "terminal",
  "files",
  "browser",
  "settings",
  "remote-session",
  "agent",
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface WorkbenchRuntime {
  readonly kind: RuntimeKind;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
}

export function createWorkbenchRuntime(
  kind: RuntimeKind,
  capabilities: Iterable<RuntimeCapability>
): WorkbenchRuntime {
  return { kind, capabilities: new Set(capabilities) };
}

export const TAB_REQUIREMENTS: Readonly<Record<TabType, RuntimeCapability>> = {
  terminal: "terminal",
  files: "files",
  browser: "browser",
  settings: "settings",
  remote: "remote-session",
  agent: "agent",
};

export function supportsTab(runtime: WorkbenchRuntime, type: TabType): boolean {
  return runtime.capabilities.has(TAB_REQUIREMENTS[type]);
}
