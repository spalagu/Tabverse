import type { SessionRestoreResult } from "./state/store";

/** A present session failed recovery and must not be overwritten silently. */
export type SessionRecoveryFailure = Exclude<
  SessionRestoreResult,
  "restored" | "missing"
>;

export type SessionRecoveryOutcome = "restored" | "initialized" | "preserved";

/**
 * The single startup gate allowed to create a default session.
 *
 * A file the carrier explicitly reports missing is a first launch. Every
 * other recovery failure is evidence of an existing session, so the default
 * path preserves it until its owner chooses replacement. Keeping this choice
 * here prevents another startup hook from silently replacing the `session`
 * scope in app.db.
 */
export async function recoverOrInitializeSession(options: {
  fresh: boolean;
  restore: () => Promise<SessionRestoreResult>;
  initialize: () => void | Promise<void>;
  replace: () => void | Promise<void>;
  ask: (reason: SessionRecoveryFailure) => Promise<boolean>;
}): Promise<SessionRecoveryOutcome> {
  if (options.fresh) {
    await options.initialize();
    return "initialized";
  }

  const result = await options.restore();
  if (result === "restored") return "restored";
  if (result === "missing") {
    await options.initialize();
    return "initialized";
  }
  if (await options.ask(result)) {
    await options.replace();
    await options.initialize();
    return "initialized";
  }
  return "preserved";
}
