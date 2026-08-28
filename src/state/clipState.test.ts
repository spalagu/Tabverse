/**
 * Discriminating evidence for the joiner's clipboard-channel state: what
 * a host clip does to the local board, what the cap and the seq refuse,
 * and the one branch paste reconciliation owns — a local board the host
 * never saw is pushed before the paste lands on it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIP_MAX_BYTES,
  dismissManualClip,
  manualCopy,
  onManualClipNeeded,
  receiveClip,
  reconcilePaste,
  resetHostClip,
} from "./clipState";

/** The board the module reaches for, swapped the same way the keys tests
 * swap it: a stub under the real navigator property. */
function stubBoard(
  writeText: (text: string) => Promise<void> = () => Promise.resolve()
) {
  const fn = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: fn },
    configurable: true,
  });
  return fn;
}

describe("clip channel state (joiner)", () => {
  beforeEach(resetHostClip);

  it("a host clip writes the local board", () => {
    const writeText = stubBoard();
    receiveClip(3, "from the host");
    expect(writeText).toHaveBeenCalledWith("from the host");
  });

  it("a refused board write is silence, and the memory still answers for reconciliation", async () => {
    const writeText = stubBoard(() =>
      Promise.reject(new Error("document is not focused"))
    );
    receiveClip(1, "unwritable");
    // A microtask turn, not a timer: by now the caught rejection has run
    // its catch — an unhandled one would fail the test run instead.
    await Promise.resolve();
    await Promise.resolve();

    const pushed: string[] = [];
    // Same text: the host already has it, nothing to push.
    reconcilePaste("unwritable", (t) => pushed.push(t));
    expect(pushed).toEqual([]);
    // Different text: the blind-spot branch — push it.
    reconcilePaste("copied elsewhere", (t) => pushed.push(t));
    expect(pushed).toEqual(["copied elsewhere"]);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("an over-cap clip never lands, on the board or in the memory", () => {
    const writeText = stubBoard();
    receiveClip(2, "x".repeat(CLIP_MAX_BYTES + 1));
    expect(writeText).not.toHaveBeenCalled();
    // Nothing was remembered: reconciliation has no host clip to differ
    // from, so a local paste pushes nothing.
    const pushed: string[] = [];
    reconcilePaste("local text", (t) => pushed.push(t));
    expect(pushed).toEqual([]);
  });

  it("the cap is measured in bytes, not UTF-16 units", () => {
    const writeText = stubBoard();
    // One CJK char is 1 UTF-16 unit but 3 UTF-8 bytes: a third of the
    // cap in .length is already over it in bytes.
    receiveClip(1, "\u6c49".repeat(Math.floor(CLIP_MAX_BYTES / 3) + 1));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a stale seq cannot displace newer knowledge", () => {
    const writeText = stubBoard();
    receiveClip(5, "newer");
    receiveClip(4, "replayed");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("newer");
  });

  it("reconciliation pushes only a foreign board, never the host's own text back", () => {
    const pushed: string[] = [];
    // No host clip yet: nothing to reconcile against.
    reconcilePaste("local", (t) => pushed.push(t));
    expect(pushed).toEqual([]);

    receiveClip(1, "host text");
    // Identical to what the host pushed: the host already has it.
    reconcilePaste("host text", (t) => pushed.push(t));
    expect(pushed).toEqual([]);

    // Different: a copy made outside this page — push before the paste.
    reconcilePaste("copied elsewhere", (t) => pushed.push(t));
    expect(pushed).toEqual(["copied elsewhere"]);

    // Empty text never pushes, whatever the memory holds.
    reconcilePaste("", (t) => pushed.push(t));
    expect(pushed).toEqual(["copied elsewhere"]);
  });

  it("a reset drops the memory the next share would inherit", () => {
    receiveClip(1, "from the first share");
    resetHostClip();
    const writeText = stubBoard();
    const pushed: string[] = [];
    reconcilePaste("from the first share", (t) => pushed.push(t));
    expect(pushed).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });
});
describe("the degrade panel's channel (joiner)", () => {
  beforeEach(resetHostClip);

  it("a refused write raises the manual clip; a clicking retry lands and clears it", async () => {
    // First write refuses (focus lost), the retry (behind a click)
    let calls = 0;
    stubBoard((text) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("focus"));
      return Promise.resolve().then(() => text.length > -1 ? undefined : undefined);
    });
    const seen: string[] = [];
    const off = onManualClipNeeded((t) => seen.push(t));
    receiveClip(1, "stranded");
    await vi.waitFor(() => expect(seen).toEqual(["stranded"]));
    // The retry behind the gesture takes, and the panel may go.
    await expect(manualCopy()).resolves.toBe(true);
    // Nothing stranded remains: a later manualCopy is a no-op true.
    await expect(manualCopy()).resolves.toBe(true);
    off();
  });

  it("dismiss drops the stranded clip without touching the board", async () => {
    stubBoard(() => Promise.reject(new Error("focus")));
    const seen: string[] = [];
    const off = onManualClipNeeded((t) => seen.push(t));
    receiveClip(2, "gone");
    await vi.waitFor(() => expect(seen).toEqual(["gone"]));
    dismissManualClip();
    await expect(manualCopy()).resolves.toBe(true);
    off();
  });
});
