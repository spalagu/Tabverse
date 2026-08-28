import { describe, expect, it } from "vitest";


// Every Rust source file, so a NEW injected script in a NEW module is
// covered the day it is written, not the day someone remembers this test.
const sources = import.meta.glob("../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * A delivery point: `webkit.messageHandlers` with a `postMessage` call
 * close behind it. Prose mentions of the handler name (doc comments, the
 * PAGE_CHANNEL constant's docs) have no call attached and do not match.
 */
const DELIVERY = /webkit\.messageHandlers[\s\S]{0,120}?postMessage/g;

/**
 * How far behind the WebKit post the fallback may trail. The dual-channel
 * idiom is try-webkit / catch / try-chrome, which fits well inside this;
 * a "fallback" further away than this is not part of the same report.
 */
const FALLBACK_WINDOW = 400;

/**
 * Delivery points allowed to stay single-channel, each with the reason on
 * record. Empty on purpose: today no report has a platform excuse, and a
 * new one gets admitted here consciously or not at all.
 */
const SINGLE_CHANNEL_OK: { file: string; reason: string; nearby: string }[] = [];

describe("injected page reports reach both engines", () => {
  it("found the Rust sources at all", () => {
    // A glob that silently matches nothing would pass every assertion
    // below; the scan must fail loudly if the layout moves.
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("has a webkit delivery point to check (the scan itself works)", () => {
    const total = Object.values(sources)
      .map((src) => [...src.matchAll(DELIVERY)].length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("pairs every webkit.messageHandlers post with a chrome.webview fallback", () => {
    const naked: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(DELIVERY)) {
        const at = m.index ?? 0;
        const tail = src.slice(at, at + m[0].length + FALLBACK_WINDOW);
        if (tail.includes("chrome.webview")) continue;
        const excused = SINGLE_CHANNEL_OK.some(
          (ok) => file.includes(ok.file) && tail.includes(ok.nearby)
        );
        if (excused) continue;
        const line = src.slice(0, at).split("\n").length;
        naked.push(`${file}:${line}`);
      }
    }
    expect(
      naked,
      "webkit-only page reports (silent on Windows) — post through both channels or whitelist with a reason"
    ).toEqual([]);
  });
});
