import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined
  )
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { BackgroundTasksSection } from "./BackgroundTasksSection";
import { flushConfigWrites, RESIDENT_KEYS } from "../state/config";
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
  invoke.mockImplementation(async () => undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useStore.setState({ tabs: [], activeTabId: null, backgroundTasks: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("background terminal tasks", () => {
  it("renders every helper record and attaches one through a real terminal tab", async () => {
    useStore.getState().setBackgroundTasks([task("11".repeat(16)), task("22".repeat(16))]);
    await act(async () => root.render(createElement(BackgroundTasksSection)));
    expect(host.querySelectorAll("[data-background-task]")).toHaveLength(2);
    await act(async () =>
      (host.querySelector("[data-background-task] button.btn") as HTMLButtonElement).click()
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
    const buttons = host.querySelectorAll("[data-background-task] button");
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

  it("reads and writes the app-wide resident default through its own config key", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "config_get") {
        return {
          values: {
            appearance: { theme: "light", sidebar_width: 248, sidebar_pinned: true },
            browser: {
              search_engine: "duckduckgo",
              custom_search_template: "",
              archive_after: "24h",
            },
            resident: { default: false },
          },
          warnings: [],
          sources: ["/fixture/config.toml"],
        };
      }
      return undefined;
    });
    await act(async () => root.render(createElement(BackgroundTasksSection)));
    const control = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(
        `[data-setting-key="${RESIDENT_KEYS.default}"]`
      );
      expect(button?.disabled).toBe(false);
      return button!;
    });
    await act(async () => control.click());
    await flushConfigWrites();
    expect(invoke).toHaveBeenCalledWith("config_set", {
      key: RESIDENT_KEYS.default,
      value: true,
    });
  });
});
