import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionPopup } from "./CompletionPopup";
import { STR } from "../../strings";
import type { CompletionOffer } from "../../term/completionSpec";


const flags: CompletionOffer = {
  kind: "flags",
  command: "git",
  word: "--",
  items: ["--all", "--amend", "--branch"],
};

const files: CompletionOffer = { kind: "files", word: "~/Doc" };

let root: Root | null = null;
let host: HTMLElement | null = null;
const picked = vi.fn();

function mount(offer: CompletionOffer, selected: number): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(
      createElement(CompletionPopup, {
        offer,
        selected,
        onPick: picked,
      })
    )
  );
}

afterEach(() => {
  if (root && host) flushSync(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  picked.mockClear();
});

describe("a flags offer", () => {
  it("draws the items with the command's name over them", () => {
    mount(flags, 0);
    const items = [...host!.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["--all", "--amend", "--branch"]);
    expect(host!.textContent).toContain(
      STR.term.completionFlagsTitle({ command: "git" })
    );
  });

  it("highlights the selected row and no other", () => {
    mount(flags, 1);
    const sel = host!.querySelectorAll("li.selected");
    expect(sel).toHaveLength(1);
    expect(sel[0].textContent).toBe("--amend");
  });

  it("a mousedown on a row picks that row's item", () => {
    mount(flags, 2);
    flushSync(() =>
      host!.querySelectorAll("li")[2].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    );
    expect(picked).toHaveBeenCalledWith("--branch");
  });
});

describe("a files offer (future placeholder)", () => {
  it("renders nothing so the command line stays unobstructed", () => {
    mount(files, 0);
    expect(host!.querySelector(".term-completion-popup")).toBeNull();
    expect(host!.textContent).toBe("");
    expect(picked).not.toHaveBeenCalled();
  });
});
