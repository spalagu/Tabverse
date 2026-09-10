import { describe, expect, it, vi } from "vitest";
import type { AgentLogin, LoginPoll } from "../backend/types";
import { LOGIN_TIMEOUT_MS, runLogin, type Clock, type LoginState } from "./login";

/**
 * A clock that never really waits, and remembers what it was asked to.
 *
 * It also refuses to be asked too many times. A loop with no way out would
 * otherwise hang the run rather than fail it, and a test that hangs proves
 * nothing about the assertion it was written for.
 */
function fakeClock(maxSleeps = 1000) {
  let t = 0;
  const waits: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      if (waits.length >= maxSleeps) {
        throw new Error(`slept ${maxSleeps} times without finishing: this loop has no end`);
      }
      waits.push(ms);
      t += ms;
    },
  };
  return { clock, waits };
}

function api(answers: LoginPoll[], overrides: Partial<AgentLogin> = {}): AgentLogin {
  const queue = [...answers];
  return {
    status: async () => false,
    start: async () => ({
      url: "https://auth.openai.com/oauth/authorize?state=s",
      intervalSecs: 5,
    }),
    poll: async () => queue.shift() ?? "pending",
    logout: async () => {},
    ...overrides,
  };
}

describe("running a sign-in", () => {
  it("reports what the user must do before waiting on them", async () => {
    const states: LoginState[] = [];
    const { clock } = fakeClock();
    await runLogin(api(["ready"]), (s) => states.push(s), clock);

    expect(states[0]).toEqual({
      phase: "waiting",
      login: {
        url: "https://auth.openai.com/oauth/authorize?state=s",
        intervalSecs: 5,
      },
    });
    expect(states.at(-1)).toEqual({ phase: "done" });
  });

  it("keeps asking while the answer is pending", async () => {
    const { clock, waits } = fakeClock();
    const result = await runLogin(api(["pending", "pending", "ready"]), () => {}, clock);
    expect(result).toEqual({ phase: "done" });
    // The server's interval, unchanged: nothing asked for it to be longer.
    expect(waits).toEqual([5000, 5000, 5000]);
  });

  it("waits longer when told to slow down", async () => {
    // Being asked for a slower poll and carrying on at the same rate is how a
    // client gets rate-limited out of a login it was about to complete.
    const { clock, waits } = fakeClock();
    await runLogin(api(["slow_down", "slow_down", "ready"]), () => {}, clock);
    expect(waits).toEqual([5000, 10000, 20000]);
  });

  it("gives up when the code's window has passed, and says why", async () => {
    const { clock } = fakeClock();
    const result = await runLogin(api([]), () => {}, clock);
    expect(result.phase).toBe("failed");
    expect(result.phase === "failed" && result.reason).toContain("expired");
  });

  it("stops asking once the window has passed rather than forever", async () => {
    const { clock, waits } = fakeClock();
    await runLogin(api([]), () => {}, clock);
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(LOGIN_TIMEOUT_MS + 5000);
  });

  it("reports a refusal from the server instead of polling on", async () => {
    const { clock } = fakeClock();
    const poll = vi.fn(async () => {
      throw new Error("the login was declined");
    });
    const result = await runLogin(api([], { poll }), () => {}, clock);
    expect(result.phase).toBe("failed");
    expect(result.phase === "failed" && result.reason).toContain("declined");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("fails without waiting when the sign-in cannot even be started", async () => {
    const { clock, waits } = fakeClock();
    const start = async () => {
      throw new Error("no network");
    };
    const result = await runLogin(api([], { start }), () => {}, clock);
    expect(result.phase).toBe("failed");
    expect(waits).toEqual([]);
  });
});
