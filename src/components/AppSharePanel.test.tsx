import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";


const mocks = vi.hoisted(() => ({
  startAppShare: vi.fn(async (): Promise<void> => {}),
  stopAppShare: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("../share/framework/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../share/framework/actions")>()),
  startAppShare: mocks.startAppShare,
  stopAppShare: mocks.stopAppShare,
}));

import { runAppCommand } from "../appCommands";
import { AppSharePanel } from "./AppSharePanel";
import { anyOverlayOpen, useStore, type ShareState } from "../state/store";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  for (const fn of Object.values(mocks)) fn.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    tabs: [],
    activeTabId: null,
    shareDialogTabId: null,
    appShare: null,
    appSharePanelOpen: false,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function appShareOf(viewers: ShareState["viewers"]): ShareState {
  return {
    shareId: "s-app",
    ticket: "tabv-ticket-app",
    joinLink: "https://spalagu.github.io/Tabverse/join/#tabv-ticket-app",
    access: "steer",
    viewers,
    ttlSecs: 86_400,
    startedAt: Date.now(),
  };
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text
  );
  expect(btn, `button "${text}"`).toBeDefined();
  return btn as HTMLButtonElement;
}

describe("the command-bar entrances", () => {
  it("share-app raises the panel on its confirm face; nothing starts until Start sharing", () => {
    act(() => {
      runAppCommand("share-app");
      root.render(<AppSharePanel />);
    });
    // The command is only the door now: the level and window are chosen
    // on the panel itself, the tab dialog's ask-then-start contract.
    expect(mocks.startAppShare).not.toHaveBeenCalled();
    expect(useStore.getState().appSharePanelOpen).toBe(true);
    expect(container.querySelector(".app-share-panel")).not.toBeNull();
    expect(buttonByText("Start sharing")).toBeDefined();
  });

  it("share-app with a share already live only raises the panel", () => {
    useStore.setState({ appShare: appShareOf([]) });
    act(() => {
      runAppCommand("share-app");
      root.render(<AppSharePanel />);
    });
    // The core refuses a second app share; the command must not even ask.
    expect(mocks.startAppShare).not.toHaveBeenCalled();
    expect(useStore.getState().appSharePanelOpen).toBe(true);
  });

  it("stop-app-share stops the live share and takes the panel down", () => {
    useStore.setState({ appShare: appShareOf([]), appSharePanelOpen: true });
    act(() => {
      runAppCommand("stop-app-share");
    });
    expect(mocks.stopAppShare).toHaveBeenCalledTimes(1);
    expect(useStore.getState().appSharePanelOpen).toBe(false);
  });

  it("stop-app-share with nothing live does nothing, quietly", () => {
    act(() => {
      runAppCommand("stop-app-share");
    });
    expect(mocks.stopAppShare).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    act(() => root.render(<AppSharePanel />));
    expect(container.querySelector(".app-share-panel")).toBeNull();
  });

  it("an open panel parks a frontmost browser page (anyOverlayOpen)", () => {
    expect(anyOverlayOpen(useStore.getState())).toBe(false);
    useStore.getState().setAppSharePanel(true);
    expect(anyOverlayOpen(useStore.getState())).toBe(true);
    useStore.getState().setAppSharePanel(false);
    expect(anyOverlayOpen(useStore.getState())).toBe(false);
  });
});

describe("the confirm face", () => {
  function openConfirm(): void {
    useStore.setState({ appShare: null, appSharePanelOpen: true });
    act(() => root.render(<AppSharePanel />));
  }

  it("offers the app pair's two levels and the tab dialog's four windows", () => {
    openConfirm();
    const radios = [
      ...container.querySelectorAll<HTMLInputElement>('input[name="app-share-access"]'),
    ];
    expect(radios.map((r) => r.value)).toEqual(["view", "steer"]);
    expect(radios.find((r) => r.checked)?.value).toBe("steer");
    const ttl = container.querySelector<HTMLSelectElement>("#app-share-ttl-select");
    expect(ttl).not.toBeNull();
    expect([...ttl!.options].map((o) => o.value)).toEqual([
      "3600",
      "28800",
      "86400",
      "never",
    ]);
    expect(ttl!.value).toBe("86400");
  });

  it("Start sharing sends the chosen level and window, and the panel stays up", async () => {
    openConfirm();
    act(() => {
      container
        .querySelector<HTMLInputElement>('input[name="app-share-access"][value="view"]')!
        .click();
      const ttl = container.querySelector<HTMLSelectElement>("#app-share-ttl-select")!;
      ttl.value = "never";
      ttl.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => buttonByText("Start sharing").click());
    expect(mocks.startAppShare).toHaveBeenCalledTimes(1);
    expect(mocks.startAppShare).toHaveBeenCalledWith({
      access: "view",
      ttlSecs: null,
    });
    expect(useStore.getState().appSharePanelOpen).toBe(true);
  });

  it("untouched choices start with the declared defaults", async () => {
    openConfirm();
    await act(async () => buttonByText("Start sharing").click());
    expect(mocks.startAppShare).toHaveBeenCalledWith({
      access: "steer",
      ttlSecs: 86_400,
    });
  });

  it("a refused start leaves the confirm face up with the retry", async () => {
    mocks.startAppShare.mockRejectedValueOnce(new Error("relay down"));
    openConfirm();
    await act(async () => buttonByText("Start sharing").click());
    expect(mocks.startAppShare).toHaveBeenCalledTimes(1);
    expect(useStore.getState().appSharePanelOpen).toBe(true);
    expect(buttonByText("Start sharing")).toBeDefined();
  });

  it("reopening resets to the defaults, not the last opening's choices", async () => {
    openConfirm();
    act(() => {
      container
        .querySelector<HTMLInputElement>('input[name="app-share-access"][value="view"]')!
        .click();
    });
    // Close, then come back: the previous opening's View must not linger.
    act(() => useStore.getState().setAppSharePanel(false));
    act(() => useStore.getState().setAppSharePanel(true));
    const checked = container.querySelector<HTMLInputElement>(
      'input[name="app-share-access"]:checked'
    );
    expect(checked?.value).toBe("steer");
  });
});

describe("the shared face", () => {
  function openShared(viewers: ShareState["viewers"]): void {
    useStore.setState({ appShare: appShareOf(viewers), appSharePanelOpen: true });
    act(() => root.render(<AppSharePanel />));
  }

  it("shows the join link and the raw ticket the store holds", () => {
    openShared([]);
    expect(
      container.querySelector<HTMLInputElement>("#app-share-link-input")?.value
    ).toBe("https://spalagu.github.io/Tabverse/join/#tabv-ticket-app");
    expect(
      container.querySelector<HTMLTextAreaElement>("#app-share-ticket-area")
        ?.value
    ).toBe("tabv-ticket-app");
  });

  it("the roster counts and names what presence wrote, levels shown not chosen", () => {
    openShared([
      { id: 1, name: "tabverse@mbp", access: "steer" },
      { id: 2, name: "Safari (web)", access: "view" },
    ]);
    expect(
      container.querySelector(".app-share-roster-head")?.textContent
    ).toBe("Watching now — 2 viewers");
    const rows = [...container.querySelectorAll(".app-share-viewer-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("tabverse@mbp");
    expect(rows[0].textContent).toContain("Steer");
    expect(rows[1].textContent).toContain("Safari (web)");
    expect(rows[1].textContent).toContain("View");
    expect(container.querySelector("select")).toBeNull();
  });

  it("falls back to Viewer #id when the Hello carried no name", () => {
    openShared([{ id: 7, name: "", access: "view" }]);
    expect(
      container.querySelector(".app-share-viewer-row")?.textContent
    ).toContain("Viewer #7");
  });

  it("an empty roster says so, without the count line", () => {
    openShared([]);
    expect(
      container.querySelector(".share-viewers-empty")?.textContent
    ).toBe("No one is watching yet");
    expect(container.querySelector(".app-share-roster-head")).toBeNull();
  });

  it("Stop sharing stops, then closes the panel", async () => {
    openShared([]);
    await act(async () => buttonByText("Stop sharing").click());
    expect(mocks.stopAppShare).toHaveBeenCalledTimes(1);
    expect(useStore.getState().appSharePanelOpen).toBe(false);
  });

  it("Copy link puts the join link on the clipboard", async () => {
    openShared([]);
    const writeText = vi.fn(async (): Promise<void> => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await act(async () => buttonByText("Copy link").click());
    expect(writeText).toHaveBeenCalledWith(
      "https://spalagu.github.io/Tabverse/join/#tabv-ticket-app"
    );
  });
});
