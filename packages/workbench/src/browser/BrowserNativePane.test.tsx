import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserNativePane, type BrowserNativePaneProps } from "./BrowserNativePane";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function props(
  overrides: Partial<BrowserNativePaneProps> = {},
): BrowserNativePaneProps {
  return {
    tabId: "browser-1",
    currentUrl: "https://example.test/current",
    barOpen: true,
    address: "https://example.test/next",
    onDismissAddress: vi.fn(),
    onAddressChange: vi.fn(),
    onCommitAddress: vi.fn(),
    onEscapeAddress: vi.fn(),
    findOpen: true,
    findQuery: "needle",
    findResult: { current: 2, total: 4, frames: 2 },
    onFindQueryChange: vi.fn(),
    onFind: vi.fn(),
    onCloseFind: vi.fn(),
    passwordOffer: { host: "example.test", username: "alice" },
    onAnswerPasswordOffer: vi.fn(),
    fillableLogins: null,
    onFillLogin: vi.fn(),
    onDismissFillableLogins: vi.fn(),
    error: null,
    navigationError: {
      kind: "certificate",
      host: "example.test",
      url: "https://example.test/current",
      message: "Untrusted certificate",
    },
    onRetryNavigation: vi.fn(),
    onProceedPastCertificate: vi.fn(),
    hostRef: createRef<HTMLDivElement>(),
    frozenFrame: { src: "data:image/png;base64,AA==" },
    freezeInset: 24,
    hints: {
      go: "Enter",
      reload: "Cmd+R",
      back: "Cmd+Left",
      forward: "Cmd+Right",
      zoom: "Cmd++",
      findNext: "Enter",
      findPrevious: "Shift+Enter",
      close: "Escape",
      location: "Cmd+L",
    },
    ...overrides,
  };
}

describe("BrowserNativePane", () => {
  it("owns address, find, password, certificate and frozen-page chrome", () => {
    const view = props();
    act(() => root.render(<BrowserNativePane {...view} />));

    expect(host.textContent).toContain("2/4");
    expect(host.textContent).toContain("alice");
    expect(host.textContent).toContain("Untrusted certificate");
    expect(host.querySelector<HTMLImageElement>(".page-freeze")?.style.left).toBe(
      "24px",
    );

    const address = host.querySelector<HTMLInputElement>(".cmdbar-input");
    act(() =>
      address?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(view.onCommitAddress).toHaveBeenCalledWith(
      "https://example.test/next",
    );

    const find = host.querySelector<HTMLInputElement>(".findbar-input");
    act(() =>
      find?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(view.onFind).toHaveBeenCalledWith(true);

    const save = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    act(() => save?.click());
    expect(view.onAnswerPasswordOffer).toHaveBeenCalledWith(true);

    const proceed = host.querySelector<HTMLButtonElement>(".cert-block .danger");
    act(() => proceed?.click());
    expect(view.onProceedPastCertificate).toHaveBeenCalledOnce();
  });
});
