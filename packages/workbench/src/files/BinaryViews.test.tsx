import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontView, type FontViewRuntime } from "./FontView";
import { HexView, type HexViewRuntime } from "./HexView";
import { LogView, type LogViewRuntime } from "./LogView";
import { SqliteView, type SqliteViewRuntime } from "./SqliteView";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalFontFace = globalThis.FontFace;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else delete (document as unknown as Record<string, unknown>).fonts;
  Object.defineProperty(globalThis, "FontFace", {
    configurable: true,
    writable: true,
    value: originalFontFace,
  });
});

async function renderView(node: ReactNode) {
  await act(async () => {
    root?.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("shared binary viewers", () => {
  it("renders a bounded hex page from the injected range port", async () => {
    const runtime: HexViewRuntime = {
      readRange: vi.fn(async () => ({ b64: "page", total: 3 })),
      decodeBase64: () => Uint8Array.from([0x41, 0x00, 0x42]),
      reveal: vi.fn(async () => {}),
    };
    await renderView(
      <HexView meta={{ path: "/data.bin", name: "data.bin", size: 3 }} runtime={runtime} />
    );

    expect(runtime.readRange).toHaveBeenCalledWith("/data.bin", 0, 4096);
    expect(host?.querySelector(".hex-ascii")?.textContent).toBe("A·B");
    expect(host?.querySelector(".hex-off")?.textContent).toBe("00000000");
  });

  it("loads the current log tail without owning a filesystem", async () => {
    const bytes = new TextEncoder().encode("first\nlast\n");
    const runtime: LogViewRuntime = {
      readRange: vi
        .fn()
        .mockResolvedValueOnce({ b64: "", total: bytes.length })
        .mockResolvedValueOnce({ b64: "tail", total: bytes.length }),
      decodeBase64: () => bytes,
    };
    await renderView(
      <LogView meta={{ path: "/app.log", name: "app.log" }} runtime={runtime} />
    );

    expect(runtime.readRange).toHaveBeenNthCalledWith(1, "/app.log", 0, 1);
    expect(host?.querySelector(".log-text")?.textContent).toBe("first\nlast\n");
    expect(host?.querySelector(".log-range")?.textContent).toContain(
      bytes.length.toString()
    );
  });

  it("lists SQLite tables and pages through read-only ports", async () => {
    const runtime: SqliteViewRuntime = {
      inspect: vi.fn(async () => ({
        type: "sqlite",
        tables: [{ name: "users", rows: 1, columns: ["id", "name"] }],
      })),
      rows: vi.fn(async () => ({
        columns: ["id", "name"],
        rows: [["1", "Ada"]],
        total: 1,
      })),
      reveal: vi.fn(async () => {}),
      formatSize: () => "8 KB",
    };
    await renderView(
      <SqliteView
        meta={{ path: "/app.db", name: "app.db", size: 8000, mime: "application/vnd.sqlite3" }}
        runtime={runtime}
      />
    );

    expect(runtime.inspect).toHaveBeenCalledWith("/app.db");
    expect(runtime.rows).toHaveBeenCalledWith("/app.db", "users", 100, 0);
    expect(host?.querySelector(".sqlite-table-name")?.textContent).toBe("users");
    expect(host?.querySelector(".sqlite-table tbody")?.textContent).toContain("Ada");
  });

  it("renders a font specimen through URL and metadata ports", async () => {
    class MockFontFace {
      status = "loaded";
      constructor(
        readonly family: string,
        readonly source: string
      ) {}
    }
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      writable: true,
      value: MockFontFace,
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: vi.fn(),
        delete: vi.fn(),
        load: vi.fn(async () => []),
      },
    });
    const runtime: FontViewRuntime = {
      url: (path) => `https://files.test${path}`,
      inspectFont: vi.fn(async () => ({
        family: "Specimen",
        style: "Regular",
        glyphCount: 512,
        variable: false,
      })),
      reveal: vi.fn(async () => {}),
      formatSize: () => "12 KB",
    };
    await renderView(
      <FontView
        meta={{ path: "/font.woff2", name: "font.woff2", size: 12_000, mime: "font/woff2" }}
        runtime={runtime}
      />
    );

    expect(runtime.inspectFont).toHaveBeenCalledWith("/font.woff2");
    expect(host?.querySelector(".font-meta-family")?.textContent).toBe("Specimen");
    expect(host?.querySelector(".font-line")?.textContent).toContain("quick brown fox");
  });
});
