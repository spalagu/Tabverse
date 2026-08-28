export type QuitChoice = "background" | "stop" | null;
export type QuitResult = "proceed" | "cancel";

export interface QuitPreparation {
  backgroundTasksOn: boolean;
  busyCount: number;
  choose: () => Promise<QuitChoice>;
  detachAll: () => Promise<boolean>;
  killAll: () => Promise<void>;
}

/**
 * Decide the one normal-quit action for helper-owned terminals.
 *
 * Helper-first changes the old physical default: process exit no longer drops
 * the PTY. Therefore every non-background quit must explicitly KillAll and
 * wait for its acknowledgement before the window is destroyed.
 */
export async function prepareTerminalQuit(
  preparation: QuitPreparation
): Promise<QuitResult> {
  if (!preparation.backgroundTasksOn || preparation.busyCount === 0) {
    await preparation.killAll();
    return "proceed";
  }

  const choice = await preparation.choose();
  if (choice === null) return "cancel";
  if (choice === "stop") {
    await preparation.killAll();
    return "proceed";
  }
  return (await preparation.detachAll()) ? "proceed" : "cancel";
}
