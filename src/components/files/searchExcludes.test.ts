import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


// Monaco cannot load in the test environment (searchGlob.test.ts's mock,
// same reason); nothing under test touches it.
vi.mock("./CodeEditor", () => ({
  CodeEditor: () => null,
  disposeEditorState: () => {},
  languageFor: (p: string) => p,
  openEditorFind: () => false,
  currentEditorThemeName: () => "",
}));

// backend/fs.ts chooses the real-invoke branch at MODULE LOAD by reading
// the Tauri marker off the window — the hoisted block runs before the
// import graph does, so fsApi in this file talks to the mocked invoke
// instead of the demo fallback (the same trick configWriteback.test.ts
// plays, one import earlier because this gate is load-time, not call-time).
vi.hoisted(() => {
  (globalThis as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
});

const mocks = vi.hoisted(() => {
  const saved: { exclude: string[]; respect_gitignore: boolean }[] = [];
  return {
    saved,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "config_get") {
        const last = saved[saved.length - 1];
        return {
          values: last ? { files: last } : {},
          warnings: [],
          sources: [],
        };
      }
      if (cmd === "config_files_set") {
        saved.push({
          exclude: args?.exclude as string[],
          respect_gitignore: args?.respectGitignore as boolean,
        });
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  joinExcludeList,
  splitExcludeList,
  SearchPanel,
} from "./SearchPanel";
import { STR } from "../../strings";

describe("splitExcludeList / joinExcludeList", () => {
  it("splits on commas, trims, drops blanks — never errors", () => {
    expect(splitExcludeList("vendor, , build-*")).toEqual(["vendor", "build-*"]);
    expect(splitExcludeList("")).toEqual([]);
    expect(splitExcludeList("  one entry  ")).toEqual(["one entry"]);
  });

  it("round-trips through join without inventing or losing entries", () => {
    const entries = ["vendor", "*-generated"];
    expect(splitExcludeList(joinExcludeList(entries))).toEqual(entries);
  });
});

describe("SearchPanel's excluded-folders row", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    mocks.saved.length = 0;
    mocks.invoke.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  const panel = () => {
    flushSync(() => {
      root.render(
        createElement(SearchPanel, {
          root: "/work",
          includeHidden: false,
          onOpen: () => {},
          onSelectPaths: () => {},
        })
      );
    });
  };

  /** Await the mount's config read, then re-render once more so the
   *  loaded value is on screen — the read is a promise the panel keeps. */
  const openRow = async () => {
    panel();
    await vi.waitFor(() => {
      // The fold button carries a caret glyph beside its label, so the
      // match is on the title it owns, not the exact text it shows.
      const label = [...host.querySelectorAll("button")].find(
        (b) => b.title === STR.files.search.excludesRowHint
      );
      expect(label).toBeTruthy();
      flushSync(() => label!.click());
    });
    await vi.waitFor(() => {
      expect(host.querySelector<HTMLInputElement>(".excludes-row input")).toBeTruthy();
    });
    const input = host.querySelector<HTMLInputElement>(".excludes-row input")!;
    // The config read has landed by now; one more paint settles the input.
    await vi.waitFor(() => {
      expect(input.value).toBe(joinExcludeList(mocks.saved.at(-1)?.exclude ?? []));
    });
    return input;
  };

  it("loads the config's list into the row", async () => {
    mocks.saved.push({ exclude: ["vendor"], respect_gitignore: false });
    const input = await openRow();
    expect(input.value).toBe("vendor");
  });

  it("commits the parsed list on Enter, trimmed and blank-free", async () => {
    const input = await openRow();
    // The React way to type: the native setter, then the event the
    // controlled input listens for — assigning .value alone never reaches
    // the state the commit reads.
    const setVal = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    setVal.call(input, " vendor , , build-* ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Let the controlled input's state land before the key that reads it —
    // Enter in the same tick would commit the pre-typing value.
    await new Promise((r) => setTimeout(r, 0));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.saved.at(-1)).toEqual({
        exclude: ["vendor", "build-*"],
        respect_gitignore: false,
      });
    });
  });

  it("flips .gitignore through the toggle and restores defaults in one click", async () => {
    mocks.saved.push({ exclude: ["vendor"], respect_gitignore: false });
    await openRow();
    const git = [...host.querySelectorAll<HTMLButtonElement>(".excludes-row .mini-btn")].find(
      (b) => b.textContent === STR.files.search.excludesGitignore
    )!;
    flushSync(() => git.click());
    await vi.waitFor(() => {
      expect(mocks.saved.at(-1)?.respect_gitignore).toBe(true);
    });
    const reset = [...host.querySelectorAll<HTMLButtonElement>(".excludes-row .mini-btn")].find(
      (b) => b.textContent === STR.files.search.excludesRestore
    )!;
    flushSync(() => reset.click());
    await vi.waitFor(() => {
      expect(mocks.saved.at(-1)).toEqual({
        exclude: [],
        respect_gitignore: false,
      });
    });
    expect(host.querySelector<HTMLInputElement>(".excludes-row input")!.value).toBe("");
  });
});
