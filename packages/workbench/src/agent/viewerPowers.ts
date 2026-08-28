/**
 * What a viewer of a shared agent may do.
 *
 * A pure function of the level the host granted, kept out of the component so
 * that "steer may talk but not authorise" is a thing with a test rather than a
 * thing spread across three `disabled` attributes.
 *
 * This decides what the interface offers. It decides nothing about what is
 * allowed: the host checks every frame it receives, because a client-side gate
 * only stops an honest client.
 */

import type { AgentAccess } from "@tabverse/runtime-contracts";

export interface ViewerPowers {
  /** May put a prompt in, and may stop a turn. */
  canSteer: boolean;
  /** May decide a permission request. */
  canApprove: boolean;
}

export function viewerPowers(access: AgentAccess | null): ViewerPowers {
  switch (access) {
    case "approve":
      return { canSteer: true, canApprove: true };
    case "steer":
      return { canSteer: true, canApprove: false };
    // Unknown, absent, or a level from a build newer than this one: watch only.
    // The conservative direction — a viewer wrongly believing it may act is the
    // worse mistake, and the host would refuse the frame anyway.
    default:
      return { canSteer: false, canApprove: false };
  }
}

/** What to tell the viewer it is allowed to do, in one line. */
export function describePowers(powers: ViewerPowers): string {
  if (powers.canApprove) return "You can steer this agent and approve what it does";
  if (powers.canSteer) return "You can steer this agent, but not approve what it does";
  return "You are watching";
}
