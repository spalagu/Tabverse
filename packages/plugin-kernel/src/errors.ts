export type PluginKernelErrorCode =
  | "INVALID_MANIFEST"
  | "UNKNOWN_PLUGIN"
  | "DUPLICATE_PLUGIN"
  | "DUPLICATE_KIND"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_VERSION"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_NOT_ENABLED"
  | "UNKNOWN_SERVICE"
  | "DUPLICATE_SERVICE"
  | "UNKNOWN_TAB_KIND"
  | "DUPLICATE_TAB_INSTANCE"
  | "PLUGIN_NOT_ENABLED"
  | "INVALID_STATE_TRANSITION"
  | "REVISION_CONFLICT"
  | "COMMAND_CONFLICT"
  | "PLUGIN_BLOCKED"
  | "CATALOG_CORRUPT"
  | "ACTIVATION_FAILED"
  | "DISPOSAL_FAILED";

export class PluginKernelError extends Error {
  constructor(
    readonly code: PluginKernelErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginKernelError";
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
