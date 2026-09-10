import {
  RUNTIME_CAPABILITIES,
  createWorkbenchRuntime,
} from "@tabverse/runtime-contracts";

/** Desktop has every renderer capability, including joining another host. */
export const desktopRuntime = createWorkbenchRuntime(
  "desktop",
  RUNTIME_CAPABILITIES
);
