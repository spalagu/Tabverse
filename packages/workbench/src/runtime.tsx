import { createContext, useContext, type ReactNode } from "react";
import type { WorkbenchRuntime } from "@tabverse/runtime-contracts";

const RuntimeContext = createContext<WorkbenchRuntime | null>(null);

/** The only entry-point seam visible to shared Workbench components. */
export function WorkbenchRuntimeProvider({
  runtime,
  children,
}: {
  runtime: WorkbenchRuntime;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useWorkbenchRuntime(): WorkbenchRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("Workbench components must be mounted below WorkbenchRuntimeProvider");
  }
  return runtime;
}
