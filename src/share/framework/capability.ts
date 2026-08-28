import type { AgentAccess } from "../../backend/types";
import type { TabType } from "../../state/store";
import type { ViewerRegistration } from "./viewer";

/**
 * What a kind of tab declares about being shared. The framework never asks
 * "is this a terminal?" — it asks the declaration, and a type that never
 * registered one is not shareable, by construction rather than by a gate
 * somebody remembered to write.
 */

/** The three levels a viewer can hold (the literal union AgentAccess names). */
export type ShareAccess = AgentAccess;

/** How viewers render this share: the built-in xterm grid, or a registered
 * DOM pane fed by a fold. */
export type SharePayload = "grid" | "dom";

/** Folds host frames into the state a dom viewer pane renders. */
export interface ViewerFold<S> {
  initial: S;
  apply(state: S, frame: unknown): S;
}

export type ShareCapability =
  | { shareable: false; reason: string }
  | {
      shareable: true;
      /** The levels this kind of tab can hand out, in menu order. */
      levels: readonly ShareAccess[];
      /** What a share starts at when nobody chose. */
      defaultLevel: ShareAccess;
      payload: SharePayload;
      /** dom payloads only: the pane and fold viewers render with. */
      viewer?: ViewerRegistration;
    };

const registry = new Map<TabType, ShareCapability>();

/** "Not shareable" written as code: the answer for every type that never
 * declared itself. */
const UNSHAREABLE: ShareCapability = {
  shareable: false,
  reason: "this kind of tab cannot be shared",
};

/** One call per tab type, from src/share/capabilities/<type>.ts. */
export function registerShareCapability(
  type: TabType,
  cap: ShareCapability
): void {
  registry.set(type, cap);
}

export function shareCapability(type: TabType): ShareCapability {
  return registry.get(type) ?? UNSHAREABLE;
}
