import { describe, expect, it } from "vitest";
import {
  RECONNECT_MAX_DELAY_MS,
  isDeliberateEnd,
  isPermanentJoinError,
  reconnectDelayMs,
} from "./remoteReconnect";

describe("reconnectDelayMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
    expect(reconnectDelayMs(5)).toBe(16_000);
    expect(reconnectDelayMs(6)).toBe(30_000);
    expect(reconnectDelayMs(7)).toBe(30_000);
  });

  it("stays at the cap for arbitrarily large attempt counts", () => {
    // Attempts are unlimited; a bit-shift implementation would wrap negative
    // past attempt 31 and Math.pow overflows to Infinity far later — either
    // way the cap must hold.
    expect(reconnectDelayMs(31)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(64)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(10_000)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("clamps out-of-range attempts to the first slot", () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(-5)).toBe(1_000);
    expect(reconnectDelayMs(1.7)).toBe(1_000);
  });
});

describe("isDeliberateEnd", () => {
  it("treats host-sent reasons as deliberate (no retry)", () => {
    expect(isDeliberateEnd("sharing stopped")).toBe(true);
    expect(isDeliberateEnd("tab closed")).toBe(true);
    expect(isDeliberateEnd("kicked by host")).toBe(true);
    expect(isDeliberateEnd("ticket expired")).toBe(true);
  });

  it("treats the synthesized transport-loss reason as unexpected (retry)", () => {
    // Both tabverse-remote and tabverse-web fold read errors into this exact shape.
    expect(isDeliberateEnd("connection lost: read_exact: reset")).toBe(false);
    expect(isDeliberateEnd("connection lost: timed out")).toBe(false);
  });
});

describe("isPermanentJoinError", () => {
  it("flags unusable tickets so we do not retry them forever", () => {
    // tabverse-web decode errors.
    expect(isPermanentJoinError("not a Tabverse ticket")).toBe(true);
    expect(isPermanentJoinError("ticket is not valid base32: length")).toBe(true);
    expect(isPermanentJoinError("ticket payload invalid: EOF")).toBe(true);
    // tabverse-remote decode errors (anyhow chains rendered with {:#}).
    expect(
      isPermanentJoinError("not a Tabverse ticket (missing 'tabv' prefix)")
    ).toBe(true);
    expect(isPermanentJoinError("ticket base32 decode failed: odd length")).toBe(
      true
    );
  });

  it("keeps transient join failures retryable", () => {
    expect(isPermanentJoinError("connect timeout")).toBe(false);
    expect(isPermanentJoinError("connect failed: no relay")).toBe(false);
    expect(isPermanentJoinError("iroh bind failed: denied")).toBe(false);
    expect(isPermanentJoinError("open_bi failed: closed")).toBe(false);
    expect(isPermanentJoinError("join timeout")).toBe(false);
  });
});
