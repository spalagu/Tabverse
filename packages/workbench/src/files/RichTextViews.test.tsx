import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absolutize } from "./HtmlView";
import { MarkdownView } from "./MarkdownView";
import { NotebookView } from "./NotebookView";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

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
});

describe("shared rich text viewers", () => {
  it("routes local markdown images through the injected URL port", async () => {
    const urlForPath = vi.fn((path: string) => `https://files.test${path}`);
    await act(async () => {
      root?.render(
        <MarkdownView
          path="/docs/readme.md"
          text={'![diagram](assets/a.png) [local](guide.md)'}
          urlForPath={urlForPath}
        />
      );
    });

    expect(urlForPath).toHaveBeenCalledWith("/docs/assets/a.png");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    host?.querySelector("a")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("renders normalized notebook metadata and rich output", async () => {
    const text = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 7,
          source: ["print('ready')"],
          outputs: [
            {
              output_type: "display_data",
              data: { "text/html": "<b>ready</b><script>bad()</script>" },
            },
          ],
        },
      ],
      metadata: { language_info: { name: "python" } },
    });
    await act(async () => root?.render(<NotebookView text={text} />));

    expect(host?.querySelector(".nb-badge")?.textContent).toContain("7");
    expect(host?.querySelector(".nb-lang")?.textContent).toBe("python");
    expect(host?.querySelector(".nb-html")?.textContent).toContain("ready");
  });

  it("keeps HTML fragments local while resolving relative assets", () => {
    const output = absolutize(
      '<img src="image.png"><a href="#part">Part</a>',
      "https://files.test/docs/"
    );
    expect(output).toContain('src="https://files.test/docs/image.png"');
    expect(output).toContain('href="#part"');
  });
});
