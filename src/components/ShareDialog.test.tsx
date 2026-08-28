import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";


const mocks = vi.hoisted(() => ({
  startShare: vi.fn(async (): Promise<void> => {}),
  stopShare: vi.fn(async (): Promise<void> => {}),
  kickViewer: vi.fn(async (): Promise<boolean> => true),
  setViewerAccess: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("../share/framework/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../share/framework/actions")>()),
  startShare: mocks.startShare,
  stopShare: mocks.stopShare,
  kickViewer: mocks.kickViewer,
  setViewerAccess: mocks.setViewerAccess,
}));

// The declarations the dialog reads; registered exactly as bootstrap does.
import "../share/capabilities";
import { ShareDialog } from "./ShareDialog";
import { SHARE_TTL_SECS } from "../share/framework/actions";
import { useStore, type ShareState } from "../state/store";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  for (const fn of Object.values(mocks)) fn.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ tabs: [], activeTabId: null, shareDialogTabId: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Add a tab of the given type, open the dialog on it, render. */
function openOn(type: "terminal" | "agent"): string {
  const id = useStore.getState().addTab({ type });
  act(() => {
    useStore.getState().setShareDialogTab(id);
    root.render(<ShareDialog />);
  });
  return id;
}

function shareOf(viewers: ShareState["viewers"]): ShareState {
  return {
    shareId: "s1",
    ticket: "tabv-ticket-xyz",
    joinLink: "https://spalagu.github.io/Tabverse/join/#tabv-ticket-xyz",
    access: "steer",
    viewers,
    ttlSecs: 86_400,
    startedAt: Date.now(),
  };
}

function radios(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>(
    'input[name="share-access"]'
  )];
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text
  );
  expect(btn, `button "${text}"`).toBeDefined();
  return btn as HTMLButtonElement;
}

function setSelect(el: HTMLSelectElement, value: string): Promise<void> {
  return act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("capability-driven level options", () => {
  it("a terminal offers exactly view and steer, defaulting to steer", () => {
    openOn("terminal");
    expect(radios().map((r) => r.value)).toEqual(["view", "steer"]);
    expect(radios().find((r) => r.checked)?.value).toBe("steer");
  });

  it("an agent offers view, steer and approve, defaulting to view", () => {
    openOn("agent");
    expect(radios().map((r) => r.value)).toEqual(["view", "steer", "approve"]);
    expect(radios().find((r) => r.checked)?.value).toBe("view");
  });

  it("reopening on another type re-reads that type's default", () => {
    openOn("terminal");
    expect(radios().find((r) => r.checked)?.value).toBe("steer");
    const agentId = useStore.getState().addTab({ type: "agent" });
    act(() => useStore.getState().setShareDialogTab(agentId));
    expect(radios().find((r) => r.checked)?.value).toBe("view");
  });
});

describe("the start flow", () => {
  it("passes the chosen level and join window to startShare", async () => {
    const id = openOn("terminal");
    await act(async () => radios()[0].click()); // view
    const ttl = container.querySelector<HTMLSelectElement>("#share-ttl-select");
    expect(ttl?.value).toBe(String(SHARE_TTL_SECS)); // 24h default
    await setSelect(ttl!, "3600");
    await act(async () => buttonByText("Start sharing").click());
    expect(mocks.startShare).toHaveBeenCalledWith(id, {
      access: "view",
      ttlSecs: 3_600,
    });
  });

  it("passes the explicit no-expiry choice as null", async () => {
    const id = openOn("agent");
    const ttl = container.querySelector<HTMLSelectElement>("#share-ttl-select");
    await setSelect(ttl!, "never");
    await act(async () => buttonByText("Start sharing").click());
    expect(mocks.startShare).toHaveBeenCalledWith(id, {
      access: "view",
      ttlSecs: null,
    });
  });
});

describe("the shared state", () => {
  function openShared(
    type: "terminal" | "agent",
    viewers: ShareState["viewers"]
  ): string {
    const id = useStore.getState().addTab({ type });
    useStore.getState().setTabShare(id, shareOf(viewers));
    act(() => {
      useStore.getState().setShareDialogTab(id);
      root.render(<ShareDialog />);
    });
    return id;
  }

  const twoViewers: ShareState["viewers"] = [
    { id: 1, name: "tabverse@mbp", access: "steer" },
    { id: 2, name: "Safari (web)", access: "view" },
  ];

  it("leads with the join link, before the raw ticket", () => {
    openShared("terminal", twoViewers);
    const link = container.querySelector<HTMLInputElement>("#share-link-input");
    const ticket =
      container.querySelector<HTMLTextAreaElement>("#share-ticket-area");
    expect(link?.value).toBe(
      "https://spalagu.github.io/Tabverse/join/#tabv-ticket-xyz"
    );
    expect(ticket?.value).toBe("tabv-ticket-xyz");
    // The decreed order: the join-page link is the primary hand-off.
    expect(
      link!.compareDocumentPosition(ticket!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders the roster: names, current levels, declared options only", () => {
    openShared("terminal", twoViewers);
    const rows = [...container.querySelectorAll(".share-viewer-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("tabverse@mbp");
    expect(rows[1].textContent).toContain("Safari (web)");
    const selects = rows.map((r) =>
      r.querySelector<HTMLSelectElement>("select")
    );
    expect(selects.map((s) => s?.value)).toEqual(["steer", "view"]);
    // A terminal's dropdown must not offer approve — declared levels only.
    expect(
      [...selects[0]!.querySelectorAll("option")].map((o) => o.value)
    ).toEqual(["view", "steer"]);
  });

  it("an agent roster's dropdown offers all three declared levels", () => {
    openShared("agent", twoViewers);
    const sel = container.querySelector<HTMLSelectElement>(
      ".share-viewer-access"
    );
    expect([...sel!.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "view",
      "steer",
      "approve",
    ]);
  });

  it("falls back to Viewer #id when the Hello carried no name", () => {
    openShared("terminal", [{ id: 7, name: "", access: "view" }]);
    expect(
      container.querySelector(".share-viewer-name")?.textContent
    ).toBe("Viewer #7");
  });

  it("a roster dropdown change fires setViewerAccess for that viewer", async () => {
    const id = openShared("terminal", twoViewers);
    const rows = [...container.querySelectorAll(".share-viewer-row")];
    const second = rows[1].querySelector<HTMLSelectElement>("select");
    await setSelect(second!, "steer");
    expect(mocks.setViewerAccess).toHaveBeenCalledWith(id, 2, "steer");
    // Not optimistic: the store row still says what presence last said.
    expect(second!.value).toBe("view");
  });

  it("Remove fires kickViewer for that row's viewer", async () => {
    const id = openShared("terminal", twoViewers);
    const rows = [...container.querySelectorAll(".share-viewer-row")];
    await act(async () =>
      rows[0].querySelector("button")!.click()
    );
    expect(mocks.kickViewer).toHaveBeenCalledWith(id, 1);
  });

  it("Copy link puts the join link on the clipboard", async () => {
    openShared("terminal", twoViewers);
    const writeText = vi.fn(async (): Promise<void> => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await act(async () => buttonByText("Copy link").click());
    expect(writeText).toHaveBeenCalledWith(
      "https://spalagu.github.io/Tabverse/join/#tabv-ticket-xyz"
    );
  });

  it("Stop sharing stops, then closes the dialog", async () => {
    const id = openShared("terminal", twoViewers);
    await act(async () => buttonByText("Stop sharing").click());
    expect(mocks.stopShare).toHaveBeenCalledWith(id);
    expect(useStore.getState().shareDialogTabId).toBe(null);
  });
});
