import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoadingState } from "./LoadingState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Only the clocks the component itself reads: React's own scheduling
  // (queueMicrotask / MessageChannel) must stay real or act() never flushes.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("LoadingState threshold", () => {
  it("shows nothing before 150ms and the spinner after", () => {
    act(() => {
      root.render(createElement(LoadingState, { label: "Starting the shell…" }));
    });
    expect(host.querySelector(".loading-state")).toBeNull();
    act(() => vi.advanceTimersByTime(149));
    expect(host.querySelector(".loading-state")).toBeNull();
    act(() => vi.advanceTimersByTime(2));
    const el = host.querySelector(".loading-state");
    expect(el).not.toBeNull();
    expect(el!.querySelector(".loading-spinner")).not.toBeNull();
    expect(el!.textContent).toContain("Starting the shell…");
    expect(el!.getAttribute("role")).toBe("status");
  });

  it("a task done at 149ms never flashes it", () => {
    act(() => {
      root.render(createElement(LoadingState, { label: "Reading…" }));
    });
    act(() => vi.advanceTimersByTime(149));
    // The task finished: the caller unmounts while still pending.
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(1000));
    expect(host.querySelector(".loading-state")).toBeNull();
  });

  it("delayMs 0 renders at once, and inline picks the inline form", () => {
    act(() => {
      root.render(
        createElement(LoadingState, { label: "Now", delayMs: 0, inline: true })
      );
    });
    const el = host.querySelector(".loading-state");
    expect(el).not.toBeNull();
    expect(el!.className).toContain("loading-state-inline");
  });

  it("block form is the default", () => {
    act(() => {
      root.render(createElement(LoadingState, { label: "Now", delayMs: 0 }));
    });
    expect(host.querySelector(".loading-state-block")).not.toBeNull();
  });
});
