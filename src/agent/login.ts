/**
 * Driving a browser sign-in from the interface.
 *
 * Kept out of the component because the interesting part is a loop with three
 * outcomes and two clocks, and none of that needs a screen to be tested. The
 * component supplies the backend and shows whatever this reports.
 */

import type { AgentLogin, LoginStarted } from "../backend/types";
import { errorText } from "../strings/errors";

export type LoginState =
  | { phase: "idle" }
  | { phase: "waiting"; login: LoginStarted }
  | { phase: "done" }
  | { phase: "failed"; reason: string };

/** How long to keep asking before giving up, matching the server's window. */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Run a sign-in to its end, reporting each state as it is reached.
 *
 * `slow_down` lengthens the wait rather than being ignored: the server asking
 * for a slower poll and being polled at the same rate anyway is how a client
 * gets itself rate-limited out of a login it was about to complete.
 */
export async function runLogin(
  api: AgentLogin,
  onState: (state: LoginState) => void,
  clock: Clock = realClock,
): Promise<LoginState> {
  let started: LoginStarted;
  try {
    started = await api.start();
  } catch (e) {
    const failed = { phase: "failed", reason: errorText(e) } as const;
    onState(failed);
    return failed;
  }
  onState({ phase: "waiting", login: started });

  const deadline = clock.now() + LOGIN_TIMEOUT_MS;
  let waitMs = Math.max(1, started.intervalSecs) * 1000;

  for (;;) {
    if (clock.now() >= deadline) {
      // Said plainly rather than as a generic failure: the code expiring is
      // something the user can simply do again.
      const failed = {
        phase: "failed",
        reason: "The sign-in code expired. Start again to get a new one.",
      } as const;
      onState(failed);
      return failed;
    }
    await clock.sleep(waitMs);

    let answer;
    try {
      answer = await api.poll();
    } catch (e) {
      const failed = { phase: "failed", reason: errorText(e) } as const;
      onState(failed);
      return failed;
    }

    if (answer === "ready") {
      const done = { phase: "done" } as const;
      onState(done);
      return done;
    }
    if (answer === "slow_down") {
      waitMs *= 2;
    }
  }
}
