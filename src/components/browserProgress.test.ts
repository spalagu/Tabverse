import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserProgressBar } from "./BrowserProgressBar";
import {
  PROGRESS_EXTENT,
  PROGRESS_FADE_MS,
  PROGRESS_SPRINT_MS,
  advance,
  bandClasses,
  forgetProgress,
  navSignal,
  progressFor,
  resetAllProgress,
  PROGRESS_IDLE,
} from "./browserProgress";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

/** Reduced motion off unless a test says otherwise. */
function stubMotionPreference(reduce: boolean): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Only the component's own clocks; React's scheduling must stay real or
  // act() never flushes (same reason as loadingState.test.ts).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stubMotionPreference(false);
  resetAllProgress();
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetAllProgress();
  vi.useRealTimers();
});

function band(where: ParentNode = host): HTMLElement | null {
  return where.querySelector(".browser-progress-band");
}

function mount(...tabIds: string[]): void {
  act(() => {
    root.render(
      createElement(
        "div",
        null,
        ...tabIds.map((id) =>
          createElement(
            "div",
            { key: id, "data-pane": id },
            createElement(BrowserProgressBar, { tabId: id })
          )
        )
      )
    );
  });
}

function pane(tabId: string): HTMLElement {
  const el = host.querySelector(`[data-pane="${tabId}"]`);
  if (!el) throw new Error(`no pane rendered for ${tabId}`);
  return el as HTMLElement;
}

describe("the three stops follow the engine's events", () => {
  it("start → commit → complete each move the band, in that order", () => {
    mount("t1");
    // Nothing has navigated: nothing renders at all. The old always-in-DOM
    // rail left a 4px seam of canvas showing above every loaded page once
    // the band faded — the "black residue" — so the whole rail is now
    // load-only, and the 2px shift at navigation rides the redraw the page
    // is already doing.
    expect(host.querySelector(".browser-progress")).toBeNull();
    expect(band()).toBeNull();

    act(() => navSignal("t1", "start"));
    expect(band()!.style.width).toBe(`${PROGRESS_EXTENT.started}%`);
    expect(band()!.classList.contains("phase-started")).toBe(true);

    act(() => navSignal("t1", "commit"));
    expect(band()!.style.width).toBe(`${PROGRESS_EXTENT.committed}%`);
    expect(band()!.classList.contains("phase-committed")).toBe(true);

    act(() => navSignal("t1", "complete"));
    expect(band()!.style.width).toBe(`${PROGRESS_EXTENT.finishing}%`);
    expect(band()!.classList.contains("phase-finishing")).toBe(true);
  });

  it("does not advance on its own while no event arrives", () => {
    // THE discriminating assertion. The bar this replaces was a looping CSS
    // animation: it would have kept moving through every one of these ticks
    // with the page dead on the wire. Here a load that says nothing after
    // "started" draws a band that says nothing after "started".
    mount("t1");
    act(() => navSignal("t1", "start"));
    const atStart = band()!.style.width;

    act(() => vi.advanceTimersByTime(10_000));

    expect(band()).not.toBeNull();
    expect(band()!.style.width).toBe(atStart);
    expect(band()!.classList.contains("phase-started")).toBe(true);
    expect(band()!.classList.contains("fading")).toBe(false);
    expect(progressFor("t1")).toEqual({
      phase: "started",
      extent: PROGRESS_EXTENT.started,
      fading: false,
    });
  });

  it("ignores a commit or a completion when no load is in flight", () => {
    // A title change or an in-page address change on a page that is already
    // up. Drawing a bar for either would be a bar about nothing.
    mount("t1");
    act(() => navSignal("t1", "commit"));
    expect(band()).toBeNull();
    act(() => navSignal("t1", "complete"));
    expect(band()).toBeNull();
  });

  it("a failure takes the bar away instead of finishing it", () => {
    mount("t1");
    act(() => navSignal("t1", "start"));
    act(() => navSignal("t1", "fail"));
    expect(band()).toBeNull();
  });

  it("a second navigation restarts the band rather than continuing it", () => {
    mount("t1");
    act(() => navSignal("t1", "start"));
    act(() => navSignal("t1", "commit"));
    act(() => navSignal("t1", "start"));
    expect(band()!.style.width).toBe(`${PROGRESS_EXTENT.started}%`);
  });
});

describe("a finished load sprints, then the whole band leaves", () => {
  it("holds at 100%, then fades, then is gone from the DOM", () => {
    mount("t1");
    act(() => navSignal("t1", "start"));
    act(() => navSignal("t1", "complete"));

    // The sprint: full width, still opaque.
    expect(band()!.style.width).toBe("100%");
    expect(band()!.classList.contains("fading")).toBe(false);

    act(() => vi.advanceTimersByTime(PROGRESS_SPRINT_MS));
    expect(band()).not.toBeNull();
    expect(band()!.classList.contains("fading")).toBe(true);

    act(() => vi.advanceTimersByTime(PROGRESS_FADE_MS));
    expect(band()).toBeNull();
    // Round-five restyle: idle means NOTHING in the DOM — rail included.
    // A permanent rail is what left the seam above loaded pages.
    expect(host.querySelector(".browser-progress")).toBeNull();
    expect(progressFor("t1")).toBe(PROGRESS_IDLE);
  });

  it("a navigation started mid-fade keeps its own band", () => {
    mount("t1");
    act(() => navSignal("t1", "start"));
    act(() => navSignal("t1", "complete"));
    act(() => vi.advanceTimersByTime(PROGRESS_SPRINT_MS));
    act(() => navSignal("t1", "start"));
    // The old load's fade timer must not delete the new load's band.
    act(() => vi.advanceTimersByTime(PROGRESS_FADE_MS * 4));
    expect(band()).not.toBeNull();
    expect(band()!.style.width).toBe(`${PROGRESS_EXTENT.started}%`);
  });
});

describe("signals that arrive out of order", () => {
  // Found by a mutation that survived: loosening the phase guard on "commit"
  // broke nothing that was being asserted. A single-page app that rewrites its
  // title after the load finished emits exactly that sequence, and the bar
  // would slide backwards to 70% and run the whole thing again.
  it("ignores a commit that arrives after the load already finished", () => {
    const finished = advance(
      advance(advance({ phase: "idle", extent: 0, fading: false }, "start"), "commit"),
      "complete"
    );
    const late = advance(finished, "commit");
    expect(late.phase, "a late title change does not reopen a finished load").toBe(
      finished.phase
    );
    expect(late.extent, "and it certainly does not walk the bar backwards").toBe(
      finished.extent
    );
  });

  it("ignores a commit for a pane that never started", () => {
    const fromIdle = advance({ phase: "idle", extent: 0, fading: false }, "commit");
    expect(fromIdle.phase, "no load, no bar").toBe("idle");
  });
});

describe("panes are independent", () => {
  it("one pane loading leaves the other pane's bar alone", () => {
    mount("left", "right");
    act(() => navSignal("left", "start"));

    expect(band(pane("left"))).not.toBeNull();
    expect(band(pane("right"))).toBeNull();

    act(() => navSignal("left", "commit"));
    expect(band(pane("left"))!.style.width).toBe(`${PROGRESS_EXTENT.committed}%`);
    expect(band(pane("right"))).toBeNull();

    // And the other way round, at a different stop, so an implementation
    // that merely mirrors state cannot pass by accident.
    act(() => navSignal("right", "start"));
    expect(band(pane("right"))!.style.width).toBe(`${PROGRESS_EXTENT.started}%`);
    expect(band(pane("left"))!.style.width).toBe(`${PROGRESS_EXTENT.committed}%`);
  });

  it("completing one pane's load does not clear the other's", () => {
    mount("left", "right");
    act(() => navSignal("left", "start"));
    act(() => navSignal("right", "start"));
    act(() => navSignal("left", "complete"));
    act(() => vi.advanceTimersByTime(PROGRESS_SPRINT_MS + PROGRESS_FADE_MS));
    expect(band(pane("left"))).toBeNull();
    expect(band(pane("right"))).not.toBeNull();
  });

  it("a closed pane's progress is dropped, not inherited", () => {
    mount("t1");
    act(() => navSignal("t1", "start"));
    act(() => forgetProgress("t1"));
    expect(band()).toBeNull();
    expect(progressFor("t1")).toBe(PROGRESS_IDLE);
  });
});

describe("prefers-reduced-motion", () => {
  it("renders a plain band with no glow class", () => {
    stubMotionPreference(true);
    mount("t1");
    act(() => navSignal("t1", "start"));
    const el = band()!;
    expect(el.classList.contains("glow")).toBe(false);
    expect(el.classList.contains("plain")).toBe(true);
  });

  it("renders the glow band when motion is welcome", () => {
    // The control for the row above: without it, a component that never
    // emits `glow` at all would pass the reduced-motion assertion.
    stubMotionPreference(false);
    mount("t1");
    act(() => navSignal("t1", "start"));
    const el = band()!;
    expect(el.classList.contains("glow")).toBe(true);
    expect(el.classList.contains("plain")).toBe(false);
  });

  it("the class rule itself keeps glow and plain mutually exclusive", () => {
    const started = advance(PROGRESS_IDLE, "start");
    expect(bandClasses(started, { reducedMotion: true })).not.toContain("glow");
    expect(bandClasses(started, { reducedMotion: false })).not.toContain("plain");
  });
});
