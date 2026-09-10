import { createWorkbenchRuntime } from "@tabverse/runtime-contracts";

/** A Join viewer renders host-owned tabs but cannot open another Join flow. */
export const remoteRuntime = createWorkbenchRuntime("remote", [
  "terminal",
  "files",
  "browser",
  "settings",
  "agent",
]);
