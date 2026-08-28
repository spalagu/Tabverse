/**
 * Reconnect policy shared by the two remote viewers — the desktop RemoteView
 * and the standalone browser page (apps/join). Pure logic, no DOM, so the
 * schedule and the end-classification can be unit-tested.
 *
 * A host-sent `End` is deliberate
 * (sharing stopped, kicked, expired) and terminal — show the reason, never
 * retry. Everything else (transport error, connection closed, join timeout)
 * is unexpected — retry with exponential backoff, unlimited attempts, and a
 * successful rejoin resets the backoff.
 */

/** First retry delay; doubles per attempt. */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** Backoff ceiling. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Delay before retry `attempt` (1-based): 1s, 2s, 4s … capped at 30s. */
export function reconnectDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // Math.pow, not a bit shift: attempts are unlimited and `1 << 31` wraps.
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, n - 1);
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

/**
 * Both Rust client libraries (tabverse-remote for the desktop, tabverse-web for the
 * browser) fold transport failures into a synthesized `End` frame whose
 * reason starts with this prefix; a host-sent End carries the host's own
 * reason. This prefix is the only wire-visible signal separating "the host
 * ended the session" from "the link died".
 */
export const CONNECTION_LOST_PREFIX = "connection lost:";

/** True when an `End { reason }` came from the host on purpose (no retry). */
export function isDeliberateEnd(reason: string): boolean {
  return !reason.startsWith(CONNECTION_LOST_PREFIX);
}

/**
 * True when a failed join can never succeed no matter how often we retry:
 * the ticket itself is unusable (wrong prefix, bad base32, bad payload).
 * Every such message from either client library names the ticket; transient
 * failures (bind/connect/open_bi/timeout) never do.
 */
export function isPermanentJoinError(message: string): boolean {
  return /ticket/i.test(message);
}
