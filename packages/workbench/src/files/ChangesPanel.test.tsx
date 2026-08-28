import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesPanel, type FileChangeList } from "./ChangesPanel";

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

async function renderChanges(
  list: FileChangeList,
  onOpen = vi.fn()
): Promise<typeof onOpen> {
  await act(async () => {
    root?.render(
      <ChangesPanel
        root="/repo"
        refreshToken={0}
        selected="/repo/src/main.ts"
        loadChanges={async () => list}
        onOpen={onOpen}
      />
    );
    await Promise.resolve();
  });
  return onOpen;
}

describe("changes panel", () => {
  it("groups changes in action order and opens only existing files", async () => {
    const onOpen = await renderChanges({
      repo: "/repo",
      files: [
        { rel: "new.ts", path: "/repo/new.ts", status: "untracked" },
        { rel: "old.ts", path: "/repo/old.ts", status: "deleted" },
        { rel: "src/main.ts", path: "/repo/src/main.ts", status: "modified" },
        { rel: "conflict.ts", path: "/repo/conflict.ts", status: "conflicted" },
      ],
    });
    expect(
      Array.from(host!.querySelectorAll(".change-group-title")).map(
        (element) => element.textContent
      )
    ).toEqual(["Conflicted", "Deleted", "Modified", "Untracked"]);
    expect(host!.querySelector(".change-row.active")?.textContent).toContain(
      "src/main.ts"
    );
    const rows = Array.from(host!.querySelectorAll<HTMLElement>(".change-row"));
    await act(async () => {
      rows.find((row) => row.textContent?.includes("src/main.ts"))?.click();
      rows.find((row) => row.textContent?.includes("old.ts"))?.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("/repo/src/main.ts");
  });

  it("distinguishes a non-repository from a clean repository", async () => {
    await renderChanges({ repo: null, files: [] });
    expect(host!.querySelector(".changes-empty")?.textContent).toBe(
      "This directory is not inside a version-controlled repository."
    );
    await act(async () => {
      root?.render(
        <ChangesPanel
          root="/repo"
          refreshToken={1}
          selected={null}
          loadChanges={async () => ({ repo: "/repo", files: [] })}
          onOpen={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(host!.querySelector(".changes-empty")?.textContent).toBe(
      "Nothing has changed here."
    );
  });
});
