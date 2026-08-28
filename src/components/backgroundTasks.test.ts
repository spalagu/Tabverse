import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { BackgroundTasksSection } from "./BackgroundTasksSection";
import { sessionSnapshot, useStore, type BackgroundTask } from "../state/store";

const task = (id: string): BackgroundTask => ({
  id,
  generation: 2,
  cwd: "/work/project",
  exited: undefined,
  attached: false,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockClear();
  useStore.setState({ tabs: [], activeTabId: null, backgroundTasks: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("background terminal tasks", () => {
  it("renders every helper record and attaches one through a real terminal tab", async () => {
    useStore.getState().setBackgroundTasks([task("11".repeat(16)), task("22".repeat(16))]);
    await act(async () => root.render(createElement(BackgroundTasksSection)));
    expect(host.querySelectorAll("[data-background-task]")).toHaveLength(2);
    await act(async () =>
      (host.querySelector("button.btn") as HTMLButtonElement).click()
    );
    const tab = useStore.getState().tabs[0];
    expect(tab.type).toBe("terminal");
    expect(tab.attachSessionId).toBe("11".repeat(16));
    expect(useStore.getState().backgroundTasks.map((item) => item.id)).toEqual([
      "22".repeat(16),
    ]);
  });

  it("terminates by helper session id and removes the row", async () => {
    const id = "33".repeat(16);
    useStore.getState().setBackgroundTasks([task(id)]);
    await act(async () => root.render(createElement(BackgroundTasksSection)));
    const buttons = host.querySelectorAll("button");
    await act(async () => (buttons[1] as HTMLButtonElement).click());
    expect(invoke).toHaveBeenCalledWith("term_kill", { id });
    expect(useStore.getState().backgroundTasks).toEqual([]);
  });

  it("does not duplicate helper truth into session.json", () => {
    useStore.getState().setBackgroundTasks([task("44".repeat(16))]);
    expect(JSON.stringify(sessionSnapshot(useStore.getState()))).not.toContain(
      "backgroundTasks"
    );
  });
});
