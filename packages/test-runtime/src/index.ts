import {
  createWorkbenchRuntime,
  type RuntimeCapability,
  type RuntimeKind,
  type WorkbenchRuntime,
} from "@tabverse/runtime-contracts";

/** Deterministic adapter fixture for renderer and contract tests. */
export function createTestRuntime(
  capabilities: Iterable<RuntimeCapability>,
  kind: RuntimeKind = "test"
): WorkbenchRuntime {
  return createWorkbenchRuntime(kind, capabilities);
}
