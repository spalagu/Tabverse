import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import {
  SEARCH_HISTORY_LIMIT,
  rememberSearch,
  resetSearchHistoryForTest,
  searchHistory,
} from "../../term/searchHistory";
import { SearchBar } from "./SearchBar";


/** The screen the match tests search: "foo" alone, "foobar", "foo" alone. */
const SCREEN = "foo bar\r\nfoobar\r\nfoo\r\n";

interface Harness {
  host: HTMLElement;
  input: HTMLInputElement;
  count: () => string;
  toggle: (glyph: string) => void;
  press: (key: string) => void;
  close: () => void;
}

let root: Root | null = null;
let search: SearchAddon;
let term: Terminal;
let el: HTMLElement;

/** A real terminal with real content, opened into a hidden div. */
function openTerminal(): void {
  el = document.createElement("div");
  el.style.display = "none";
  document.body.appendChild(el);
  term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  term.open(el);
  search = new SearchAddon();
  term.loadAddon(search);
}

/** (Re)mount the bar — the remount IS the "close and reopen" of the
 * history criterion, which is why nothing of the bar survives between
 * mounts except the module-level ring. */
function mountBar(): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(createElement(SearchBar, { search, onClose: () => {} }))
  );
  const input = host.querySelector<HTMLInputElement>(".search-input")!;
  return {
    host,
    input,
    count: () => {
      const text =
        host.querySelector<HTMLSpanElement>(".search-count")!.textContent ??
        "";
      // The TOTAL is the judged half; which match is active ("2/2" vs
      // "1/2") depends on where the walk stands after a toggle re-finds,
      // which is the addon's own stepping and not this feature's claim.
      return text.includes("/") ? text.split("/")[1] : text;
    },
    toggle: (glyph: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === glyph)!;
      flushSync(() => button.click());
    },
    press: (key: string) => {
      flushSync(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true })
        )
      );
    },
    close: () => {
      flushSync(() => root!.unmount());
      root = null;
      host.remove();
    },
  };
}

/** Type into the box the way a person does: per value, native setter. */
function type(h: Harness, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  flushSync(() => {
    setter.call(h.input, value);
    h.input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Type and press Enter — the commit a remembered query rides on. */
function commit(h: Harness, query: string): void {
  type(h, query);
  h.press("Enter");
}

beforeEach(async () => {
  // The ring is module state; one test's queries must not be the next
  // test's starting history. This is the reset the criterion names.
  resetSearchHistoryForTest();
  openTerminal();
  // xterm parses writes asynchronously — the screen must actually be in
  // the buffer before any search asks about it.
  await new Promise<void>((resolve) => term.write(SCREEN, resolve));
});

afterEach(() => {
  term.dispose();
  el.remove();
  term = undefined!;
  el = undefined!;
  search = undefined!;
});

describe("the whole-word switch", () => {
  it("matches 'foo' but not 'foobar' when on, and both when off", () => {
    const h = mountBar();

    // Off (the control): the substring reaches all three lines.
    type(h, "foo");
    expect(h.count(), "three lines carry the substring").toBe("3");

    // On: "foobar" stops matching — the positive and the negative in one
    // flip, asked of real buffer lines.
    h.toggle("ab");
    expect(h.count(), "only the bare foos match").toBe("2");
    h.close();
  });
});

describe("the regex switch", () => {
  it("reads \\bfoo\\b as a pattern when on, as text when off", () => {
    const h = mountBar();

    // Off: the query is literal characters, and no line contains a
    // backslash — zero matches is the negative half.
    type(h, "\\bfoo\\b");
    expect(h.count(), "nothing matches").toBe("0");

    // On: the same query is a pattern matching the two bare "foo"s.
    h.toggle(".*");
    expect(h.count(), "only the bare foos match").toBe("2");
    h.close();
  });

  it("holds at no results for a pattern that does not compile", () => {
    const h = mountBar();
    h.toggle(".*");
    type(h, "(");
    expect(h.count(), "nothing matches").toBe("0");
    // The bar is still alive and usable: a fixed pattern finds again.
    type(h, "(foo)");
    expect(h.count(), "three lines carry the substring").toBe("3");
    h.close();
  });
});

describe("search history (session-scoped, never component state)", () => {
  it("recalls the last committed query after the bar is closed and reopened", () => {
    const first = mountBar();
    commit(first, "cargo build");
    first.close();

    // A fresh mount is the criterion's whole point: the bar's component
    // state is gone, and ↑ must still find the query.
    const second = mountBar();
    expect(second.input.value).toBe("");
    second.press("ArrowUp");
    expect(second.input.value).toBe("cargo build");
    second.close();
  });

  it("walks further back on repeated ↑", () => {
    const first = mountBar();
    commit(first, "cargo build");
    commit(first, "npm test");
    first.close();

    const second = mountBar();
    second.press("ArrowUp");
    expect(second.input.value).toBe("npm test");
    second.press("ArrowUp");
    expect(second.input.value).toBe("cargo build");
    second.close();
  });

  it("moves a repeat to the end instead of keeping it twice", () => {
    const first = mountBar();
    commit(first, "cargo build");
    commit(first, "npm test");
    commit(first, "cargo build");
    first.close();

    expect([...searchHistory()]).toEqual(["npm test", "cargo build"]);
    const second = mountBar();
    second.press("ArrowUp");
    expect(second.input.value).toBe("cargo build");
    second.press("ArrowUp");
    expect(second.input.value).toBe("npm test");
    second.close();
  });

  it("keeps only the most recent commits, up to the ring's limit", () => {
    // The cap is judged on the ring directly: walking it with ↑ twenty
    // times would test the key handler, not the bound.
    for (let i = 1; i <= SEARCH_HISTORY_LIMIT + 5; i++) {
      rememberSearch(`query ${i}`);
    }
    const h = searchHistory();
    expect(h.length).toBe(SEARCH_HISTORY_LIMIT);
    expect(h[0]).toBe("query 6");
    expect(h[h.length - 1]).toBe(`query ${SEARCH_HISTORY_LIMIT + 5}`);
  });

  it("is empty again after the test reset", () => {
    // The beforeEach reset is itself load-bearing (it is what keeps this
    // file's tests independent), so its effect is asserted once, here.
    expect(searchHistory()).toEqual([]);
    const h = mountBar();
    h.press("ArrowUp");
    expect(h.input.value).toBe("");
    h.close();
  });
});
