import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Preview,
  type FilePreviewMeta,
  type FilePreviewRenderers,
  type FilePreviewRuntime,
} from "./Preview";
import { PreviewFind } from "./PreviewFind";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  Element.prototype.scrollIntoView = vi.fn();
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

const meta = (over: Partial<FilePreviewMeta> = {}): FilePreviewMeta => ({
  path: "/repo/file.bin",
  name: "file.bin",
  size: 1200,
  kind: "binary",
  mime: "application/octet-stream",
  ...over,
});

const renderer = (name: string) => () => (
  <div data-renderer={name}>{name}</div>
);

const renderers: FilePreviewRenderers<FilePreviewMeta> = {
  InspectView: renderer("inspect"),
  SqliteView: renderer("sqlite"),
  FontView: renderer("font"),
  HexView: renderer("hex"),
};

const runtime: FilePreviewRuntime = {
  url: (path) => `tabverse://file${path}`,
  inspectImage: async () => ({ width: 640, height: 480 }),
  reveal: async () => {},
  formatSize: () => "1.2 KB",
};

async function renderPreview(file: FilePreviewMeta) {
  await act(async () => {
    root?.render(<Preview meta={file} runtime={runtime} renderers={renderers} />);
    await Promise.resolve();
  });
}

describe("file preview routing", () => {
  it("routes structured binary formats and keeps hex as the fallback", async () => {
    await renderPreview(meta({ mime: "application/vnd.sqlite3" }));
    expect(host?.querySelector("[data-renderer='sqlite']")).not.toBeNull();

    await renderPreview(meta({ mime: "font/woff2" }));
    expect(host?.querySelector("[data-renderer='font']")).not.toBeNull();

    await renderPreview(meta({ name: "Info.plist" }));
    expect(host?.querySelector("[data-renderer='inspect']")).not.toBeNull();

    await renderPreview(meta());
    expect(host?.querySelector("[data-renderer='hex']")).not.toBeNull();
  });

  it("renders an image through the runtime URL and reports inspected dimensions", async () => {
    await renderPreview(
      meta({
        path: "/repo/photo.png",
        name: "photo.png",
        kind: "image",
        mime: "image/png",
      })
    );
    expect(host?.querySelector("img")?.getAttribute("src")).toBe(
      "tabverse://file/repo/photo.png"
    );
    expect(host?.querySelector(".preview-sub")?.textContent).toContain("640 × 480");
    expect(host?.querySelector(".preview-sub")?.textContent).toContain("1.2 KB");
  });
});

describe("preview find", () => {
  it("highlights rendered text and hands the query to source search", async () => {
    const content = document.createElement("div");
    content.textContent = "Alpha beta alpha";
    document.body.appendChild(content);
    const onSearchSource = vi.fn();

    await act(async () => {
      root?.render(
        <PreviewFind
          container={content}
          isolated={false}
          onSearchSource={onSearchSource}
          onClose={() => {}}
          previousHint="↑"
          nextHint="↓"
        />
      );
    });

    const input = host?.querySelector<HTMLInputElement>(".preview-find-input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "alpha");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(content.querySelectorAll("mark.preview-find-hit")).toHaveLength(2);
    expect(host?.querySelector(".preview-find-count")?.textContent).toBe("1/2");
    const sourceButton = Array.from(host!.querySelectorAll("button")).find(
      (button) => button.textContent === "In source"
    );
    await act(async () => sourceButton?.click());
    expect(onSearchSource).toHaveBeenCalledWith("alpha");
    content.remove();
  });
});
