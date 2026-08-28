import { afterEach, describe, expect, it, vi } from "vitest";
import { claimFileCloseKey } from "./fileCloseKey";
import {
  SHORTCUTS,
  eventChordId,
  matchBinding,
  parseChord,
  setKeyOverrides,
} from "../../shortcuts";

/**
 * Stand-in for the window-level shortcut handler (src/keys.ts): same target,
 * same phase, registered after the component tree has been imported — which
 * is what the claim has to get in front of. It reads the composition, as the
 * real one does, so that a rebinding moves the thing being got in front of.
 */
function installCloseTab(closeTab: () => void): () => void {
  const h = (e: KeyboardEvent) => {
    if (matchBinding("close-tab", eventChordId(e)) !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeTab();
  };
  window.addEventListener("keydown", h, { capture: true });
  return () => window.removeEventListener("keydown", h, { capture: true });
}

/** The key a command SHIPS with — read from the table, never retyped here. */
function shipped(command: string): string {
  const row = SHORTCUTS.find((s) => String(s.command) === command);
  if (row?.keys === undefined) throw new Error(`no shipped key for ${command}`);
  return row.keys;
}

/**
 * A press of one chord. The command modifier goes out as ⌘ and Ctrl at once,
 * so that whichever platform happens to be running these does not change
 * what the press means.
 */
function press(keys: string): KeyboardEvent {
  const chord = parseChord(keys);
  if (chord === null) throw new Error(`not one chord: ${keys}`);
  const e = new KeyboardEvent("keydown", {
    key: chord.key,
    metaKey: chord.cmd,
    ctrlKey: chord.cmd || chord.ctrl,
    altKey: chord.alt,
    shiftKey: chord.shift,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(e);
  return e;
}

function pressCloseKey(): KeyboardEvent {
  return press(shipped("close-tab"));
}

const cleanups: (() => void)[] = [];
const track = (fn: () => void) => {
  cleanups.push(fn);
  return fn;
};

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("⌘W layering", () => {
  it("closes the file and leaves the tab alone", () => {
    const closeTab = vi.fn();
    track(installCloseTab(closeTab));
    const closeFile = vi.fn(() => true);
    track(claimFileCloseKey(closeFile));

    const e = pressCloseKey();

    expect(closeFile).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("falls through to closing the tab when no file is open", () => {
    const closeTab = vi.fn();
    track(installCloseTab(closeTab));
    // What the explorer answers with an empty tab strip.
    track(claimFileCloseKey(() => false));

    pressCloseKey();

    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("leaves every other tab type's ⌘W untouched", () => {
    const closeTab = vi.fn();
    track(installCloseTab(closeTab));

    pressCloseKey();

    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("follows close-tab to wherever the user moves it", () => {
    // The pre-emption exists to be offered ONE command's key before the
    // app-wide handler is. Written down as a letter, it goes on pre-empting
    // a key nobody closes tabs with and stops pre-empting the one they do —
    // and the explorer then spends a single press on its whole tab, the
    // tree and every other open file included, which is the loss this
    // mechanism was built to prevent.
    const closeTab = vi.fn();
    track(installCloseTab(closeTab));
    const closeFile = vi.fn(() => true);
    track(claimFileCloseKey(closeFile));
    setKeyOverrides({ "close-tab": "⌘⇧W" });
    track(() => setKeyOverrides({}));

    press("⌘⇧W");

    expect(closeFile, "the new key reaches the explorer first").toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();

    // And the key it was moved off is nobody's: neither half answers it.
    press(shipped("close-tab"));

    expect(closeFile).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("keeps the newest claim when an older explorer gives its own back", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const releaseFirst = claimFileCloseKey(first);
    track(claimFileCloseKey(second));
    releaseFirst();

    pressCloseKey();

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
});
