import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabKindOptionPresentation } from "./newTabPresentation";

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

function TerminalIcon({ size }: { size?: number }) {
  return <svg aria-hidden="true" data-size={size} />;
}

describe("TabKindOptionPresentation", () => {
  it("keeps icon, label, hint and interaction in one shared row", () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <TabKindOptionPresentation
          label="Terminal"
          hint="A shell session"
          Icon={TerminalIcon}
          iconSize={18}
          onSelect={onSelect}
          className="newtab-option"
          labelClassName="newtab-label"
          hintClassName="newtab-hint"
          leading={<kbd>1</kbd>}
          trailing={<kbd>⌘T</kbd>}
          dataDirectKey="1"
        />,
      );
    });

    const option = host.querySelector<HTMLButtonElement>('button[aria-label="Terminal"]');
    expect(option?.classList).toContain("workbench-new-tab-option");
    expect(option?.getAttribute("data-direct-key")).toBe("1");
    expect(option?.textContent).toContain("A shell session");
    expect(option?.querySelector(".workbench-new-tab-label")).not.toBeNull();
    expect(option?.querySelector(".workbench-new-tab-hint")).not.toBeNull();
    expect(option?.querySelector("svg")?.getAttribute("data-size")).toBe("18");
    act(() => option?.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
