/**
 * The files pane's observable contract: the host's open file arrives over
 * fs_read and renders as text; a non-text or refused file says so instead
 * of pretending; editing is Steer-gated and Save rides fs_write with the
 * pane's working copy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilesPane } from "@tabverse/workbench/files-pane";
import type { HostRpc } from "@tabverse/workbench/host-rpc";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(path: string | null, rpc: HostRpc, readOnly = false) {
  act(() => {
    root.render(
      <FilesPane path={path} dir={null} rpc={rpc} readOnly={readOnly} />,
    );
  });
}

const flush = () => act(async () => {});

const textMeta = (over: Partial<{ text: string | null; truncated: boolean; read_only_reason: string | null }> = {}) => ({
  name: "notes.txt",
  size: 12,
  text: "hello host",
  truncated: false,
  read_only_reason: null,
  ...over,
});

describe("FilesPane", () => {
  it("reads the host's open file over fs_read and renders its text", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const rpc: HostRpc = async (cmd, args) => {
      calls.push({ cmd, args });
      return textMeta();
    };
    mount("/tmp/notes.txt", rpc);
    await flush();
    expect(calls).toEqual([{ cmd: "fs_read", args: { path: "/tmp/notes.txt" } }]);
    const area = host.querySelector<HTMLTextAreaElement>(".files-pane-text");
    expect(area).not.toBeNull();
    expect(area!.value).toBe("hello host");
    expect(host.querySelector(".files-pane-name")!.textContent).toBe("notes.txt");
  });

  it("a path with no file behind it says so — the honest idle, not a blank", async () => {
    mount(null, async () => {
      throw new Error("should not read");
    });
    await flush();
    expect(host.textContent).toContain("no file open");
  });

  it("no file + a directory lists the folder over fs_list instead of the idle line", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const rpc: HostRpc = async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        dir: "/Users/x/proj",
        parent: "/Users/x",
        entries: [
          { name: "src", isDir: true },
          { name: "package.json", isDir: false },
        ],
      };
    };
    act(() => {
      root.render(<FilesPane path={null} dir="/Users/x/proj" rpc={rpc} readOnly />);
    });
    await flush();
    expect(calls).toEqual([{ cmd: "fs_list", args: { dir: "/Users/x/proj" } }]);
    const rows = [...host.querySelectorAll(".files-pane-entry")];
    expect(rows.map((r) => r.textContent)).toEqual(["▸ src", "package.json"]);
    expect(host.textContent).not.toContain("no file open");
  });

  it("a read that fails surfaces the error line", async () => {
    mount("/gone.txt", async () => {
      throw new Error("no such file");
    });
    await flush();
    expect(host.textContent).toContain("no such file");
  });

  it("a non-text file names its size instead of an empty editor", async () => {
    mount("/img.png", async () => textMeta({ text: null }));
    await flush();
    expect(host.querySelector(".files-pane-text")).toBeNull();
    expect(host.textContent).toContain("not a text file");
  });

  it("a read-only refusal shows its reason and no editor", async () => {
    mount(
      "/lossy.bin",
      async () => textMeta({ text: "x", read_only_reason: "lossy decode" }),
    );
    await flush();
    expect(host.querySelector(".files-pane-text")).toBeNull();
    expect(host.textContent).toContain("lossy decode");
  });

  it("Steer edits save back through fs_write; view level never offers Save", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const rpc: HostRpc = async (cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "fs_read" ? textMeta() : null;
    };
    mount("/tmp/a.txt", rpc, false);
    await flush();
    const area = host.querySelector<HTMLTextAreaElement>(".files-pane-text")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(area, "edited");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = host.querySelector<HTMLButtonElement>(".files-pane-save")!;
    expect(save.textContent).toBe("Save");
    act(() => save.click());
    await flush();
    expect(calls).toContainEqual({
      cmd: "fs_write",
      args: { path: "/tmp/a.txt", content: "edited" },
    });
    expect(host.querySelector(".files-pane-save")!.textContent).toBe("Saved");

    // View level: same file, no editor writes, no Save at all.
    mount("/tmp/a.txt", rpc, true);
    await flush();
    expect(host.querySelector(".files-pane-save")).toBeNull();
    expect(
      host.querySelector<HTMLTextAreaElement>(".files-pane-text")!.readOnly,
    ).toBe(true);
  });
});
