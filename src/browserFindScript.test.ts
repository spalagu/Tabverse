import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STR } from "./strings";


// happy-dom rewrites import.meta.url to a non-file scheme, so resolve the
// Rust source from the vitest root (where vitest.config.ts lives).
const LIB_PATH = join(process.cwd(), "src-tauri/src/lib.rs");
const LIB_RS = readFileSync(LIB_PATH, "utf8");
const BEGIN = 'const FIND_SCRIPT: &str = r#"';
const begin = LIB_RS.indexOf(BEGIN);
const end = begin === -1 ? -1 : LIB_RS.indexOf('"#;', begin);
if (begin === -1 || end === -1) {
  throw new Error(
    "FIND_SCRIPT not found in src-tauri/src/lib.rs — test harness is stale"
  );
}
const FIND_SCRIPT = LIB_RS.slice(begin + BEGIN.length, end);

/** Fill placeholders exactly as find_script_for does, with dummy colors. */
function findJs(query: string, backwards = false): string {
  const q = JSON.stringify(query);
  return FIND_SCRIPT.replace("__TABVERSE_BACK__", String(backwards))
    .replace("__TABVERSE_FIND_BG__", "#111111")
    .replace("__TABVERSE_FIND_FG__", "#eeeeee")
    .replace("__TABVERSE_FIND_CUR_BG__", "#222222")
    .replace("__TABVERSE_FIND_CUR_FG__", "#ffffff")
    .replace("__TABVERSE_QUERY__", q);
}

/** What the cancelled navigation carried — the one report per find action. */
let navigated = "";

function run(query: string, backwards = false): void {
  // Indirect eval: global scope, the way wv.eval runs it — no closure over
  // this file's bindings.
  (0, eval)(findJs(query, backwards));
}

/** Params of the reported tabverse-cmd url, as the core's parser sees them. */
function reported(): { n: number[]; f: number; i: number } {
  expect(navigated.startsWith("tabverse-cmd:find-result?"), navigated).toBe(
    true
  );
  const n: number[] = [];
  let f = -1;
  let i = -1;
  for (const part of navigated
    .slice("tabverse-cmd:find-result?".length)
    .split("&")) {
    const [k, v] = part.split("=");
    if (k === "n") n.push(Number(v));
    else if (k === "f") f = Number(v);
    else if (k === "i") i = Number(v);
  }
  return { n, f, i };
}

/** Layout, which happy-dom does not have: every range renders one box. */
function stubClientRects(): void {
  const patch = (w: Window) => {
    const R = (w as unknown as { Range?: { prototype: unknown } }).Range;
    if (R && R.prototype) {
      Object.defineProperty(R.prototype, "getClientRects", {
        configurable: true,
        value: () => [{}],
      });
    }
  };
  const walk = (doc: Document) => {
    patch(doc.defaultView as Window);
    for (const f of Array.from(doc.querySelectorAll("iframe"))) {
      try {
        const cd = (f as HTMLIFrameElement).contentDocument;
        if (cd) walk(cd);
      } catch {
        /* a cross-origin frame — exactly the wall under test */
      }
    }
  };
  walk(document);
}

/** The thinnest Custom-Highlight-API stand-in: enough for the script's own
 *  per-document placement decisions to be observable, nothing about the
 *  engine's painting. */
type HlWindow = Window & {
  CSS: { highlights: Map<string, { ranges: unknown[] }> };
  Highlight: new () => { ranges: unknown[] };
};

function polyfillHighlights(w: Window): asserts w is HlWindow {
  const scope = w as unknown as Record<string, unknown>;
  // defineProperty: happy-dom's window exposes CSS as a getter-only
  // property, and a plain assignment bounces off it.
  Object.defineProperty(scope, "CSS", {
    configurable: true,
    value: { highlights: new Map() },
  });
  Object.defineProperty(scope, "Highlight", {
    configurable: true,
    value: class {
      ranges: unknown[] = [];
      add(r: unknown) {
        this.ranges.push(r);
      }
    },
  });
}

interface Fixture {
  same: HTMLIFrameElement;
  nested: HTMLIFrameElement;
  crossNull: HTMLIFrameElement;
  crossThrow: HTMLIFrameElement;
}

/** The page: matches in the top document and in two same-origin frames,
 *  plus two cross-origin frames whose (unreachable) content matches too. */
function page(): Fixture {
  document.body.innerHTML = "";
  const p = (doc: Document, text: string) => {
    const el = doc.createElement("p");
    el.textContent = text;
    doc.body.appendChild(el);
  };
  p(document, "alpha alpha");
  const same = document.createElement("iframe");
  document.body.appendChild(same);
  p(document, "alpha");
  p(same.contentDocument!, "alpha");
  const nested = same.contentDocument!.createElement("iframe");
  same.contentDocument!.body.appendChild(nested);
  p(nested.contentDocument!, "alpha alpha alpha");
  p(nested.contentDocument!, "zeta");

  // Cross-origin frames: the parent's script gets null (the usual answer)
  // or a throw (some engines' access paths). Their real documents carry
  // matches, so a finder that wrongly reached them would count them.
  const crossNull = document.createElement("iframe");
  document.body.appendChild(crossNull);
  p(crossNull.contentDocument!, "alpha alpha alpha alpha");
  Object.defineProperty(crossNull, "contentDocument", {
    configurable: true,
    get: () => null,
  });
  const crossThrow = document.createElement("iframe");
  document.body.appendChild(crossThrow);
  p(crossThrow.contentDocument!, "alpha");
  Object.defineProperty(crossThrow, "contentDocument", {
    configurable: true,
    get: () => {
      throw new Error(
        "Blocked a frame with origin ... from accessing a cross-origin frame"
      );
    },
  });
  return { same, nested, crossNull, crossThrow };
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as { __tabverseFind?: unknown }).__tabverseFind;
  navigated = "";
  // Capture the report the way the cancelled-navigation channel delivers
  // it: the url the script assigns, nothing else.
  const holder: Record<string, unknown> = {};
  Object.defineProperty(holder, "href", {
    get: () => navigated,
    set: (v: string) => {
      navigated = v;
    },
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: holder,
  });
});

describe("the finder script across frames", () => {
  it("counts the top document and each same-origin frame, in depth-first order", () => {
    page();
    stubClientRects();
    run("alpha");
    // Top: 3 hits. Same-origin child: 1. Nested same-origin: 3. The two
    // cross-origin frames are not searched and not counted — not even as
    // zero-count frames: the report says which frames were IN the search.
    expect(reported()).toEqual({ n: [3, 1, 3], f: 3, i: 1 });
  });

  it("advances and wraps over the flattened order of all frames", () => {
    page();
    stubClientRects();
    run("alpha");
    run("alpha");
    expect(reported().i).toBe(2); // still inside the top document
    // Step to the end of the flattened list, then wrap.
    for (let k = 0; k < 5; k++) run("alpha");
    expect(reported()).toEqual({ n: [3, 1, 3], f: 3, i: 7 });
    run("alpha");
    expect(reported().i).toBe(1);
  });

  it("steps backwards across the frame boundary and wraps to the last", () => {
    page();
    stubClientRects();
    run("alpha", true);
    expect(reported().i).toBe(1);
    run("alpha", true);
    // One step back from the first match is the last match overall — which
    // lives in the nested frame.
    expect(reported().i).toBe(7);
  });

  it("reports a zero-count frame as searched, and lands on a child-frame match", () => {
    const fx = page();
    stubClientRects();
    run("zeta");
    // Only the nested frame has "zeta": the other two are still reported,
    // as zero — the frame count is the search's scope, not its hits.
    expect(reported()).toEqual({ n: [0, 0, 1], f: 3, i: 1 });
    // Without the Custom Highlight API the current match is at least
    // selected — through the OWNING document's selection, since a selection
    // cannot take another document's range.
    const sel = (
      fx.nested.contentDocument!.defaultView as Window
    ).getSelection();
    expect(sel?.rangeCount).toBe(1);
  });

  it("registers highlights per document, the current one only where it lives", () => {
    const fx = page();
    stubClientRects();
    polyfillHighlights(window);
    polyfillHighlights(fx.same.contentWindow as Window);
    polyfillHighlights(fx.nested.contentWindow as Window);
    // The cross-origin frames get no polyfill, and the script must not
    // touch them at all.
    run("alpha");
    run("alpha");
    run("alpha");
    run("alpha");
    const top = window as unknown as HlWindow;
    const same = fx.same.contentWindow as unknown as HlWindow;
    const nested = fx.nested.contentWindow as unknown as HlWindow;
    expect(same.CSS.highlights.get("tabverse-find")?.ranges.length).toBe(1);
    expect(nested.CSS.highlights.get("tabverse-find")?.ranges.length).toBe(3);
    // The 4th flattened match (indices 0-2 are the top document's) is the
    // same-origin child's only match: the current highlight lives there,
    // and the top document's is gone rather than stale.
    expect(top.CSS.highlights.get("tabverse-find-current")).toBeUndefined();
    expect(
      same.CSS.highlights.get("tabverse-find-current")?.ranges.length
    ).toBe(1);
    expect(
      nested.CSS.highlights.get("tabverse-find-current")
    ).toBeUndefined();
  });

  it("drops a stale child-frame registration when a new query empties it", () => {
    const fx = page();
    stubClientRects();
    polyfillHighlights(window);
    polyfillHighlights(fx.same.contentWindow as Window);
    polyfillHighlights(fx.nested.contentWindow as Window);
    run("alpha");
    const same = fx.same.contentWindow as unknown as HlWindow;
    expect(same.CSS.highlights.get("tabverse-find")?.ranges.length).toBe(1);
    run("zeta");
    // "zeta" matches nothing in the same-origin child: its registration
    // from the previous query is deleted, not merely outnumbered.
    expect(same.CSS.highlights.has("tabverse-find")).toBe(false);
    expect(same.CSS.highlights.has("tabverse-find-current")).toBe(false);
  });

  it("says its scope in words that do not promise cross-origin frames", () => {
    // The honest boundary the bar annotates: plain, unparameterized copy —
    // a promise about same-origin embeds only, never "all frames".
    expect(typeof STR.browser.findScopeNote).toBe("string");
    expect(STR.browser.findScopeNote).toContain("same-origin");
    expect(STR.browser.findScopeNote.toLowerCase()).not.toContain("all frames");
  });
});
