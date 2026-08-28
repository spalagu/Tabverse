import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserDemoPane,
  BrowserNewTabPane,
  type BrowserNewTabPaneProps,
} from "./BrowserNewTabPane";

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
  overrides: Partial<BrowserNewTabPaneProps> = {},
): BrowserNewTabPaneProps {
  return {
    active: true,
    query: "exa",
    ghost: "mple.test",
    selectedIndex: 1,
    fallbackLabel: "Search for exa",
    sites: [{ title: "Example", host: "example.test" }],
    hints: {
      go: "Enter",
      pick: "Up/Down",
      complete: "Right/Tab",
      clear: "Escape",
    },
    onQueryChange: vi.fn(),
    onInputKeyDown: vi.fn(),
    onSelect: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
}

describe("BrowserNewTabPane", () => {
  it("owns the empty-tab input, rows and keyboard hints", () => {
    const view = props();
    act(() => root.render(<BrowserNewTabPane {...view} />));

    expect(document.activeElement).toBe(
      host.querySelector<HTMLInputElement>(".new-tab-input"),
    );
    expect(host.textContent).toContain("Search for exa");
    expect(host.textContent).toContain("Example");
    expect(host.textContent).toContain("Right/Tab");

    const site = host.querySelectorAll<HTMLButtonElement>(".new-tab-site")[1];
    act(() => site.click());
    expect(view.onRun).toHaveBeenCalledWith(1);
  });

  it("shows the no-history state without creating a fallback row", () => {
    act(() =>
      root.render(
        <BrowserNewTabPane
          {...props({ fallbackLabel: null, sites: [], query: "", ghost: "" })}
        />,
      ),
    );

    expect(host.textContent).toContain("Sites you visit will show up here.");
    expect(host.querySelector("[role=option]")).toBeNull();
  });

  it("owns the browser-only runtime fallback", () => {
    act(() => root.render(<BrowserDemoPane tabId="browser-1" />));

    expect(host.textContent).toContain("Tabverse");
    expect(host.textContent).toContain("Browser");
    expect(host.textContent).toContain("desktop app");
  });
});
